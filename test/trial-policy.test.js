"use strict";
const test=require("node:test");
const assert=require("node:assert/strict");
const {discoveryTrialState}=require("../src/billing");
const {STRATA_PLUS_TRIAL_MS}=require("../src/payments");
const start=Date.UTC(2026,8,9),week=7*24*60*60*1000;

test("a trial started before the retirement expires exactly at seven days",()=>{
  assert.equal(STRATA_PLUS_TRIAL_MS,week);
  const row={started_at:start,expires_at:start+week};
  assert.equal(discoveryTrialState(row,start+3*24*60*60*1000).active,true);
  assert.equal(discoveryTrialState(row,start+week-1).active,true);
  assert.equal(discoveryTrialState(row,start+week).active,false);
  assert.equal(discoveryTrialState(row,start+week).eligible,false);
});

test("older 30-minute trials keep their recorded expiry and cannot restart",()=>{
  const row={started_at:start,expires_at:start+30*60*1000};
  assert.equal(discoveryTrialState(row,start+29*60*1000).active,true);
  const expired=discoveryTrialState(row,start+30*60*1000);
  assert.equal(expired.active,false);
  assert.equal(expired.eligible,false);
  assert.equal(expired.expiresAt,row.expires_at);
});

test("stored trial rows never grant more than the seven-day server maximum",()=>{
  const bounded=discoveryTrialState({started_at:start,expires_at:start+365*24*60*60*1000},start);
  assert.equal(bounded.expiresAt,start+week);
  assert.equal(discoveryTrialState({started_at:"invalid",expires_at:start+week},start).active,false);
  assert.equal(discoveryTrialState(null,start).eligible,false,"no account can start a new trial");
  assert.equal(discoveryTrialState(null,start).active,false);
});
