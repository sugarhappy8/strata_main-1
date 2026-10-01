"use strict";

const test=require("node:test");
const assert=require("node:assert/strict");
const fs=require("node:fs");
const logic=require("../public/scripts/account-logic");
const stateModule=require("../public/scripts/account-state");
const apiModule=require("../public/scripts/account-api");
const events=require("../public/scripts/account-events");

test("account pure logic constrains redirects and derives access state",()=>{
  assert.equal(logic.safeNext("https://evil.example/steal"),"/planner.html");
  assert.equal(logic.safeNext("planner","flat-dumbbell-press"),"/planner.html?add=flat-dumbbell-press");
  assert.equal(logic.verificationLocation("/workout.html?day=Monday",{purpose:"login"}),"/verify-email.html?next=%2Fworkout.html%3Fday%3DMonday&purpose=login");
  assert.deepEqual(logic.accountAccessSummary({discovery:{active:false,accessType:null}},false),{
    state:"Free",detail:"Rankings and Plan included",message:"The exercise index and weekly planner are free. Strata+ is available as a $2.99 USD monthly subscription."
  });
  assert.equal(logic.safePortalUrl("https://customer-portal.paddle.com/cpl_123"),"https://customer-portal.paddle.com/cpl_123");
  assert.equal(logic.safePortalUrl("https://customer-portal.paddle.com.evil.test/cpl_123"),"");
});

test("account pure logic explains every grant, subscription, and legacy access state",()=>{
  const now=Date.parse("2026-09-10T12:00:00Z"),future=now+2*24*60*60*1000;
  const discovery=(value)=>({discovery:value});
  assert.equal(logic.accountAccessSummary(discovery({active:true,adminGrant:{active:true,expiresAt:null}})).detail,"Until revoked");
  assert.match(logic.accountAccessSummary(discovery({active:true,adminGrant:{active:true,expiresAt:future},subscription:{id:"sub_1"}})).message,/subscription remains separate/);
  assert.match(logic.accountAccessSummary(discovery({active:true,accessType:"paid",adminGrant:{active:true,expiresAt:future}})).message,/lifetime access remains separate/);

  const subscribed=(subscription)=>discovery({active:subscription.active===true,accessType:"subscription",subscription:{id:"sub_1",...subscription}});
  assert.equal(logic.accountAccessSummary(subscribed({status:"paused",active:false})).state,"Paused");
  assert.equal(logic.accountAccessSummary(subscribed({status:"canceled",active:false})).state,"Canceled");
  assert.equal(logic.accountAccessSummary(subscribed({status:"active",active:false})).state,"Inactive");
  assert.equal(logic.accountAccessSummary(subscribed({status:"active",active:true,scheduledChange:{action:"cancel",effectiveAt:future}})).state,"Canceling");
  assert.equal(logic.accountAccessSummary(subscribed({status:"active",active:true,scheduledChange:{action:"pause",effectiveAt:future}})).state,"Pausing");
  assert.equal(logic.accountAccessSummary(subscribed({status:"past_due",active:true,pastDue:true})).state,"Past due");
  assert.equal(logic.accountAccessSummary(subscribed({status:"active",active:true,currentPeriodEndsAt:future})).state,"Active");
  assert.equal(logic.accountAccessSummary(discovery({active:true,accessType:"paid"})).state,"Lifetime");
  assert.equal(logic.accountAccessSummary(discovery({active:false}),true).state,"Pending");
});

