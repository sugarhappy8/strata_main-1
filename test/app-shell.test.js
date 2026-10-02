"use strict";

const test=require("node:test");
const assert=require("node:assert/strict");
const fs=require("node:fs");
const path=require("node:path");
const vm=require("node:vm");

const ROOT=path.join(__dirname,"..");
const read=(file)=>fs.readFileSync(path.join(ROOT,file),"utf8");
const SOURCE=read("public/scripts/app-shell.js");
const IOS_UA="Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 StrataApp/1";

// A footer such as `STRATA · <a>Pricing</a> · <a>Install</a>`: text and link nodes in one parent.
function footer(parts){
  const parent={childNodes:[]};
  for(const part of parts){
    const node=part.href?{nodeType:1,href:part.href,text:part.text}:{nodeType:3,textContent:part};
    node.remove=()=>{parent.childNodes.splice(parent.childNodes.indexOf(node),1);};
    Object.defineProperty(node,"previousSibling",{get:()=>parent.childNodes[parent.childNodes.indexOf(node)-1]||null});
    parent.childNodes.push(node);
  }
  return parent;
}
const render=(parent)=>parent.childNodes.map((node)=>node.nodeType===3?node.textContent:`[${node.text}]`).join("");

function harness({userAgent=IOS_UA,pathname="/",readyState="loading",footers=[]}={}){
  const listeners={},replaced=[],written=[],root={dataset:{}};
  const document={
    readyState,documentElement:root,write:(markup)=>written.push(markup),
    addEventListener(type,handler){(listeners[type]||=[]).push(handler);},
    querySelectorAll(selector){
      assert.equal(selector,'a[href^="/install"]');
      return footers.flatMap((parent)=>parent.childNodes.filter((node)=>node.nodeType===1&&node.href.startsWith("/install")));
    }
  };
  const window={};
  const context={window,document,navigator:{userAgent},location:{pathname,replace:(url)=>replaced.push(url)},Node:{TEXT_NODE:3}};
  vm.createContext(context);
  vm.runInContext(SOURCE,context,{filename:"app-shell.js"});
  return {window,root,listeners,replaced,written,ready(){for(const handler of listeners.DOMContentLoaded||[])handler();}};
}

test("app shell leaves the website untouched in browsers",()=>{
  const site=footer(["STRATA · ",{href:"/pricing",text:"Pricing"}," · ",{href:"/install.html",text:"Install"}]);
  const page=harness({userAgent:"Mozilla/5.0 (iPhone) Safari/604.1",footers:[site]});
  assert.equal(page.root.dataset.app,undefined);
  assert.equal(page.window.StrataApp,undefined);
  assert.equal(page.listeners.DOMContentLoaded,undefined);
  assert.equal(render(site),"STRATA · [Pricing] · [Install]");
  assert.deepEqual(page.written,[],"browsers never load the app's chrome");
});

test("inside the iOS app the app's stylesheet and chrome script are written into the head, render-blocking and in order",()=>{
  const page=harness();
  assert.deepEqual(page.written,['<link rel="stylesheet" href="/app-mode.css?v=9.3.0" /><script src="/app-mode.js?v=9.3.0"></script>']);
  assert.deepEqual(harness({pathname:"/install"}).written,[],"the install page leaves before anything loads");
  assert.match(read("src/server.js"),/\["app-mode\.js","scripts\/app-mode\.js"\],\["app-mode\.css","styles\/app-mode\.css"\],\["app-paywall\.js","scripts\/app-paywall\.js"\]/);
  for(const asset of ["/app-mode.js","/app-mode.css","/app-paywall.js"])assert.match(read("public/service-worker.js"),new RegExp(`"${asset.replace(/[.]/g,"\\.")}\\?v=9\\.3\\.0"`));
  assert.match(read("scripts/release-version.js"),/"public\/scripts\/app-mode\.js",\n {4}"public\/scripts\/app-shell\.js",/,"a release bump updates the injected asset versions");
});

