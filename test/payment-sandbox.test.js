"use strict";

const test=require("node:test");
const assert=require("node:assert/strict");
const {readFileSync}=require("node:fs");
const {join}=require("node:path");
const vm=require("node:vm");
const {
  DEFAULT_PRODUCT_ID,DEFAULT_PRICE_ID,LIVE_API_BASE,SANDBOX_API_BASE,
  getPaymentConfig,publicPaymentConfig,webhookSecretFor,createPaddleTransaction,fetchPaddleTransaction
}=require("../src/payments");

const PRODUCT="pro_01sandbox00000000000000000";
const PRICE="pri_01sandbox00000000000000000";
const LIVE_PRICE="pri_01monthlyfixture00000000000000";
const TRANSACTION="txn_01sandbox00000000000000000";
function sandboxEnv(overrides={}){
  return {NODE_ENV:"test",PADDLE_ENVIRONMENT:"sandbox",PADDLE_CHECKOUT_ENABLED:"true",
    PADDLE_CLIENT_TOKEN:"test_01sandboxclient000000000000",PADDLE_API_KEY:"pdl_sdbx_apikey_01sandbox000000000000000_secret_fixture",
    PADDLE_WEBHOOK_SECRET:"pdl_ntfset_sandbox_secret_fixture",PADDLE_PRODUCT_ID:PRODUCT,PADDLE_PRICE_ID:PRICE,...overrides};
}
function liveEnv(overrides={}){
  return sandboxEnv({NODE_ENV:"production",PADDLE_ENVIRONMENT:"live",PADDLE_CLIENT_TOKEN:"live_01client0000000000000000000",
    PADDLE_API_KEY:"pdl_live_apikey_01fixture000000000000000_secret_fixture",PADDLE_PRODUCT_ID:DEFAULT_PRODUCT_ID,PADDLE_PRICE_ID:LIVE_PRICE,...overrides});
}

test("explicit sandbox config selects isolated Paddle endpoint and exposes only browser-safe config",async()=>{
  const env=sandboxEnv(),config=getPaymentConfig(env),requests=[];
  assert.equal(config.environment,"sandbox");assert.equal(config.enabled,true);
  const transaction=await createPaddleTransaction(config,{userId:"member-1",checkoutId:"claim-1"},async(url,options)=>{
    requests.push({url,options});
    const body=JSON.parse(options.body);
    return {ok:true,json:async()=>({data:{id:TRANSACTION,status:"ready",origin:"api",collection_mode:"automatic",custom_data:body.custom_data,items:[{quantity:1,price:{id:PRICE,product_id:PRODUCT,billing_cycle:{interval:"month",frequency:1},unit_price:{amount:"299",currency_code:"USD"}}}]}})};
  });
  assert.equal(transaction.transactionId,TRANSACTION);
  assert.equal(requests[0].url,`${SANDBOX_API_BASE}/transactions`);
  const input=JSON.parse(requests[0].options.body);
  assert.equal(input.items[0].price_id,PRICE);
  assert.equal(input.custom_data.strata_user_id,"member-1");
  assert.equal(input.custom_data.strata_checkout_id,"claim-1");
  await fetchPaddleTransaction(config,TRANSACTION,async(url)=>{
    assert.equal(url,`${SANDBOX_API_BASE}/transactions/${TRANSACTION}`);
    return {ok:true,json:async()=>({data:{id:TRANSACTION,status:"ready"}})};
  });
  const browser=publicPaymentConfig(config);
  assert.equal(browser.environment,"sandbox");assert.equal(browser.clientToken,env.PADDLE_CLIENT_TOKEN);
  assert.doesNotMatch(JSON.stringify(browser),/pdl_(?:sdbx_apikey|ntfset)_/);
  assert.equal(webhookSecretFor(config),env.PADDLE_WEBHOOK_SECRET);
});

test("sandbox configuration fails closed for mixed credentials, missing catalog, invalid environment, and production",()=>{
  for(const overrides of [
    {PADDLE_CLIENT_TOKEN:liveEnv().PADDLE_CLIENT_TOKEN},{PADDLE_API_KEY:liveEnv().PADDLE_API_KEY},
    {PADDLE_PRODUCT_ID:""},{PADDLE_PRICE_ID:""},{PADDLE_PRODUCT_ID:DEFAULT_PRODUCT_ID},{PADDLE_PRICE_ID:DEFAULT_PRICE_ID},
    {PADDLE_ENVIRONMENT:"sandobx"},{NODE_ENV:"production"}
  ]){
    const config=getPaymentConfig(sandboxEnv(overrides));assert.equal(config.enabled,false);assert.equal(config.configured,false);
  }
  const production=getPaymentConfig(sandboxEnv({NODE_ENV:"production"}));
  assert.equal(production.clientToken,"");assert.equal(webhookSecretFor(production),"");
  const invalid=getPaymentConfig(sandboxEnv({PADDLE_ENVIRONMENT:"sandobx"}));assert.equal(webhookSecretFor(invalid),"");
});

