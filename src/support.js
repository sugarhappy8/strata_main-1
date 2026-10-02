"use strict";

const {randomBytes,randomUUID,createHash}=require("node:crypto");
const {verificationEmailHash,sendSupportAcknowledgment,sendSupportNotification,sendSupportResponse}=require("./email");
const {cleanText}=require("./plans");

const SUPPORT_REQUEST_WINDOW_MS=60*60*1000;
const SUPPORT_REQUEST_RETENTION_MS=24*60*60*1000;
const SUPPORT_REQUESTS_PER_IP=5;
const SUPPORT_REQUESTS_PER_EMAIL=4;
const SUPPORT_REQUESTS_GLOBAL=100;
const SUPPORT_CATEGORIES=new Set(["account","password","payment","privacy","exercise","other"]);
const SUPPORT_STATUSES=new Set(["new","open","waiting","resolved"]);

/**
 * Typed dependency-injection boundary for public and admin support requests.
 * @param {import("./domain-types").SupportServiceDependencies} dependencies
 * @returns {import("./domain-types").SupportService}
 */
function createSupportService({
  store,
  emailConfig,
  auth,
  admin,
  requestAddress,
  trustedAuthOrigin,
  rateAllowed,
  isUniqueViolation=()=>false,
  http,
  logger=console
}){
  if(!store||!emailConfig||!auth||!admin||typeof requestAddress!=="function"||typeof trustedAuthOrigin!=="function"||typeof rateAllowed!=="function"||!http){
    throw new TypeError("Support service requires store, email configuration, auth/admin services, request guards, and HTTP helpers.");
  }
  const {json,bodyJson,bodyForm,redirect}=http;
  const hash=(value)=>createHash("sha256").update(value).digest("hex");

  function supportTicketPayload(row){
    return {
      id:row.id,reference:row.reference,userId:row.user_id||null,name:row.name,email:row.email,category:row.category,
      subject:row.subject,customerReference:row.reference_id||"",message:row.message,status:row.status,note:row.admin_note||"",
      lastResponseAt:row.last_response_at==null?null:Number(row.last_response_at),createdAt:Number(row.created_at),updatedAt:Number(row.updated_at)
    };
  }
  function cleanSupportLine(value,max){return cleanText(value,max).replace(/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]+/g," ").replace(/\s+/g," ").trim();}
  function cleanSupportMessage(value,max){return cleanText(value,max).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g,"");}
  function luhnValid(value){
    const digits=String(value||"").replace(/[^0-9]/g,"");
    if(digits.length<13||digits.length>19||/^0+$/.test(digits))return false;
    let sum=0,double=false;
    for(let index=digits.length-1;index>=0;index-=1){let digit=Number(digits[index]);if(double){digit*=2;if(digit>9)digit-=9;}sum+=digit;double=!double;}
    return sum%10===0;
  }
  function sensitiveSupportText(...values){
    const text=values.join("\n");
    return admin.sensitiveAdminText(text)||(text.match(/\b(?:\d[ -]?){12,18}\d\b/g)||[]).some(luhnValid);
  }
  function validateSupportRequest(input,session){
    const name=cleanSupportLine(session?.name||input?.name,80),email=session?.email||auth.normalizeEmail(input?.email),category=cleanSupportLine(input?.category,30).toLowerCase();
    const subject=cleanSupportLine(input?.subject,100),referenceId=cleanSupportLine(input?.referenceId,80),message=cleanSupportMessage(input?.message,2000),website=cleanText(input?.website,200);
    if(website)return {honeypot:true};
    if(name.length<2||!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)||!SUPPORT_CATEGORIES.has(category)||subject.length<3||message.length<10){
      throw Object.assign(new Error("Add a valid name, email, category, subject, and message."),{status:400,code:"INVALID_SUPPORT_REQUEST"});
    }
    if(sensitiveSupportText(subject,referenceId,message)){
      throw Object.assign(new Error("Remove passwords, verification codes, private links, API keys, tokens, and payment-card numbers before sending."),{status:400,code:"SENSITIVE_SUPPORT_CONTENT"});
    }
    return {name,email,category,subject,referenceId,message};
  }
  function newSupportReference(now=Date.now()){return `STR-${new Date(now).getUTCFullYear()}-${randomBytes(4).toString("hex").slice(0,6).toUpperCase()}`;}

  async function createSupportRequest(req,input){
    const session=await auth.sessionFor(req),clean=validateSupportRequest(input,session);
    if(clean.honeypot)return {reference:newSupportReference(),accepted:true};
    let emailKey;
    try{emailKey=verificationEmailHash(emailConfig,clean.email);}catch{emailKey=hash(clean.email);}
    const now=Date.now();
    const reserved=await store.claimSupportRequestEvent({id:randomUUID(),ipHash:hash(`support-ip:${requestAddress(req)}`),emailHash:emailKey,createdAt:now},{since:now-SUPPORT_REQUEST_WINDOW_MS,ipLimit:SUPPORT_REQUESTS_PER_IP,emailLimit:SUPPORT_REQUESTS_PER_EMAIL,globalLimit:SUPPORT_REQUESTS_GLOBAL});
    if(!reserved)throw Object.assign(new Error("Too many support requests were sent. Please wait and try again."),{status:429,code:"SUPPORT_RATE_LIMIT"});
    let ticket;
    for(let attempt=0;attempt<3&&!ticket;attempt+=1){
      try{ticket=await store.insertSupportTicket({id:randomUUID(),reference:newSupportReference(now),userId:session?.id||null,...clean,createdAt:now,updatedAt:now});}
      catch(error){if(!isUniqueViolation(error)||attempt===2)throw error;}
    }
    if(!ticket)throw new Error("Support request could not be stored.");
    const deliveries=await Promise.allSettled([sendSupportAcknowledgment(emailConfig,ticket),sendSupportNotification(emailConfig,ticket)]);
    for(const delivery of deliveries)if(delivery.status==="rejected")logger.error(`Support email delivery failed: ${delivery.reason?.code||"provider-error"}`);
    return {reference:ticket.reference,accepted:true,emailSent:deliveries[0]?.status==="fulfilled"};
  }

  async function handleApi(req,res,url){
    if(url.pathname==="/api/support"&&req.method==="POST"){
      if(!trustedAuthOrigin(req)){json(res,403,{error:"Support security check failed. Refresh and try again.",code:"SUPPORT_ORIGIN_REQUIRED"});return true;}
      const contentType=String(req.headers["content-type"]||"").toLowerCase();
      if(contentType.startsWith("application/x-www-form-urlencoded")){
        // The contact form works without JavaScript: a plain post lands back on /contact with the outcome in the query string.
        try{const result=await createSupportRequest(req,await bodyForm(req));redirect(res,`/contact?sent=${encodeURIComponent(result.reference)}#supportStatus`);}
        catch(error){if(!error.status)throw error;redirect(res,`/contact?error=${encodeURIComponent(error.code||"SUPPORT_REQUEST_FAILED")}#supportStatus`);}
        return true;
      }
      if(!contentType.startsWith("application/json")){json(res,415,{error:"Support requests must use JSON.",code:"JSON_REQUIRED"});return true;}
      try{json(res,201,{ok:true,...await createSupportRequest(req,await bodyJson(req))});}
      catch(error){if(!error.status)throw error;json(res,error.status,{error:error.message,code:error.code||"SUPPORT_REQUEST_FAILED"});}
      return true;
    }
    if(url.pathname==="/api/admin/support"&&req.method==="GET"){
      const session=await admin.requireAdmin(req,res);if(!session)return true;
      const requestedStatus=cleanText(url.searchParams.get("status"),20),status=SUPPORT_STATUSES.has(requestedStatus)?requestedStatus:"";
      const limit=Math.max(1,Math.min(50,Math.floor(Number(url.searchParams.get("limit"))||20))),offset=Math.max(0,Math.min(10000,Math.floor(Number(url.searchParams.get("offset"))||0)));
      const result=await store.adminSupportTickets(status,limit,offset);
      json(res,200,{tickets:result.tickets.map(supportTicketPayload),total:result.total,limit,offset,status});return true;
    }
    const supportMatch=url.pathname.match(/^\/api\/admin\/support\/([^/]+)$/);
    if(supportMatch&&req.method==="POST"){
      const session=await admin.requireAdmin(req,res);if(!session)return true;
      if(!admin.requireAdminMutation(req,res,session))return true;
      if(!await rateAllowed(req,`admin-support:${session.id}`,30,15*60*1000)){json(res,429,{error:"Too many support updates. Wait and try again.",code:"ADMIN_RATE_LIMIT"});return true;}
      const ticketId=admin.cleanAdminTarget(supportMatch[1]),ticket=ticketId?await store.supportTicketById(ticketId):null;
      if(!ticket){json(res,404,{error:"Support request not found.",code:"SUPPORT_NOT_FOUND"});return true;}
      const input=await bodyJson(req),candidateStatus=cleanText(input?.status,20),status=SUPPORT_STATUSES.has(candidateStatus)?candidateStatus:ticket.status;
      const note=cleanSupportMessage(input?.note,1000),response=cleanSupportMessage(input?.response,2000),expectedUpdatedAt=Number(input?.expectedUpdatedAt);
      if(admin.sensitiveAdminText(note)||admin.sensitiveAdminText(response)){json(res,400,{error:"Do not put passwords, codes, API keys, tokens, or private action links in support notes or responses.",code:"SENSITIVE_SUPPORT_CONTENT"});return true;}
      if(!Number.isSafeInteger(expectedUpdatedAt)||expectedUpdatedAt<=0){json(res,400,{error:"Refresh the help request before updating it.",code:"SUPPORT_VERSION_REQUIRED"});return true;}
      if(expectedUpdatedAt!==Number(ticket.updated_at)){json(res,409,{error:"The support request changed in another tab. Refresh and try again.",code:"SUPPORT_STATE_CHANGED"});return true;}
      if(!note&&!response&&status===ticket.status){json(res,400,{error:"Change the status, add a private note, or write a response.",code:"EMPTY_SUPPORT_UPDATE"});return true;}
      const updatedAt=Math.max(Date.now(),expectedUpdatedAt+1);
      let updated=await store.updateSupportTicket(ticket.id,{status,note,responseSent:false,updatedAt,expectedUpdatedAt},admin.adminAuditEvent(session.id,ticket.user_id||null,"support-updated",note||`Support request ${status}`,response?"response-pending":"success"));
      if(!updated){json(res,409,{error:"The support request changed. Refresh and try again.",code:"SUPPORT_STATE_CHANGED"});return true;}
      if(response.length>0){
        try{await sendSupportResponse(emailConfig,updated,response);}
        catch{json(res,502,{error:"The help-request workflow was saved, but the email response was not sent. Open the request and try the response again.",code:"SUPPORT_RESPONSE_DELIVERY_FAILED",ticket:supportTicketPayload(updated)});return true;}
        updated=await store.markSupportResponseSent(ticket.id,Date.now())||updated;
        await admin.recordAdminAudit(session.id,ticket.user_id||null,"support-response-sent","Response delivered through the configured support email");
      }
      json(res,200,{ok:true,ticket:supportTicketPayload(updated),message:response?"Response sent and support request updated.":"Support request updated."});return true;
    }
    return false;
  }

  async function cleanup(now=Date.now()){await store.deleteOldSupportRequestEvents(now-SUPPORT_REQUEST_RETENTION_MS);}
  return Object.freeze({handleApi,cleanup,supportTicketPayload});
}

module.exports={createSupportService};
