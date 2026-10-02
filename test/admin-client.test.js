"use strict";

const test=require("node:test");
const assert=require("node:assert/strict");
const vm=require("node:vm");
const {readFileSync}=require("node:fs");
const {join}=require("node:path");

const PROJECT_ROOT=join(__dirname,"..");
const readPublic=(path)=>readFileSync(join(PROJECT_ROOT,"public",path),"utf8");
const ADMIN_MODULES=["admin-state.js","admin-logic.js","admin-api.js","admin-render.js","admin-session.js","admin-events.js","admin.js"];
const sourceFor=(name)=>readPublic(`scripts/${name}`);
const allAdminSource=()=>ADMIN_MODULES.map(sourceFor).join("\n");

function deferred(){let resolve;const promise=new Promise((done)=>{resolve=done;});return{promise,resolve};}
async function settle(){for(let count=0;count<5;count+=1)await new Promise(setImmediate);}

class RuntimeClassList{
  constructor(){this.values=new Set();}
  add(...names){for(const name of names)this.values.add(name);}
  remove(...names){for(const name of names)this.values.delete(name);}
  toggle(name,force){if(force===undefined)force=!this.values.has(name);if(force)this.values.add(name);else this.values.delete(name);return force;}
  contains(name){return this.values.has(name);}
}

class RuntimeElement{
  constructor(id){this.id=id;this.value="";this.textContent="";this.hidden=false;this.disabled=false;this.required=false;this.open=false;this.dataset={};this.attributes={};this.children=[];this.classList=new RuntimeClassList();}
  addEventListener(){}
  append(...children){this.children.push(...children);}
  close(){this.open=false;}
  closest(){return this.parent||(this.parent=new RuntimeElement(`${this.id}-parent`));}
  focus(){this.focused=true;}
  replaceChildren(...children){this.children=children;}
  setAttribute(name,value){this.attributes[name]=String(value);}
  showModal(){this.open=true;}
}

function createAdminRuntime(initialRoutes={}){
  const ids=[...readPublic("pages/admin.html").matchAll(/\bid="([^"]+)"/g)].map((match)=>match[1]);
  const elements=new Map(ids.map((id)=>[id,new RuntimeElement(id)])),body=new RuntimeElement("body"),trace=[],calls=[],routes={...initialRoutes};
  const el=(id)=>{if(!elements.has(id))elements.set(id,new RuntimeElement(id));return elements.get(id);};
  const document={
    body,hidden:false,getElementById:el,contains:()=>true,
    createElement:(tag)=>new RuntimeElement(tag),createDocumentFragment:()=>new RuntimeElement("fragment"),
    querySelector:(selector)=>selector==="dialog[open]"?[...elements.values()].find((node)=>node.open)||null:null,
    querySelectorAll:(selector)=>selector==="dialog[open]"?[...elements.values()].filter((node)=>node.open):[]
  };
  const admin={id:"admin-one",name:"Admin One",email:"admin-one@example.test",isAdmin:true};
  const defaults={
    identity:async()=>({user:admin,csrfToken:"admin-csrf"}),adminSession:async()=>({admin:true,elevated:true,elevatedUntil:null}),
    overview:async()=>({accounts:{total:1}}),productSignals:async()=>({totals:{}}),users:async()=>({users:[],total:0}),user:async(id)=>({user:{id,email:`${id}@example.test`}}),
    userAction:async()=>({message:"Action complete"}),support:async()=>({tickets:[],total:0}),updateSupport:async()=>({message:"Support updated"}),audit:async()=>({events:[]})
  };
  const client={};
  for(const name of Object.keys(defaults))client[name]=(...args)=>{calls.push({name,args});return(routes[name]||defaults[name])(...args);};
  let handlers,state,openUser;
  const renderer={
    clearPrivateData(){trace.push({name:"purge"});for(const node of elements.values()){node.textContent="";node.value="";node.children=[];}},
    closeDialog(dialog){dialog.close();},create(tag,className="",text=""){void tag;void className;const node=new RuntimeElement("created");node.textContent=String(text);return node;},el,
    renderAudit(data){trace.push({name:"audit",data});},renderOverview(data){trace.push({name:"overview",data});},renderProductSignals(data){trace.push({name:"signals",data});},
    renderSupport(data){trace.push({name:"support",data});},renderUserDetails(user){state.selectedUser=user;trace.push({name:"user-detail",data:user});},
    renderUsers(data,_total,onOpen){openUser=onOpen;trace.push({name:"users",data});},setActionAvailability(){},setBusy(node,busy){node.setAttribute("aria-busy",busy);},
    setLastUpdated(){trace.push({name:"updated"});},setSectionStatus(id,message){el(id).textContent=message;trace.push({name:"status",id,message});},
    showGlobal(message){el("globalMessage").textContent=message;trace.push({name:"global",message});},syncDialogLock(){},updateGrantFields(){},updateSupportSubmitLabel(){},
    openActionConfirmation(){},openSupportDialog(){}
  };
  const location={hash:"",reload(){trace.push({name:"reload"});}},history={replaceState(){}},window={fetch:async()=>{throw new Error("Unexpected fetch");}};
  const context={console,document,window,location,history,Date,Intl,Set,URLSearchParams,requestAnimationFrame:(callback)=>callback(),setTimeout:()=>1,clearTimeout(){}};
  context.globalThis=context;
  vm.createContext(context);
  for(const file of ["admin-state.js","admin-logic.js","admin-session.js"])vm.runInContext(sourceFor(file),context,{filename:file});
  context.StrataAdminApi={createClient:()=>client};
  context.StrataAdminRender={createRenderer:(dependencies)=>{state=dependencies.state;return renderer;}};
  context.StrataAdminEvents={bindEvents:(dependencies)=>{handlers=dependencies.handlers;}};
  vm.runInContext(sourceFor("admin.js"),context,{filename:"admin.js"});
  return{admin,calls,document,elements,get handlers(){return handlers;},get openUser(){return openUser;},get state(){return state;},routes,trace};
}

