"use strict";

const assert=require("node:assert/strict");
const {spawn}=require("node:child_process");
const {mkdirSync,mkdtempSync,readFileSync,rmSync}=require("node:fs");
const {join,resolve}=require("node:path");
const test=require("node:test");
const {chromium}=require("playwright");

const ROOT=join(__dirname,"..",".."),RUNTIME_ROOT=join(ROOT,"test-runtime"),ADMIN_HTML=readFileSync(join(ROOT,"public","pages","admin.html"),"utf8");

function startServer(dataDirectory){
  const child=spawn(process.execPath,["server.js"],{cwd:ROOT,env:{...process.env,PORT:"0",HOST:"127.0.0.1",NODE_ENV:"test",TZ:"UTC",STRATA_DATA_DIR:dataDirectory,TURSO_DATABASE_URL:"",TURSO_AUTH_TOKEN:"",TRUST_PROXY:"false",APP_BASE_URL:"",SECURE_COOKIES:"false",ADMIN_EMAIL:"",EMAIL_VERIFICATION_ENABLED:"false",PADDLE_CHECKOUT_ENABLED:"false"},stdio:["ignore","pipe","pipe"]});
  return new Promise((resolveServer,reject)=>{
    let output="",settled=false;const timer=setTimeout(()=>finish(new Error("Admin E2E server startup timed out.")),8_000);
    function finish(error,baseUrl){if(settled)return;settled=true;clearTimeout(timer);if(error)reject(error);else resolveServer({child,baseUrl});}
    child.stdout.on("data",(chunk)=>{output=(output+chunk.toString()).slice(-4096);const match=output.match(/Strata running at http:\/\/127\.0\.0\.1:(\d+)/);if(match)finish(null,`http://127.0.0.1:${match[1]}`);});
    child.stderr.on("data",(chunk)=>process.stderr.write(chunk));child.once("error",finish);child.once("exit",(code,signal)=>finish(new Error(`Admin E2E server exited before startup (${code??signal??"unknown"}).`)));
  });
}

async function stopServer(child){
  if(!child||child.exitCode!==null||child.signalCode!==null)return;
  await new Promise((resolveStop)=>{let timer;child.once("exit",()=>{clearTimeout(timer);resolveStop();});child.kill("SIGTERM");timer=setTimeout(()=>{child.kill("SIGKILL");resolveStop();},2_000);});
}

const json=(route,body,status=200)=>route.fulfill({status,contentType:"application/json",body:JSON.stringify(body)});