test("live stays the default, requires both current catalog IDs, and rejects sandbox credentials",async()=>{
  const env=liveEnv();delete env.PADDLE_ENVIRONMENT;delete env.PADDLE_PRODUCT_ID;
  const config=getPaymentConfig(env);assert.equal(config.environment,"live");assert.equal(config.enabled,false);assert.equal(config.configured,false);
  assert.equal(config.productId,"");assert.equal(config.priceId,LIVE_PRICE);
  const configured=getPaymentConfig(liveEnv());
  await fetchPaddleTransaction(configured,TRANSACTION,async(url)=>{
    assert.equal(url,`${LIVE_API_BASE}/transactions/${TRANSACTION}`);return {ok:true,json:async()=>({data:{id:TRANSACTION,status:"ready"}})};
  });
  assert.equal(getPaymentConfig(liveEnv({PADDLE_CLIENT_TOKEN:sandboxEnv().PADDLE_CLIENT_TOKEN})).enabled,false);
  assert.equal(getPaymentConfig(liveEnv({PADDLE_API_KEY:sandboxEnv().PADDLE_API_KEY})).enabled,false);
  assert.equal(getPaymentConfig(liveEnv({PADDLE_PRICE_ID:""})).enabled,false);
  assert.equal(getPaymentConfig(liveEnv({PADDLE_PRICE_ID:DEFAULT_PRICE_ID})).enabled,false,"the retired one-time price must fail closed");
  assert.equal(getPaymentConfig(liveEnv({PADDLE_CHECKOUT_ENABLED:"false"})).enabled,false);
  assert.notEqual(webhookSecretFor(getPaymentConfig(liveEnv({PADDLE_CHECKOUT_ENABLED:"false"}))),"","existing payment webhooks remain enabled when new checkout is paused");
});

async function runPricing(config,{environmentApi=true,user={id:"u-1",email:"member@example.test",discovery:{active:false}}}={}){
  const nodes=new Map(),calls=[];
  function node(id){if(!nodes.has(id))nodes.set(id,{id,hidden:false,disabled:false,classList:{toggle(){}},setAttribute(){},addEventListener(){},focus(){},textContent:""});return nodes.get(id);}
  const paddle={Initialize:options=>calls.push(["initialize",options.token]),Checkout:{open(){}}};
  if(environmentApi)paddle.Environment={set:environment=>calls.push(["environment",environment])};
  const context={document:{getElementById:node},navigator:{onLine:true},location:{search:""},window:{addEventListener(){}},
    URLSearchParams,requestAnimationFrame:fn=>fn(),Paddle:paddle,
    fetch:async path=>({ok:true,json:async()=>path==="/api/billing/config"?config:{user,csrfToken:"csrf"}})};
  const source=["entitlements.js","pricing-logic.js","pricing-state.js","pricing-api.js","pricing-render.js","pricing-events.js","pricing.js"]
    .map(name=>readFileSync(join(__dirname,"..","public","scripts",name),"utf8")).join("\n");
  vm.runInNewContext(source,context);
  await new Promise(setImmediate);
  return {calls,nodes};
}

test("pricing sets sandbox before initialization and labels test checkout",async()=>{
  const config=publicPaymentConfig(getPaymentConfig(sandboxEnv()));
  const result=await runPricing(config);
  assert.deepEqual(result.calls,[["environment","sandbox"],["initialize",config.clientToken]]);
  assert.equal(result.nodes.get("buyDiscovery").disabled,false);
  assert.match(result.nodes.get("purchaseStatus").textContent,/TEST MODE/);
  const blocked=await runPricing(config,{environmentApi:false});assert.deepEqual(blocked.calls,[]);assert.equal(blocked.nodes.get("buyDiscovery").disabled,true);
});

test("pricing preserves live behavior and refuses mixed client tokens and sandbox catalogs",async()=>{
  const config=publicPaymentConfig(getPaymentConfig(liveEnv()));
  const live=await runPricing(config);assert.deepEqual(live.calls,[["initialize",config.clientToken]]);
  assert.doesNotMatch(live.nodes.get("purchaseStatus").textContent,/TEST MODE/);
  const replacementProduct=await runPricing({...config,productId:"pro_01differentlivecatalog000000"});
  assert.deepEqual(replacementProduct.calls,[["initialize",config.clientToken]],"the browser must accept the valid live product selected by the server");
  for(const change of [
    {environment:"sandbox"},
    {clientToken:sandboxEnv().PADDLE_CLIENT_TOKEN},
    {productId:"pro_invalid"},
    {priceId:DEFAULT_PRICE_ID},
    {environment:"invalid"}
  ]){
    const blocked=await runPricing({...config,...change});assert.deepEqual(blocked.calls,[]);assert.equal(blocked.nodes.get("buyDiscovery").disabled,true);
  }
});

test("pricing names a scheduled pause and its paid-access boundary",async()=>{
  const config=publicPaymentConfig(getPaymentConfig(liveEnv())),effectiveAt=Date.now()+7*24*60*60*1000;
  const user={id:"u-1",email:"member@example.test",discovery:{active:true,accessType:"paid",subscription:{id:"sub-active",status:"active",active:true,pastDue:false,currentPeriodEndsAt:Date.now()+30*24*60*60*1000,scheduledChange:{action:"pause",effectiveAt}}}};
  const result=await runPricing(config,{user});
  assert.match(result.nodes.get("purchaseStatus").textContent,/remains active until[\s\S]*scheduled pause takes effect and paid access stops/i);
});
