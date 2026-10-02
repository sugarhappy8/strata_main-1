"use strict";

const test=require("node:test");
const assert=require("node:assert/strict");
const fs=require("node:fs");
const path=require("node:path");

const PROJECT_ROOT=path.resolve(__dirname,"..");
const html=fs.readFileSync(path.join(PROJECT_ROOT,"public","pages","reviews.html"),"utf8");
const visible=html.replace(/<script[\s\S]*?<\/script>/gi," ").replace(/<style[\s\S]*?<\/style>/gi," ").replace(/<[^>]+>/g," ").replace(/\s+/g," ").trim();

test("review page publishes accurate Strata+ terms and neutral review rules",()=>{
  assert.match(visible,/7-day Strata\+ trial without a payment card/i);
  assert.match(visible,/trial never converts automatically/i);
  assert.match(visible,/\$2\.99 USD per month/i);
  assert.match(visible,/Positive, mixed, and critical feedback are equally welcome/i);
  assert.match(visible,/does not offer money, discounts, gifts, free paid access/i);
  assert.match(visible,/not published as a testimonial without separate, specific permission/i);
});

test("review page never presents an unverified external listing as official",()=>{
  for(const platform of ["Trustpilot","SmartCustomer","Product Hunt","SaaSHub"]) assert.match(visible,new RegExp(platform));
  assert.match(visible,/External profiles are being claimed and verified/i);
  assert.match(visible,/only after STRATA controls the destination/i);
  assert.doesNotMatch(html,/href="https?:\/\//i);
});
