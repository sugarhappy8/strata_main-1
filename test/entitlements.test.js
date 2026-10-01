"use strict";

const test=require("node:test");
const assert=require("node:assert/strict");
const server=require("../src/entitlements");
const browser=require("../public/scripts/entitlements");

test("the tier table is the single source of what free and Strata+ members may use",()=>{
  assert.deepEqual(Object.entries(server.FEATURES).filter(([,tier])=>tier==="free").map(([name])=>name),["rankings","plan.week","profile.basic","account"]);
  assert.deepEqual(Object.keys(server.FEATURES).filter((name)=>name.startsWith("plus.")),browser.PLUS_FEATURES);
  assert.deepEqual(Object.keys(server.FEATURES).filter((name)=>!name.startsWith("plus.")),browser.FREE_FEATURES);
  assert.equal(server.tierFor("plus.ai"),"plus");
  assert.equal(server.tierFor("plus.ai",server.entitlementSettings({STRATA_AI_TIER:"off"})),"off");
  assert.equal(server.tierFor("plus.ai",server.entitlementSettings({STRATA_AI_TIER:"nonsense"})),"plus","an unknown switch value keeps the default");
  assert.equal(server.tierFor("made.up"),null);
});

test("capabilities follow Strata+ state and the AI switch, and can() reads only the map",()=>{
  const free=server.capabilitiesFor({plusActive:false}),plus=server.capabilitiesFor({plusActive:true});
  assert.equal(free["plan.week"],true);assert.equal(free["plus.studio"],false);assert.equal(free["plus.ai"],false);
  assert.equal(plus["plus.studio"],true);assert.equal(plus["plus.ai"],true);assert.equal(plus.rankings,true);
  assert.ok(Object.isFrozen(plus));
  const aiOff=server.capabilitiesFor({plusActive:true},server.entitlementSettings({STRATA_AI_TIER:"off"}));
  assert.equal(aiOff["plus.ai"],false);assert.equal(aiOff["plus.recovery"],true,"switching AI off touches nothing else");
  assert.equal(server.can({capabilities:plus},"plus.train"),true);
  assert.equal(server.can({capabilities:free},"plus.train"),false);
  assert.equal(server.can({capabilities:plus},"made.up"),false,"unknown features are never granted");
  assert.equal(server.can(null,"rankings"),false,"the server never guesses without a map");
});

test("the browser helper trusts the server map and falls back for payloads from older builds",()=>{
  const plus={capabilities:server.capabilitiesFor({plusActive:true})},free={capabilities:server.capabilitiesFor({plusActive:false})};
  assert.equal(browser.can(plus,"plus.recovery"),true);assert.equal(browser.hasPlus(plus),true);
  assert.equal(browser.can(free,"plus.recovery"),false);assert.equal(browser.hasPlus(free),false);
  assert.equal(browser.can({capabilities:{...plus.capabilities,"plus.ai":false}},"plus.ai"),false,"a switched-off feature stays off even for Strata+");
  assert.equal(browser.can(null,"rankings"),true,"free features need no account");
  assert.equal(browser.can(null,"plus.studio"),false);
  assert.equal(browser.can({discovery:{active:true}},"plus.studio"),true,"a cached payload without the map uses the Strata+ flag");
  assert.equal(browser.can({discovery:{active:false}},"plus.studio"),false);
  assert.equal(browser.can({discovery:{active:true}},"made.up"),false);
});

test("upgrade lines come from one table, and unknown reasons stay quiet",()=>{
  assert.equal(browser.upsell("ai"),"Strata AI is included with Strata+.");
  assert.match(browser.upsell("recovery"),/^Recovery, with your Polar sleep and Nightly Recharge, is part of Strata\+\.$/);
  assert.equal(browser.upsell("access"),browser.upsell("discovery-required"));
  for(const reason of [null,undefined,"","toString","__proto__","made-up"])assert.equal(browser.upsell(reason),"",String(reason));
});
