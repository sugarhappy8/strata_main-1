"use strict";
/* global document, getComputedStyle, innerHeight, innerWidth, window */

// The website inside the STRATA iOS app: a phone-sized page whose user agent carries "StrataApp/1" and whose
// StrataNative plugin is a recorded mock. Browsers without the token must render and request exactly what they did.
const assert=require("node:assert/strict");
const {existsSync,readFileSync}=require("node:fs");
const {extname,join,resolve}=require("node:path");
const test=require("node:test");
const {chromium}=require("playwright");

const ROOT=join(__dirname,"..",".."),ORIGIN="http://strata-app.test";
const APP_UA="Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 StrataApp/1";
const ALIASES=new Map([["/","index.html"],["/pricing","pricing.html"],["/dashboard","dashboard.html"],["/policies","policies.html"],["/terms","terms.html"],["/privacy","privacy.html"],["/contact","contact.html"]]);
const USER_ID="3c9a2f1e-5b6d-4e7f-8a9b-0c1d2e3f4a5b";
const APPLE={active:true,productId:"online.stratafitness.app.plus.monthly",expiresAt:Date.parse("2026-11-01T12:00:00Z"),autoRenew:true,inGracePeriod:false,environment:"Sandbox",revoked:false};
let browser;

function staticAsset(pathname){
  if(pathname.includes(".."))return null;
  if(ALIASES.has(pathname))return join(ROOT,"public/pages",ALIASES.get(pathname));
  const relative=pathname.replace(/^\//,""),extension=extname(relative),folder=extension===".html"?"pages":extension===".js"?"scripts":extension===".css"?"styles":"";
  return [join(ROOT,"public",relative),...(folder?[join(ROOT,"public",folder,relative)]:[])].find((candidate)=>existsSync(candidate))||null;
}

// Mirrors StrataNative's contract (getProducts, purchase, finishTransaction, restore, currentEntitlements, haptic,
// manageSubscriptions, transactionUpdated) and records every call on window.__nativeCalls.
function installNativeMock(){
  const calls=[];window.__nativeCalls=calls;
  const record=(name,result)=>async(options)=>{calls.push([name,options??null]);return typeof result==="function"?result(options):result;};
  window.Capacitor={
    addListener:(plugin,event)=>{calls.push(["addListener",`${plugin}.${event}`]);return {remove:async()=>{}};},
    Plugins:{StrataNative:{
      getProducts:record("getProducts",{products:[{id:"online.stratafitness.app.plus.monthly",displayName:"Strata+",description:"Monthly",displayPrice:"$2.99",price:"2.99",currencyCode:"USD",period:{unit:"month",value:1}}]}),
      purchase:record("purchase",{status:"purchased",transactionId:"2000000555",signedTransaction:"header.payload.signature"}),
      finishTransaction:record("finishTransaction",{}),
      restore:record("restore",{signedTransactions:[]}),
      currentEntitlements:record("currentEntitlements",{signedTransactions:[]}),
      manageSubscriptions:record("manageSubscriptions",{}),
      haptic:record("haptic",{}),
      print:record("print",{})
    }}
  };
}

async function fixture(t,{app=true,signedIn=false,discovery={active:false,accessType:null,apple:null}}={}){
  const context=await browser.newContext({baseURL:ORIGIN,serviceWorkers:"block",viewport:{width:390,height:844},isMobile:true,hasTouch:true,reducedMotion:"reduce",...(app?{userAgent:APP_UA}:{})});
  t.after(()=>context.close());context.setDefaultTimeout(10_000);
  if(app)await context.addInitScript(installNativeMock);
  const state={requests:[],external:[],posts:[],errors:[],user:signedIn?{id:USER_ID,name:"Ada Lovelace",email:"ada@example.test",createdAt:1704067200000,planCount:1,workoutDays:1,discovery,capabilities:null,accountDeletion:{pending:false}}:null};
  await context.route("**/*",async(route)=>{
    const request=route.request(),url=new URL(request.url());
    state.requests.push(url.pathname);
    if(url.origin!==ORIGIN){state.external.push(url.href);await route.abort();return;}
    const json=(value,status=200)=>route.fulfill({status,contentType:"application/json",body:JSON.stringify(value)});
    if(url.pathname==="/api/me")return state.user?json({user:state.user,csrfToken:"journey-csrf"}):json({error:"Not signed in."},401);
    if(url.pathname==="/api/billing/apple/transactions"){
      state.posts.push({body:request.postDataJSON(),csrf:request.headers()["x-csrf-token"],user:request.headers()["x-strata-user"]});
      state.user={...state.user,discovery:{active:true,accessType:"apple",apple:APPLE}};
      return json({discovery:state.user.discovery,accepted:["2000000555"]});
    }
    if(url.pathname.startsWith("/api/"))return json({error:"Not in this journey."},404);
    const file=staticAsset(url.pathname);
    if(!file){await route.fulfill({status:404,body:"Missing fixture asset"});return;}
    // The server marks a signed-in homepage's account button; do the same here.
    if(url.pathname==="/"&&state.user)return route.fulfill({contentType:"text/html",body:readFileSync(file,"utf8").replace('class="account-button account-link" id="accountButton"','class="account-button account-link signed-in" id="accountButton"')});
    await route.fulfill({path:file});
  });
  const page=await context.newPage();
  page.on("pageerror",(error)=>state.errors.push(error.message));
  return {page,state};
}

const layout=()=>{
  const visible=(selector)=>[...document.querySelectorAll(selector)].some((node)=>{const style=getComputedStyle(node),box=node.getBoundingClientRect();return style.display!=="none"&&style.visibility!=="hidden"&&box.width>0&&box.height>0;});
  const bar=document.querySelector(".app-tabbar"),tabs=[...document.querySelectorAll(".app-tab")].map((tab)=>{const box=tab.getBoundingClientRect();return {id:tab.dataset.appTab,current:tab.getAttribute("aria-current"),width:box.width,height:box.height};});
  return {
    app:document.documentElement.dataset.app||null,chrome:document.documentElement.dataset.appChrome||null,home:document.documentElement.dataset.appHome||null,
    title:document.querySelector("[data-app-title]")?.textContent||null,back:visible(".app-back"),tabBar:bar?visible(".app-tabbar"):false,
    tabBarBottom:bar?Math.round(bar.getBoundingClientRect().bottom):null,viewport:innerHeight,tabs,
    tabBarTransition:bar?getComputedStyle(bar).viewTransitionName:null,lastChild:document.body.lastElementChild?.className||null,
    websiteHeader:visible("body > header:not(.app-topbar)"),footer:visible("body > footer"),mobileNav:visible(".mobile-public-nav"),skip:visible(".skip-link"),
    overflow:document.documentElement.scrollWidth-innerWidth
  };
};

test("inside the app a phone gets one top bar, one tab bar, and no website chrome",{timeout:40_000},async(t)=>{
  const {page,state}=await fixture(t);
  await page.goto("/",{waitUntil:"domcontentloaded"});
  await page.locator(".app-welcome").waitFor({state:"visible"});
  let view=await page.evaluate(layout);
  assert.equal(view.app,"ios");assert.equal(view.home,"welcome");
  assert.equal(view.tabBar,false,"the welcome screen stands alone");assert.equal(view.websiteHeader,false);assert.equal(view.footer,false);assert.equal(view.mobileNav,false);
  assert.equal(await page.locator(".hero").isHidden(),true,"no marketing homepage in the app");
  for(const name of ["Create account","Sign in"])assert.equal(await page.getByRole("link",{name,exact:true}).isVisible(),true,name);

  await page.getByRole("link",{name:/Explore the exercise rankings/}).click();
  await page.waitForFunction(()=>document.documentElement.dataset.appHome==="rankings");
  view=await page.evaluate(layout);
  assert.equal(view.title,"Rankings");assert.equal(view.tabBar,true);assert.equal(view.back,false);
  assert.deepEqual(view.tabs.map((tab)=>tab.id),["rankings","dashboard","train","recovery","profile"]);
  assert.deepEqual(view.tabs.filter((tab)=>tab.current==="page").map((tab)=>tab.id),["rankings"]);
  assert.ok(view.tabs.every((tab)=>tab.width>=44&&tab.height>=44),"44pt+ tab targets");
  assert.equal(view.tabBarBottom,view.viewport,"the tab bar sits on the bottom edge");
  assert.equal(view.tabBarTransition,"app-tabbar");assert.equal(view.lastChild,"app-tabbar","the tab bar follows the content");
  assert.equal(view.websiteHeader,false);assert.equal(view.footer,false);assert.equal(view.skip,false);assert.ok(view.overflow<=1,`no sideways scroll (${view.overflow}px)`);
  assert.equal(await page.locator("#rankings").isVisible(),true);assert.equal(await page.locator("#method").isHidden(),true);

  await page.goto("/terms",{waitUntil:"domcontentloaded"});
  view=await page.evaluate(layout);
  assert.equal(view.title,"Terms");assert.equal(view.back,true,"legal pages are child screens");
  assert.deepEqual(view.tabs.filter((tab)=>tab.current==="page").map((tab)=>tab.id),["profile"]);
  assert.equal(view.websiteHeader,false);assert.equal(view.footer,false);
  await page.goto("/account.html",{waitUntil:"domcontentloaded"});
  await page.locator(".app-more").waitFor({state:"attached"});
  for(const href of ["/pricing","/contact","/policies","/terms","/privacy"])assert.equal(await page.locator(`.app-more a[href="${href}"]`).count(),1,href);
  assert.equal(await page.locator('a[href^="/install"]').count(),0);
  assert.deepEqual(state.external,[]);assert.deepEqual(state.errors,[]);
});

test("in the app a signed-in member opens on Dashboard",{timeout:30_000},async(t)=>{
  const {page,state}=await fixture(t,{signedIn:true});
  await page.goto("/",{waitUntil:"domcontentloaded"});
  await page.waitForURL(`${ORIGIN}/dashboard`);
  await page.locator(".app-tabbar").waitFor({state:"visible"});
  const view=await page.evaluate(layout);
  assert.equal(view.title,"Dashboard");assert.deepEqual(view.tabs.filter((tab)=>tab.current==="page").map((tab)=>tab.id),["dashboard"]);
  assert.equal(view.footer,false);assert.equal(view.websiteHeader,false);
  await page.locator('.app-tab[data-app-tab="dashboard"]').click();
  assert.equal(page.url(),`${ORIGIN}/dashboard`,"tapping the current tab stays put");
  const haptics=await page.evaluate(()=>window.__nativeCalls.filter((call)=>call[0]==="haptic").map((call)=>call[1].style));
  assert.deepEqual(haptics,["selection"]);
  assert.deepEqual(state.external,[]);assert.deepEqual(state.errors,[]);
});

test("in the app, Strata+ is bought through the App Store and Paddle is never requested",{timeout:40_000},async(t)=>{
  const {page,state}=await fixture(t,{signedIn:true});
  await page.goto("/pricing",{waitUntil:"domcontentloaded"});
  const subscribe=page.getByRole("button",{name:"Subscribe",exact:true});
  await subscribe.waitFor({state:"visible"});
  assert.equal(await page.locator(".app-paywall-price").textContent(),"$2.99per month");
  for(const hidden of ["#purchasePanel",".hero-facts",".price-card",".checkout-note"])assert.equal(await page.locator(hidden).first().isHidden(),true,hidden);
  assert.match(await page.locator(".app-paywall-terms").textContent(),/at least 24 hours before the end of the current period/);
  assert.equal(await page.locator('.app-paywall-links a[href="/terms"]').isVisible(),true);assert.equal(await page.locator('.app-paywall-links a[href="/privacy"]').isVisible(),true);
  assert.equal(await page.getByRole("button",{name:"Restore Purchases"}).isVisible(),true);

  await subscribe.click();
  await page.getByRole("heading",{name:"You have Strata+"}).waitFor();
  assert.match(await page.locator(".app-paywall-status").textContent(),/Welcome to Strata\+/);
  assert.equal(await page.getByRole("button",{name:"Manage subscription"}).isVisible(),true);
  assert.equal(await page.getByRole("button",{name:"Subscribe",exact:true}).count(),0);
  assert.deepEqual(state.posts,[{body:{signedTransactions:["header.payload.signature"]},csrf:"journey-csrf",user:USER_ID}]);
  const calls=await page.evaluate(()=>window.__nativeCalls.map((call)=>call[0]==="haptic"?`haptic:${call[1].style}`:call[0]));
  const order=["purchase","finishTransaction","haptic:success"].map((name)=>calls.indexOf(name));
  assert.ok(order.every((index)=>index>=0)&&order[0]<order[1]&&order[1]<order[2],`purchase, then finish after STRATA accepted, then haptic (${calls})`);
  assert.deepEqual(await page.evaluate(()=>window.__nativeCalls.find((call)=>call[0]==="purchase")[1]),{productId:"online.stratafitness.app.plus.monthly",appAccountToken:USER_ID});
  assert.ok(calls.includes("addListener"),"StoreKit updates are listened for");
  assert.equal(state.external.filter((url)=>/paddle/i.test(url)).length,0,"Paddle is never requested in the app");
  assert.equal(state.requests.includes("/api/billing/config"),false,"Paddle checkout is never prepared");
  assert.deepEqual(state.errors,[]);
});

test("browsers without the app token keep the website exactly as it was",{timeout:40_000},async(t)=>{
  const {page,state}=await fixture(t,{app:false});
  for(const path of ["/","/pricing","/terms","/account.html"]){
    state.requests.length=0;
    await page.goto(path,{waitUntil:"load"});
    const view=await page.evaluate(layout);
    assert.equal(view.app,null,path);assert.equal(view.chrome,null,path);assert.equal(view.tabBar,false,path);
    assert.equal(await page.locator(".app-tabbar, .app-topbar, .app-welcome, .app-paywall, .app-more").count(),0,path);
    assert.equal(view.websiteHeader,true,`${path} keeps its header`);assert.equal(view.footer,true,`${path} keeps its footer`);
    assert.equal(await page.evaluate(()=>Boolean(window.StrataApp||window.StrataAppMode)),false,path);
    assert.deepEqual(state.requests.filter((request)=>/app-mode|app-paywall/.test(request)),[],`${path} never loads the app's files`);
    // Every request is one the page's own HTML names (plus its API reads and the catalog), as before.
    const html=readFileSync(staticAsset(path),"utf8"),named=new Set([...html.matchAll(/(?:src|href)="(\/?[^"?#:]+\.(?:js|css))(?:\?[^"]*)?"/g)].map((match)=>`/${match[1].replace(/^\//,"")}`));
    const unnamed=state.requests.filter((request)=>/\.(?:js|css)$/.test(request)&&!named.has(request));
    assert.deepEqual(unnamed,path==="/pricing"?["/paddle/v2/paddle.js"]:[],`${path} requests only what its HTML names`);
  }
  assert.ok(state.external.includes("https://cdn.paddle.com/paddle/v2/paddle.js"),"the website still loads Paddle checkout");
  await page.goto("/account.html",{waitUntil:"load"});
  assert.deepEqual(await page.evaluate(()=>["web-only","app-only"].map((name)=>getComputedStyle(document.querySelector(`.account-security .${name}`)).display)),["inline","none"],"the website keeps its own deletion copy");
  assert.deepEqual(state.errors,[]);
});

test.before(async()=>{const options={headless:true};if(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH)options.executablePath=resolve(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH);browser=await chromium.launch(options);});
test.after(()=>browser?.close());
