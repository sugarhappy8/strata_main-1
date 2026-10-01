"use strict";

const test=require("node:test");
const assert=require("node:assert/strict");
const Logic=require("../public/scripts/pricing-logic");
const State=require("../public/scripts/pricing-state");
const Api=require("../public/scripts/pricing-api");
const Render=require("../public/scripts/pricing-render");
const Events=require("../public/scripts/pricing-events");

test("pricing pure logic validates only the configured recurring catalog boundary",()=>{
  const valid={enabled:true,environment:"live",clientToken:"live_fixture",productId:`pro_${"a".repeat(26)}`,priceId:`pri_${"b".repeat(26)}`,price:{amount:"2.99",currency:"USD",interval:"month",frequency:1}};
  assert.equal(Logic.validateConfig(valid),valid);
  for(const patch of [
    {environment:"other"},{clientToken:"test_fixture"},{productId:"pro_invalid"},
    {priceId:Logic.RETIRED_ONE_TIME_PRICE_ID},{price:{...valid.price,amount:"9.99"}}
  ])assert.throws(()=>Logic.validateConfig({...valid,...patch}));
  assert.equal(Logic.checkoutTransactionId({transaction_id:"txn_fixture"}),"txn_fixture");
  assert.equal(Logic.paidAccessReady({discovery:{accessType:"grant",subscription:null}}),false);
  assert.equal(Logic.paidAccessReady({discovery:{accessType:"paid",subscription:null}}),true);
});

test("pricing API normalizes transport failures and rejects malformed success bodies",async()=>{
  const offline=Api.createRequestJson(async()=>{throw new Error("offline");});
  await assert.rejects(offline("/api/me"),error=>error.code==="NETWORK_ERROR"&&/Could not reach STRATA/.test(error.message));
  const malformed=Api.createRequestJson(async()=>({ok:true,status:200,json:async()=>null}));
  await assert.rejects(malformed("/api/me"),error=>error.code==="INVALID_RESPONSE");
  const denied=Api.createRequestJson(async()=>({ok:false,status:403,json:async()=>({code:"CSRF",error:"Refresh first."})}));
  await assert.rejects(denied("/api/me"),error=>error.status===403&&error.code==="CSRF");
});

test("pricing names App Store access only for a member whose Strata+ comes from Apple",()=>{
  const apple={active:true,expiresAt:Date.parse("2026-11-01T12:00:00Z"),autoRenew:true,inGracePeriod:false,revoked:false};
  assert.equal(Logic.appleAccess({discovery:{active:true,accessType:"apple",apple}}),apple);
  for(const user of [{discovery:{active:true,accessType:"paid",apple}},{discovery:{active:true,accessType:"apple",apple:null}},null])assert.equal(Logic.appleAccess(user),null);
  assert.equal(Logic.appleStatus(apple).tone,"good");assert.equal(Logic.appleStatus({...apple,autoRenew:false}).tone,"warn");
  assert.doesNotMatch(Logic.appleStatus({...apple,expiresAt:null}).message,/Paddle|undefined|renews on/,"no invented or Paddle date");
  assert.equal(Logic.APPLE_MANAGE_URL,"https://apps.apple.com/account/subscriptions");
});

test("pricing rendering gives a member without Strata+ a single subscribe action",()=>{
  const makeNode=()=>({hidden:false,disabled:false,textContent:"",attrs:{},classList:{toggle(){}},setAttribute(name,value){this.attrs[name]=value;},focus(){}});
  const nodes={panel:makeNode(),statusNode:makeNode(),signupLink:makeNode(),loginLink:makeNode(),buyButton:makeNode(),openLink:makeNode(),manageLink:makeNode(),checkButton:makeNode()};
  const state=State.createState();
  state.busy=false;state.paddleReady=true;state.config={environment:"live"};
  state.user={id:"member",discovery:{active:false,accessType:null,subscription:null}};
  const renderer=Render.createRenderer({state,nodes,logic:Logic,navigatorImpl:{onLine:true},locationImpl:{search:""},frame:callback=>callback()});
  renderer.renderPurchaseState();
  assert.equal(nodes.buyButton.hidden,false);
  assert.equal(nodes.buyButton.textContent,"Subscribe to Strata+ →");
  assert.equal(nodes.signupLink.hidden,true);
  assert.equal(nodes.openLink.hidden,true);
  assert.doesNotMatch(nodes.statusNode.textContent,/trial/i);
});

test("pricing events keep user input wiring outside the orchestrator",()=>{
  const calls=[];
  const node=()=>({addEventListener(type,handler){this[type]=handler;}});
  const buyButton=node(),checkButton=node(),windowImpl={addEventListener(type,handler){this[type]=handler;}},documentImpl={visibilityState:"visible",addEventListener(type,handler){this[type]=handler;}};
  Events.bind({windowImpl,documentImpl,buyButton,checkButton,actions:{openCheckout(){calls.push("buy");},refreshAccess(){calls.push("check");},recheckAccount(){calls.push("recheck");},renderPurchaseState(){calls.push("render");}}});
  buyButton.click();checkButton.click();windowImpl.online();windowImpl.offline();documentImpl.visibilitychange();windowImpl.focus();windowImpl.pageshow({persisted:false});windowImpl.pageshow({persisted:true});
  assert.deepEqual(calls,["buy","check","render","render","recheck","recheck","recheck"]);
});