test("admin client modules keep server data out of HTML injection sinks and browser storage",()=>{
  const source=allAdminSource(),renderSource=sourceFor("admin-render.js"),controller=sourceFor("admin.js");
  assert.match(renderSource,/function\s*create\s*\(\s*[\s\S]*?node\s*\.textContent\s*=\s*String\s*\(\s*text\s*,?\s*\)/);
  assert.match(renderSource,/ticketMessage"\s*,?\s*\)\s*\.textContent\s*=/);
  assert.match(controller,/adminIdentity"\s*,?\s*\)\s*\.textContent\s*=/);
  assert.doesNotMatch(source,/\.innerHTML\s*=|\.outerHTML\s*=|insertAdjacentHTML\s*\(|document\s*\.write\s*\(|\beval\s*\(|new\s*Function\s*\(/);
  assert.doesNotMatch(source,/localStorage|sessionStorage|indexedDB/,
    "private admin responses and authorization state must remain in memory only");
});

test("admin API owns same-origin requests, CSRF attachment, and endpoint construction",async()=>{
  const {createClient}=require("../public/scripts/admin-api");
  const calls=[];
  const fetchImpl=async(path,options)=>{calls.push({path,options});return{ok:true,status:200,headers:{get:()=>"application/json"},json:async()=>({ok:true})};};
  let csrfToken="csrf-one";
  const client=createClient({fetchImpl,getCsrfToken:()=>csrfToken});
  await client.overview();
  await client.userAction("user/one",{action:"suspend"});
  await client.updateSupport("ticket two",{status:"open"});
  csrfToken="csrf-two";await client.userAction("user/two",{action:"restore"});
  assert.equal(calls[0].options.credentials,"same-origin");
  assert.equal(calls[0].options.headers["X-CSRF-Token"],undefined);
  assert.equal(calls[1].path,"/api/admin/users/user%2Fone/actions");
  assert.equal(calls[1].options.headers["X-CSRF-Token"],"csrf-one");
  assert.equal(calls[2].path,"/api/admin/support/ticket%20two");
  assert.equal(calls[3].path,"/api/admin/users/user%2Ftwo/actions");
  assert.equal(calls[3].options.headers["X-CSRF-Token"],"csrf-two");
  assert.doesNotMatch(sourceFor("admin-api.js"),/fetchImpl\s*\(\s*\s*[`'"]https?\s*:\s*\/\//i,"admin data must never be sent to a cross-origin endpoint");
});

test("Admin removes step-up and typed friction while retaining one clear review click",()=>{
  const html=readPublic("pages/admin.html"),controller=sourceFor("admin.js"),logic=sourceFor("admin-logic.js");
  assert.doesNotMatch(html,/id\s*=\s*"elevation(?:Panel|Password|Code|Form|Submit|Restart)"/i);
  assert.doesNotMatch(html,/id\s*=\s*"action(?:Reason|Confirmation)"|id\s*=\s*"confirmationPhrase"/i);
  assert.doesNotMatch(allAdminSource(),/\/api\/admin\/elevate|verifyElevation|submitElevation|showElevation/);
  for(const action of ["send-password-reset","send-delete-link","cancel-deletion","revoke-sessions","suspend","restore","delete-account","grant-plus","revoke-plus","close-checkouts","enable-checkouts"]){
    assert.match(html,new RegExp(`data-user-action="${action}"`));assert.match(logic,new RegExp(`(?:"${action}"|${action}):\\s*\\{`));
  }
  assert.match(html,/<dialog class="confirm-dialog"[^>]*id="confirmDialog"/i);
  assert.match(html,/id="confirmDescription"/i);assert.match(html,/id="cancelAction"[^>]*>Cancel</i);assert.match(html,/id="submitAction"[^>]*type="submit"/i);
  assert.match(controller,/const\s*payload\s*=\s*\{\s*action\s*,\s*expectedControlsRevision\s*:\s*Number\s*\(\s*user\s*\.controlsRevision\s*\|\|\s*0\s*,?\s*\)\s*[;,]?\s*\}/);
  assert.doesNotMatch(controller,/\b(?:reason|confirmation)\b\s*[:,=]/i);
  assert.match(html,/class="irreversible-zone"[^>]*aria-labelledby="permanentDeletionTitle"/i);
  assert.match(html,/does not cancel a live Paddle subscription|cannot be undone, cancel a live Paddle subscription/i);
  assert.doesNotMatch(controller,/if\s*\(\s*action\s*===\s*"delete-account"\s*&&\s*!\s*suspended\s*,?\s*\)/);
});

test("an authenticated bound owner opens the dashboard without another credential prompt",async()=>{
  const page=createAdminRuntime();await settle();
  assert.equal(page.state.authorized,true);
  assert.equal(page.elements.get("dashboard").hidden,false);
  assert.equal(page.elements.get("accessPanel").hidden,true);
  assert.deepEqual(page.calls.slice(0,2).map((call)=>call.name),["identity","adminSession"]);
  assert.equal(page.calls.some((call)=>call.name==="elevate"||call.name==="verifyElevation"),false);
});

test("one reviewed account action sends no password, typed phrase, or audit reason",async()=>{
  const page=createAdminRuntime();await settle();page.calls.length=0;
  page.state.selectedUser={id:"member-one",email:"member@example.test",controlsRevision:7};page.state.pendingAction="suspend";
  await page.handlers.submitUserAction({preventDefault(){}});await settle();
  const call=page.calls.find((entry)=>entry.name==="userAction");
  assert.equal(call.args[0],"member-one");assert.equal(JSON.stringify(call.args[1]),JSON.stringify({action:"suspend",expectedControlsRevision:7}));
});

test("admin page loads the dependency graph before its thin controller",()=>{
  const html=readPublic("pages/admin.html");
  let previous=-1;
  for(const name of ADMIN_MODULES){const index=html.indexOf(`/${name}?v=`);assert.ok(index>previous,`${name} should load in dependency order`);previous=index;}
  assert.equal(sourceFor("admin-state.js").includes("StrataAdminLogic"),false);
  assert.equal(sourceFor("admin-logic.js").includes("StrataAdminRender"),false);
  assert.equal(sourceFor("admin-api.js").includes("StrataAdminState"),false);
});

test("admin page declares a private, accessible management surface",()=>{
  const html=readPublic("pages/admin.html");
  assert.match(html,/<meta name="robots" content="noindex, nofollow, noarchive" \/>/i);assert.match(html,/<meta name="referrer" content="no-referrer" \/>/i);
  assert.match(html,/<a class="skip-link" href="#adminMain">/i);assert.match(html,/role="tablist"/i);assert.match(html,/role="status"[^>]*aria-live="polite"/i);
  assert.match(html,/<dialog[^>]+id="userDialog"/i);assert.match(html,/<dialog[^>]+id="confirmDialog"/i);assert.match(html,/<dialog[^>]+id="supportDialog"/i);
  assert.doesNotMatch(html,/href\s*=\s*"\/manifest\s*\.webmanifest"|src\s*=\s*"\/pwa\s*\.js/i);
});

test("a persisted Admin restore purges and locks private state before reloading",()=>{
  const controller=sourceFor("admin.js"),session=sourceFor("admin-session.js");
  assert.match(session,/if\s*\(\s*!\s*event\s*\.persisted\s*,?\s*\)\s*return/);assert.match(session,/lockPrivateView\([^)]*\);\s*location\.reload\(\)/);
  assert.match(controller,/function\s*lockPrivateView[\s\S]*?clearAdminData\s*\(\s*,?\s*\)\s*;\s*state\s*\.admin\s*=\s*null\s*;\s*state\s*\.csrfToken\s*=\s*""\s*;\s*state\s*\.authorized\s*=\s*false/);
  assert.match(controller,/dashboard"\s*,?\s*\)\s*\.hidden\s*=\s*true/);assert.match(controller,/accessPanel"\s*,?\s*\)\s*\.hidden\s*=\s*false/);assert.match(controller,/adminMain"\s*,?\s*\)\s*\.setAttribute\s*\(\s*"aria-busy"\s*,\s*"true"\s*,?\s*\)/);
});

test("ordinary foreground restore locks private data and revalidates the same administrator",()=>{
  const controller=sourceFor("admin.js"),events=sourceFor("admin-events.js"),handler=sourceFor("admin-session.js");
  assert.match(events,/document\s*\.addEventListener\s*\(\s*"visibilitychange"\s*,\s*handlers\s*\.handleVisibilityChange\s*,?\s*\)/);
  assert.match(events,/window\s*\.addEventListener\s*\(\s*"focus"\s*,\s*handlers\s*\.handleVisibilityChange\s*,?\s*\)/);
  assert.match(handler,/if\s*\(\s*document\s*\.hidden\s*,?\s*\)\s*return/);assert.match(handler,/if\s*\(\s*revalidation\s*,?\s*\)\s*return\s*revalidation/);
  assert.match(handler,/const\s*expectedAdminId\s*=\s*userId\s*\(\s*state\s*\.admin\s*,?\s*\)/);
  assert.ok(handler.indexOf("lockPrivateView(")<handler.indexOf("await client.identity()"),"private DOM must be purged before the first foreground request");
  assert.match(handler,/currentAdminId\s*!==\s*expectedAdminId/);
  assert.match(handler,/await client\.adminSession\(\)/);
  assert.ok(handler.indexOf("currentAdminId!==expectedAdminId")<handler.indexOf("openDashboard()"),"a different account must never reopen the dashboard");
  assert.match(controller,/StrataAdminSession\.createSessionCoordinator/);
});

test("Admin invalidation prevents late reads and mutations from repainting a locked view",()=>{
  const controller=sourceFor("admin.js"),state=sourceFor("admin-state.js");
  assert.match(state,/invalidatePrivateOperations\s*\(\s*,?\s*\)\s*\{\s*privateGeneration\s*\+=\s*1/);
  assert.match(controller,/function\s*clearAdminData\s*\(\s*,?\s*\)\s*\{\s*\s*state\s*\.invalidatePrivateOperations\s*\(\s*,?\s*\)/);
  for(const request of ["productSignals", "overview", "users", "user", "userAction", "support", "updateSupport", "audit"]){
    assert.match(controller,new RegExp(`await client\\.${request}\\([^;]*[;)](?:if)?[\\s\\S]{0,180}privateOperationIsCurrent\\(operation\\)`),`${request} responses must be checked against the private-operation epoch`);
  }
});

test("Admin runtime discards every delayed private read and mutation after the view locks",async()=>{
  const page=createAdminRuntime();await settle();
  await page.handlers.loadUsers();
  const pending=Object.fromEntries(["overview","productSignals","users","user","userAction","support","updateSupport","audit"].map((name)=>[name,deferred()]));
  for(const [name,request] of Object.entries(pending))page.routes[name]=()=>request.promise;
  page.trace.length=0;
  const member={id:"member-one",name:"Private member",email:"private-member@example.test",controlsRevision:1};
  const work=[page.handlers.loadOverview(),page.handlers.loadProductSignals(),page.handlers.loadUsers(),page.handlers.loadSupport(),page.handlers.loadAudit(),page.openUser(member,new RuntimeElement("user-trigger"))];
  page.state.selectedUser=member;page.state.pendingAction="suspend";
  work.push(page.handlers.submitUserAction({preventDefault(){}}));
  page.state.selectedTicket={id:"ticket-one",status:"new",note:"",updatedAt:1};page.elements.get("ticketStatus").value="open";page.elements.get("ticketNote").value="Private workflow note";
  work.push(page.handlers.submitSupportUpdate({preventDefault(){}}));
  await settle();
  for(const name of Object.keys(pending))assert.equal(page.calls.some((call)=>call.name===name),true,`${name} should be in flight`);
  page.routes.identity=()=>new Promise(()=>{});void page.handlers.handleVisibilityChange();
  const purgeIndex=page.trace.findLastIndex((entry)=>entry.name==="purge");
  for(const [name,request] of Object.entries(pending))request.resolve(name==="user"?{user:{...member,name:"DELAYED PRIVATE USER"}}:name==="users"?{users:[{...member,name:"DELAYED PRIVATE LIST"}],total:1}:name==="support"?{tickets:[{id:"ticket-private",subject:"DELAYED PRIVATE SUPPORT"}],total:1}:name==="audit"?{events:[{action:"DELAYED PRIVATE AUDIT"}]}:name==="productSignals"?{totals:{preview_generated:999},marker:"DELAYED PRIVATE SIGNALS"}:{message:`DELAYED PRIVATE ${name.toUpperCase()}`,accounts:{total:999}});
  await Promise.allSettled(work);await settle();
  const forbidden=new Set(["overview","signals","users","user-detail","support","audit","global","updated"]);
  assert.deepEqual(page.trace.slice(purgeIndex+1).filter((entry)=>forbidden.has(entry.name)),[]);
  assert.equal(page.state.selectedUser,null);assert.equal(page.state.selectedTicket,null);assert.equal(page.state.authorized,false);
  assert.doesNotMatch([...page.elements.values()].map((node)=>node.textContent).join(" "),/DELAYED\s*PRIVATE/);
});

test("Admin runtime purges before BFCache reload and rejects a different foreground identity",async()=>{
  const restored=createAdminRuntime();await settle();restored.trace.length=0;restored.elements.get("usersStatus").textContent="PRIVATE RESTORED ADMIN DATA";
  restored.handlers.handlePageShow({persisted:true});
  assert.ok(restored.trace.findIndex((entry)=>entry.name==="purge")<restored.trace.findIndex((entry)=>entry.name==="reload"));
  assert.equal(restored.elements.get("usersStatus").textContent,"");assert.equal(restored.elements.get("dashboard").hidden,true);

  const foreground=createAdminRuntime();await settle();const identity=deferred(),sessionCallsBefore=foreground.calls.filter((call)=>call.name==="adminSession").length;
  foreground.routes.identity=()=>identity.promise;foreground.trace.length=0;foreground.elements.get("auditStatus").textContent="PRIVATE FOREGROUND ADMIN DATA";
  const revalidation=foreground.handlers.handleVisibilityChange();
  assert.equal(foreground.trace[0].name,"purge");assert.equal(foreground.elements.get("auditStatus").textContent,"");assert.equal(foreground.elements.get("dashboard").hidden,true);
  assert.equal(foreground.state.admin,null);assert.equal(foreground.state.authorized,false);
  identity.resolve({user:{...foreground.admin,id:"different-admin",email:"different@example.test"},csrfToken:"different-csrf"});
  await revalidation;await settle();
  assert.equal(foreground.calls.filter((call)=>call.name==="adminSession").length,sessionCallsBefore,"a changed identity must not reach the Admin session endpoint");
  assert.equal(foreground.elements.get("dashboard").hidden,true);assert.equal(foreground.elements.get("accessPanel").hidden,false);assert.equal(foreground.state.admin,null);
  assert.equal(foreground.document.body.classList.contains("admin-ready"),false);
});

test("Admin foreground recheck supersedes a delayed initial identity",async()=>{
  const stale=deferred(),current={id:"current-admin",name:"Current Admin",email:"current-admin@example.test",isAdmin:true};let identityReads=0;
  const page=createAdminRuntime({identity:()=>{identityReads+=1;return identityReads===1?stale.promise:Promise.resolve({user:current,csrfToken:"current-csrf"});}});
  const first=page.handlers.handleVisibilityChange(),paired=page.handlers.handleVisibilityChange();await Promise.all([first,paired]);await settle();
  assert.equal(identityReads,2,"paired foreground events share one fresh identity request");assert.equal(page.state.admin.id,current.id);assert.equal(page.state.csrfToken,"current-csrf");
  stale.resolve({user:page.admin,csrfToken:"stale-csrf"});await settle();
  assert.equal(page.state.admin.id,current.id);assert.equal(page.state.csrfToken,"current-csrf");
  const rendered=[...page.elements.values()].map((node)=>node.textContent).join(" ");assert.match(rendered,/Current Admin|current-admin@example\.test/);assert.doesNotMatch(rendered,/Admin\s*One|admin-one@example\s*\.test/);
});

test("Admin product-signal ranges render only the latest response",async()=>{
  const page=createAdminRuntime();await settle();const first=deferred(),second=deferred();let request=0;
  page.routes.productSignals=()=>{request+=1;return request===1?first.promise:second.promise;};page.trace.length=0;
  page.elements.get("productSignalDays").value="30";const older=page.handlers.loadProductSignals();
  page.elements.get("productSignalDays").value="7";const newer=page.handlers.loadProductSignals();
  second.resolve({marker:"LATEST RANGE",totals:{preview_generated:7}});await newer;
  first.resolve({marker:"STALE RANGE",totals:{preview_generated:30}});await older;
  assert.deepEqual(page.trace.filter((entry)=>entry.name==="signals").map((entry)=>entry.data.marker),["LATEST RANGE"]);
});

test("account actions stay locked until authoritative detail loads",()=>{
  const html=readPublic("pages/admin.html"),controller=sourceFor("admin.js"),render=sourceFor("admin-render.js");
  assert.match(html,/class="action-zone"[^>]*aria-describedby="userDetailStatus"/i);assert.match(controller,/renderUserDetails\s*\(\s*user\s*,\s*\{\s*actionsReady\s*:\s*false\s*[;,]?\s*\}\s*,?\s*\)/);
  assert.match(render,/if\s*\(\s*!\s*actionsReady\s*,?\s*\)\s*\{\s*disabled\s*=\s*true\s*;\s*title\s*=\s*"Full\s*account\s*details\s*are\s*still\s*loading\."\s*;\s*[;,]?\s*\}/);
  assert.match(controller,/renderUserDetails\s*\(\s*result\s*\.user\s*,\s*\{\s*actionsReady\s*:\s*true\s*[;,]?\s*\}\s*,?\s*\)/);assert.match(controller,/Account actions remain locked\. \$\{friendlyError\(error\)\}/);
});

test("Admin deletion blockers explain payment holds without implying that closing restores the account",()=>{
  const html=readPublic("pages/admin.html"),controller=sourceFor("admin.js"),logic=sourceFor("admin-logic.js");
  assert.match(html,/Block new and close eligible checkouts/);
  assert.match(logic,/CHECKOUT_PREPARING[\s\S]{0,300}in-flight checkout/);
  assert.match(logic,/PURCHASE_PENDING[\s\S]{0,320}revoking STRATA sign-in sessions do not cancel/);
  assert.match(controller,/To restore access, cancel this review and choose Restore account/);
  assert.doesNotMatch(controller,/Close\s*this\s*dialog\s*to\s*restore\s*it/);
});

test("admin state changes move focus to stable visible targets",()=>{
  const html=readPublic("pages/admin.html"),controller=sourceFor("admin.js"),render=sourceFor("admin-render.js");
  assert.match(html,/id="accessTitle" tabindex="-1"/i);assert.match(controller,/if\s*\(\s*focus\s*,?\s*\)\s*requestAnimationFrame\s*\(\s*\(\s*,?\s*\)\s*=>\s*el\s*\(\s*"accessTitle"\s*,?\s*\)\s*\.focus/);
  assert.match(render,/el\s*\(\s*"supportDialog"\s*,?\s*\)\s*\.showModal\s*\(\s*,?\s*\)\s*;\s*syncDialogLock\s*\(\s*,?\s*\)\s*;\s*requestFrame\s*\(\s*\(\s*,?\s*\)\s*=>\s*el\s*\(\s*"supportDialogTitle"\s*,?\s*\)\s*\.focus/);
  assert.match(controller,/if\s*\(\s*adminSession\s*\.admin\s*!==\s*true\s*,?\s*\)\s*[\s\S]{0,200}openDashboard\s*\(\s*,?\s*\)/);assert.match(render,/if\s*\(\s*message\s*&&\s*!\s*persist\s*&&\s*!\s*error\s*&&\s*!\s*focus\s*,?\s*\)\s*globalMessageTimer\s*=/,
    "a success message that receives focus must not disappear underneath it");
});

test("authenticated admin layout keeps dense desktop rows and readable controls",()=>{
  const css=readPublic("styles/admin.css");
  assert.match(css,/body\s*\.admin-ready\s*\.record-card\s*>\s*button\s*\{\s*min-height\s*:\s*72px\s*;/);assert.match(css,/body\s*\.admin-ready\s*\.record-primary\s*\{\s*display\s*:\s*grid\s*;\s*grid-template-columns\s*:/);
  assert.match(css,/\.pagination\s*button\s*\{\s*min-height\s*:\s*44px\s*;/);assert.match(css,/\.field\s*label\s*\{\s*[^}]*font\s*:\s*600\s*12px\/1\.5\s*var\s*\(\s*--body/);
});

function fakeDocument(){
  const nodes=new Map();
  function node(id=""){
    if(!nodes.has(id))nodes.set(id,{id,value:"",hidden:false,required:false,textContent:"",className:"",open:false,children:[],dataset:{},classList:{toggle(){},add(){},remove(){}},replaceChildren(...children){this.children=children;},append(...children){this.children.push(...children);},setAttribute(){},addEventListener(){},focus(){this.focused=true;},showModal(){this.open=true;},close(){this.open=false;},closest(){return node(`${id}-closest`);}});
    return nodes.get(id);
  }
  return{nodes,getElementById:node,createElement:()=>node(`created-${nodes.size}`),createDocumentFragment:()=>node(`fragment-${nodes.size}`),querySelectorAll:()=>[],querySelector:()=>null,contains:()=>true,body:{classList:{toggle(){}}}};
}

test("admin review dialog manages grant duration and action-specific one-click labels",()=>{
  const stateModule=require("../public/scripts/admin-state"),logic=require("../public/scripts/admin-logic"),{createRenderer}=require("../public/scripts/admin-render");
  const document=fakeDocument(),state=stateModule.createState(),renderer=createRenderer({document,state,logic,productSignalLabels:stateModule.PRODUCT_SIGNAL_LABELS,supportStates:stateModule.SUPPORT_STATES});
  state.selectedUser={id:"member",email:"member@example.test"};document.getElementById("grantUnit").value="days";
  renderer.openActionConfirmation("grant-plus",null,logic.ACTION_DETAILS["grant-plus"]);
  assert.equal(document.getElementById("grantFields").hidden,false);assert.equal(document.getElementById("grantAmount").required,true);
  assert.equal(document.getElementById("submitAction").textContent,"Give free Strata+ →");
  document.getElementById("grantUnit").value="until";renderer.updateGrantFields();assert.equal(document.getElementById("grantUntilField").hidden,false);assert.equal(document.getElementById("grantUntil").required,true);
  document.getElementById("grantUnit").value="indefinite";renderer.updateGrantFields();assert.equal(document.getElementById("grantAmount").required,false);assert.equal(document.getElementById("grantUntil").required,false);
  renderer.openActionConfirmation("delete-account",null,logic.ACTION_DETAILS["delete-account"]);
  assert.equal(document.getElementById("grantFields").hidden,true);assert.equal(document.getElementById("submitAction").textContent,"Permanently delete account →");
  assert.match(document.getElementById("confirmDescription").textContent,/member@example\.test/);
});