test("account pure logic explains App Store subscriptions and keeps Paddle read-only inside the app",()=>{
  const expiresAt=Date.parse("2026-11-01T12:00:00Z"),apple=(value,extra={})=>({discovery:{active:value.active===true,accessType:value.active?"apple":null,apple:{productId:"online.stratafitness.app.plus.monthly",expiresAt,autoRenew:true,inGracePeriod:false,revoked:false,environment:"Production",...value},...extra}});
  assert.equal(logic.appleSubscriptionFor({discovery:{apple:null}}),null);
  assert.equal(logic.safeAppleManageUrl("https://apps.apple.com/account/subscriptions"),"https://apps.apple.com/account/subscriptions");
  for(const unsafe of ["javascript:alert(1)","http://apps.apple.com/account/subscriptions","https://apps.apple.com.evil.test/","https://user:pass@apps.apple.com/","",null])assert.equal(logic.safeAppleManageUrl(unsafe),logic.APPLE_MANAGE_URL,String(unsafe));
  assert.deepEqual(logic.appleDeletionNotice({appleBilling:{message:" Apple keeps billing. ",manageUrl:"javascript:alert(1)"}}),{message:"Apple keeps billing.",manageUrl:"https://apps.apple.com/account/subscriptions"});
  for(const result of [{},{appleBilling:null},{appleBilling:{message:""}},{appleBilling:{message:42}},null])assert.equal(logic.appleDeletionNotice(result),null);
  assert.deepEqual(logic.accountAccessSummary(apple({active:true})),{state:"Active",detail:"App Store · renews Nov 1, 2026",message:"Your Strata+ subscription is billed to your Apple Account and renews on Nov 1, 2026. Manage or cancel it in Settings › Apple Account › Subscriptions on your iPhone."});
  assert.doesNotMatch(logic.accountAccessSummary(apple({active:true}),false,{app:true}).message,/on your iPhone/);
  assert.equal(logic.accountAccessSummary(apple({active:true,inGracePeriod:true})).state,"Billing issue");
  assert.equal(logic.accountAccessSummary(apple({active:true,autoRenew:false})).detail,"Access through Nov 1, 2026");
  assert.equal(logic.accountAccessSummary(apple({active:true,expiresAt:null})).detail,"App Store subscription");
  assert.equal(logic.accountAccessSummary(apple({active:false,revoked:true})).detail,"Refunded or revoked");
  assert.equal(logic.accountAccessSummary(apple({active:false})).state,"Ended");
  assert.match(logic.accountAccessSummary(apple({active:true},{adminGrant:{active:true,expiresAt:null}})).message,/App Store subscription remains separate/);
  // A Paddle subscription that pays for Strata+ wins; a lapsed one does not hide an active App Store subscription.
  assert.equal(logic.accountAccessSummary(apple({active:true},{subscription:{id:"sub_1",status:"active",active:true,currentPeriodEndsAt:expiresAt}})).detail,"Monthly · renews Nov 1, 2026");
  assert.equal(logic.accountAccessSummary(apple({active:true},{subscription:{id:"sub_1",status:"canceled",active:false}})).detail,"App Store · renews Nov 1, 2026");
  const paddle=(subscription)=>({discovery:{active:subscription.active===true,accessType:"paid",subscription:{id:"sub_1",...subscription}}});
  for(const subscription of [{status:"paused",active:false},{status:"active",active:false},{status:"past_due",active:true,pastDue:true},{status:"unknown",active:"maybe"}]){
    const web=logic.accountAccessSummary(paddle(subscription)),app=logic.accountAccessSummary(paddle(subscription),false,{app:true});
    assert.match(web.message,/Paddle/,subscription.status);assert.doesNotMatch(app.message,/Paddle/,subscription.status);assert.match(app.message,/stratafitness\.online/,subscription.status);
  }
  assert.equal(logic.accountAccessSummary({discovery:{active:false}},true,{app:true}).detail,"Started on the website");
  assert.doesNotMatch(logic.accountAccessSummary({discovery:{active:false}},false,{app:true}).message,/\$|USD/);
});

test("account pure logic covers safe handoffs, useful errors, plan timing, and comparable records",()=>{
  for(const [input,expected] of [["pricing","/pricing"],["discover","/discover.html"],["admin","/admin"],["workout","/workout.html"],["onboarding","/onboarding.html"]]){
    assert.equal(logic.safeNext(input),expected);
  }
  assert.equal(logic.safeNext("/workout.html?day=Friday"),"/workout.html?day=Friday");
  assert.match(logic.verificationLocation("/pricing",{deliveryState:"failed"}),/next=pricing.*delivery=failed/);
  assert.match(logic.verificationLocation("/discover.html"),/next=discover/);
  assert.match(logic.verificationLocation("/admin"),/next=admin/);
  assert.match(logic.verificationLocation("/onboarding.html"),/next=onboarding/);
  assert.match(logic.verificationLocation("/planner.html?add=bench-press"),/next=planner.*add=bench-press/);
  assert.equal(logic.safeQueryError(""),"");
  assert.equal(logic.safeQueryError("untrusted"),"Unable to complete the account request. Please try again.");
  assert.match(logic.friendlyAuthError({code:"EMAIL_DELIVERY_FAILED"},"signup"),/verification email/);
  assert.match(logic.friendlyAuthError({status:404},"login"),/Node Web Service/);
  assert.match(logic.friendlyAuthError({code:"network"},"login"),/Check your connection/);
  assert.match(logic.friendlyAuthError({status:503},"signup"),/temporarily unavailable/);
  assert.match(logic.friendlyAuthError({},"signup"),/Could not create/);

  assert.equal(logic.safePortalUrl("not a url"),"");
  assert.equal(logic.accountBoundaryChanged({status:401}),true);assert.equal(logic.accountBoundaryChanged({status:403}),true);assert.equal(logic.accountBoundaryChanged({code:"account-changed"}),true);
  assert.match(logic.securityError({status:409,message:"Pending"}),/Pending/);
  assert.match(logic.selfServiceError({status:429},"session"),/Too many session/);
  assert.match(logic.billingError({code:"SUBSCRIPTION_NOT_FOUND"}),/No monthly subscription/);
});