test("bound owner uses simplified Admin while non-admins remain blocked",{timeout:60_000},async()=>{
  mkdirSync(RUNTIME_ROOT,{recursive:true});const runtimeDir=mkdtempSync(join(RUNTIME_ROOT,"admin-simplified-"));let server,browser,releaseRevalidation=()=>{};
  try{
    server=await startServer(runtimeDir);
    const launchOptions={headless:true};if(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH)launchOptions.executablePath=resolve(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH);
    browser=await chromium.launch(launchOptions);

    const ownerContext=await browser.newContext({viewport:{width:1280,height:900}}),ownerPage=await ownerContext.newPage();
    const owner={id:"owner-1",name:"STRATA Owner",email:"owner@example.test",isAdmin:true};
    const member={id:"member-1",name:"Member One",email:"member@example.test",verified:true,suspended:false,controlsRevision:7,checkoutBlocked:false,activeSessions:2,planCount:4,workoutDays:3,discovery:{adminGrant:{active:false},purchaseCount:0,pendingPurchaseCount:0}};
    const apiRequests=[],actionBodies=[],actionHeaders=[];let holdRevalidation=false,markRevalidationStarted;
    const revalidationStarted=new Promise((resolveStarted)=>{markRevalidationStarted=resolveStarted;});

    await ownerPage.route("**/admin.html",(route)=>route.fulfill({status:200,contentType:"text/html",body:ADMIN_HTML}));
    await ownerPage.route("**/api/**",async(route)=>{
      const request=route.request(),url=new URL(request.url()),path=url.pathname;apiRequests.push(`${request.method()} ${path}`);
      if(path==="/api/me"){
        if(holdRevalidation){markRevalidationStarted();await new Promise((resolveHeld)=>{releaseRevalidation=resolveHeld;});}
        return json(route,{user:owner,csrfToken:"owner-csrf"});
      }
      if(path==="/api/admin/session")return json(route,{admin:true,elevated:true,elevatedUntil:null});
      if(path==="/api/admin/overview")return json(route,{overview:{accounts:{total:2,verified:2,suspended:0,activeSessions:3},discovery:{activeUsers:1,pendingPayments:0},support:{open:0,pendingDeletions:0},activation:{}},system:{storage:"sqlite",persistent:true,emailConfigured:true,paymentsConfigured:true,webhookProtection:true}});
      if(path==="/api/admin/product-signals")return json(route,{totals:{},scope:{sinceDay:"2026-09-01",throughDay:"2026-09-11",retentionDays:90}});
      if(path==="/api/admin/users"&&request.method()==="GET")return json(route,{users:[member],total:1});
      if(path==="/api/admin/users/member-1"&&request.method()==="GET")return json(route,{user:member});
      if(path==="/api/admin/users/member-1/actions"&&request.method()==="POST"){
        actionBodies.push(request.postDataJSON());actionHeaders.push(await request.allHeaders());
        return json(route,{message:"Member One was suspended."});
      }
      return json(route,{error:`Unexpected fixture request: ${request.method()} ${path}`},500);
    });

    await ownerPage.goto(`${server.baseUrl}/admin.html`,{waitUntil:"domcontentloaded"});
    await ownerPage.locator("#dashboard").waitFor({state:"visible"});
    assert.equal(await ownerPage.locator("#adminIdentity").textContent(),"STRATA Owner · owner@example.test");
    assert.equal(await ownerPage.locator("#elevationPanel,#elevationPassword,#elevationCode").count(),0,"Admin must not render password, code, or elevation UI");
    assert.equal(apiRequests.some((request)=>request.includes("/api/admin/elevate")),false,"Admin must not request either elevation endpoint");

    await ownerPage.getByRole("tab",{name:"People"}).click();
    await ownerPage.getByRole("button",{name:/Open Member One/}).click();
    await ownerPage.locator("#userDialog").waitFor({state:"visible"});
    await ownerPage.getByRole("button",{name:/Suspend account/}).click();
    const review=ownerPage.getByRole("dialog",{name:"Suspend account?"});
    await review.waitFor({state:"visible"});
    assert.match(await review.locator("#confirmDescription").textContent(),/lose signed-in access[\s\S]*member@example\.test/i);
    assert.equal(await review.getByRole("button",{name:"Cancel",exact:true}).count(),1);
    assert.equal(await review.getByRole("button",{name:"Cancel action",exact:true}).count(),1);
    assert.equal(await review.getByRole("button",{name:/Suspend account/}).count(),1);
    assert.equal(await review.locator("#actionReason,#actionConfirmation").count(),0,"Admin actions must not ask for a reason or typed phrase");
    assert.equal(await review.getByText(/type .* to (continue|confirm)|reason for the audit/i).count(),0);

    await review.getByRole("button",{name:/Suspend account/}).click();
    await ownerPage.locator("#confirmDialog").waitFor({state:"hidden"});
    assert.deepEqual(actionBodies,[{action:"suspend",expectedControlsRevision:7}]);
    assert.equal(actionHeaders[0]["x-csrf-token"],"owner-csrf","the normal same-origin CSRF guard remains active");

    await ownerPage.getByRole("button",{name:/Open Member One/}).waitFor({state:"visible"});
    holdRevalidation=true;await ownerPage.evaluate(()=>globalThis.dispatchEvent(new Event("focus")));await revalidationStarted;
    assert.equal(await ownerPage.locator("#dashboard").isHidden(),true,"foreground revalidation must lock the dashboard immediately");
    assert.equal(await ownerPage.locator("#accessPanel").isVisible(),true);
    assert.equal(await ownerPage.locator("#userResults").textContent(),"","foreground revalidation must purge rendered private account data");
    releaseRevalidation();
    await ownerPage.locator("#dashboard").waitFor({state:"visible"});
    await ownerPage.getByRole("button",{name:/Open Member One/}).waitFor({state:"visible"});
    await ownerContext.close();

    const nonAdminContext=await browser.newContext({viewport:{width:390,height:800}}),nonAdminPage=await nonAdminContext.newPage();
    const nonAdminRequests=[];
    await nonAdminPage.route("**/admin.html",(route)=>route.fulfill({status:200,contentType:"text/html",body:ADMIN_HTML}));
    await nonAdminPage.route("**/api/**",async(route)=>{
      const request=route.request(),path=new URL(request.url()).pathname;nonAdminRequests.push(`${request.method()} ${path}`);
      if(path==="/api/me")return json(route,{user:{id:"member-2",name:"Regular Member",email:"regular@example.test",isAdmin:false},csrfToken:"member-csrf"});
      return json(route,{error:"Forbidden"},403);
    });
    await nonAdminPage.goto(`${server.baseUrl}/admin.html`,{waitUntil:"domcontentloaded"});
    await nonAdminPage.getByRole("heading",{name:"Admin access required."}).waitFor({state:"visible"});
    assert.equal(await nonAdminPage.locator("#dashboard").isHidden(),true);
    assert.deepEqual(nonAdminRequests,["GET /api/me"],"a non-admin must be rejected before private Admin APIs are requested");
    assert.equal(await nonAdminPage.locator("#elevationPanel,#elevationPassword,#elevationCode").count(),0);
    await nonAdminContext.close();
  }finally{
    releaseRevalidation();
    await browser?.close();await stopServer(server?.child);rmSync(runtimeDir,{recursive:true,force:true});
  }
});