test("inside the iOS app the page is marked before paint and install links leave with their separators",()=>{
  const site=footer(["STRATA · ",{href:"/pricing",text:"Pricing"}," · ",{href:"/install.html",text:"Install"}]);
  const nav=footer([{href:"#rankings",text:"Rankings"},{href:"/dashboard",text:"Dashboard"},{href:"/install.html",text:"Install"}]);
  const page=harness({footers:[site,nav]});
  assert.equal(page.root.dataset.app,"ios");
  assert.ok(Object.isFrozen(page.window.StrataApp));
  assert.deepEqual({...page.window.StrataApp},{platform:"ios",shellVersion:1});
  assert.equal(render(site),"STRATA · [Pricing] · [Install]","links stay until the document is parsed");
  page.ready();
  assert.equal(render(site),"STRATA · [Pricing]");
  assert.equal(render(nav),"[Rankings][Dashboard]");
});

test("inside the iOS app a fully parsed page is cleaned at once, and the install page goes home",()=>{
  const site=footer([{href:"/contact",text:"Contact"}," · ",{href:"/install",text:"Install app"}]);
  harness({readyState:"complete",footers:[site]});
  assert.equal(render(site),"[Contact]");
  for(const pathname of ["/install.html","/install","/install/"]){
    const page=harness({pathname});
    assert.deepEqual(page.replaced,["/"],pathname);
    assert.equal(page.listeners.DOMContentLoaded,undefined);
  }
  assert.deepEqual(harness({pathname:"/installer-guide"}).replaced,[]);
});

test("every page loads the app shell first in its head, and the server and offline cache serve it",()=>{
  const pages=fs.readdirSync(path.join(ROOT,"public/pages")).filter((file)=>file.endsWith(".html"));
  assert.ok(pages.length>=20);
  for(const page of pages){
    const html=read(`public/pages/${page}`),head=html.slice(0,html.indexOf("</head>"));
    const scripts=[...head.matchAll(/<script\b[^>]*\bsrc="([^"]+)"/g)].map((match)=>match[1]);
    assert.equal(scripts[0],"/app-shell.js?v=9.3.0",`${page} must load app-shell.js before any other script`);
    assert.doesNotMatch(head.match(/<script\b[^>]*app-shell\.js[^>]*>/)[0],/\b(?:defer|async)\b/,`${page} must run app-shell.js before first paint`);
  }
  assert.match(read("src/server.js"),/\["app-shell\.js","scripts\/app-shell\.js"\]/);
  assert.match(read("public/service-worker.js"),/"\/app-shell\.js\?v=9\.3\.0"/);
  assert.match(read("public/styles/tokens.css"),/:root\[data-app="ios"\] a\[href\^="\/install"\] \{ display:none !important; \}/);
  // The app shows light status bar icons, so the area under them stays dark even on light pages.
  assert.match(read("public/styles/tokens.css"),/:root\[data-app="ios"\] body::before \{[^}]*position:fixed;[^}]*height:env\(safe-area-inset-top\);[^}]*background:var\(--strata-ink\);[^}]*pointer-events:none;/);
});

test("inside the iOS app the PWA helper reports the site as installed",()=>{
  const installedIn=(window)=>{
    const context={window:{...window,addEventListener(){},dispatchEvent(){},matchMedia:()=>({matches:false})},navigator:{standalone:false},location:{protocol:"https:"},CustomEvent:class{}};
    vm.createContext(context);
    vm.runInContext(read("public/scripts/pwa.js"),context,{filename:"pwa.js"});
    return context.window.StrataPWA.isInstalled();
  };
  assert.equal(installedIn({}),false);
  assert.equal(installedIn({StrataApp:Object.freeze({platform:"ios",shellVersion:1})}),true);
});

test("the iOS app's user agent token is the one the website recognizes",()=>{
  // The iOS app (repository sugarhappy8/strata-fitness-ios) appends this token in its capacitor.config.json.
  const appUserAgent="Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 StrataApp/1";
  assert.equal(harness({userAgent:appUserAgent}).root.dataset.app,"ios");
  assert.equal(harness({userAgent:appUserAgent.replace("StrataApp/1","StrataApplication/1")}).root.dataset.app,undefined);
});