test("account state invalidates stale private requests and clears CSRF",()=>{
  const state=stateModule.createState({pendingQueryError:"Try again."});
  const identity=state.beginIdentity();state.setPrivateUser("member-one");const sessions=state.beginSessionList(),operation=state.beginPrivateOperation();
  state.setCsrfToken("csrf-one");
  assert.equal(state.isCurrentIdentity(identity),true);assert.equal(state.isCurrentSessionList(sessions),true);
  assert.equal(state.isCurrentPrivateOperation(operation),true);
  state.invalidatePrivateRequests();
  assert.equal(state.isCurrentIdentity(identity),false);assert.equal(state.isCurrentSessionList(sessions),false);assert.equal(state.getCsrfToken(),"");
  assert.equal(state.isCurrentPrivateOperation(operation),false);assert.equal(state.isCurrentPrivateOperation(state.beginPrivateOperation()),false);
  assert.equal(state.takePendingError(),"Try again.");assert.equal(state.takePendingError(),"");
});

test("account API owns endpoint details and attaches current CSRF",async()=>{
  const calls=[];
  const client=apiModule.createClient({
    getCsrfToken:()=>"csrf-current",
    fetchImpl:async(path,options)=>{calls.push({path,options});return{ok:true,status:200,headers:{get:()=>"application/json"},json:async()=>({ok:true,sessions:[]})};}
  });
  await client.revokeSession("session-2");await client.requestDeletion();
  assert.deepEqual(calls.map(({path})=>path),["/api/account/sessions/revoke","/api/account/delete/request"]);
  assert.equal(calls[0].options.headers["X-CSRF-Token"],"csrf-current");
  assert.equal(calls[0].options.body,JSON.stringify({sessionId:"session-2"}));
  assert.equal(calls[1].options.body,"{}");
  await client.deleteNow({password:"secret-password",confirmation:"DELETE",extra:"dropped"},"member-7");
  assert.equal(calls[2].path,"/api/account/delete/now");
  assert.equal(calls[2].options.method,"POST");
  assert.equal(calls[2].options.headers["X-CSRF-Token"],"csrf-current");
  assert.equal(calls[2].options.headers["X-Strata-User"],"member-7","the request is pinned to the account on screen");
  assert.equal(calls[2].options.body,JSON.stringify({password:"secret-password",confirmation:"DELETE"}));
});

test("in-app deletion logic names Apple billing and turns every refusal into a short inline message",()=>{
  assert.equal(logic.appleMayBill({discovery:{accessType:"apple",apple:null}}),true);
  assert.equal(logic.appleMayBill({discovery:{accessType:"grant",apple:{active:true}}}),true);
  assert.equal(logic.appleMayBill({discovery:{accessType:null,apple:{active:false,autoRenew:true}}}),true,"a lapsed subscription set to renew can still bill");
  assert.equal(logic.appleMayBill({discovery:{accessType:"paid",apple:{active:false,autoRenew:false}}}),false);
  assert.equal(logic.appleMayBill(null),false);
  const cases=[
    [{code:"network"},/^Could not reach STRATA\..*Nothing was deleted\.$/],
    [{status:401,code:"PASSWORD_INCORRECT",message:"ignored"},/^That password is incorrect\.$/],
    [{status:400,code:"DELETE_CONFIRMATION_REQUIRED"},/^Type DELETE exactly to confirm\.$/],
    [{status:429,code:"ACCOUNT_DELETE_RATE_LIMIT"},/^Too many deletion attempts\. Wait 15 minutes/],
    [{status:409,code:"ADMIN_ACCOUNT_PROTECTED",message:"The primary administrator account cannot be deleted while it owns site management."},/^The primary administrator account cannot be deleted/],
    [{status:401},/^Your session expired\./],
    [{status:403,code:"INVALID_CSRF"},/^The security check expired\./],
    [{status:503,message:"database detail"},/^STRATA is temporarily unavailable\. Nothing was deleted/],
    [{},/^Your account could not be deleted\. Please try again\.$/]
  ];
  for(const [error,expected] of cases)assert.match(logic.deleteNowError(error),expected,JSON.stringify(error));
});

test("account event module binds controls without owning business logic",async()=>{
  class Node{
    constructor(){this.listeners={};this.attributes={};this.textContent="";this.type="password";}
    addEventListener(type,handler){this.listeners[type]=handler;}
    getAttribute(name){return this.attributes[name]??null;}
    setAttribute(name,value){this.attributes[name]=String(value);}
  }
  const input=new Node(),button=new Node();
  events.setupPasswordToggle({input,button,description:"account password"});
  button.listeners.click();
  assert.equal(input.type,"text");assert.equal(button.textContent,"Hide");assert.equal(button.getAttribute("aria-label"),"Hide account password");
});

test("account page loads modules in dependency order before its coordinator",()=>{
  const html=fs.readFileSync(require.resolve("../public/pages/account.html"),"utf8");
  const expected=["devices-core.js","account-logic.js","account-state.js","account-api.js","account-render.js","account-events.js","account-devices.js","account-delete-dialog.js","account.js"];
  const positions=expected.map((asset)=>html.indexOf(`src="${asset}`));
  assert.ok(positions.every((position)=>position>=0));
  assert.deepEqual(positions,positions.slice().sort((a,b)=>a-b));
});
