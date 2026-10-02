"use strict";

const test=require("node:test");
const assert=require("node:assert/strict");
const { readFileSync }=require("node:fs");
const { join }=require("node:path");
const { STORE_METHODS,defineStore }=require("../src/store-contract");

test("database adapters share one explicit store contract",()=>{
  assert.ok(Object.isFrozen(STORE_METHODS));
  assert.equal(new Set(STORE_METHODS).size,STORE_METHODS.length,"store methods must be unique");

  const methods=Object.fromEntries(STORE_METHODS.map((name) => [name,()=>{}]));
  const store=defineStore("test",methods);
  assert.equal(store.kind,"test");
  assert.deepEqual(Object.keys(store).slice(1),STORE_METHODS);

  assert.throws(
    () => defineStore("incomplete",{...methods,close:null}),
    /incomplete store contract mismatch \(missing or invalid: close\)/
  );
  assert.throws(
    () => defineStore("expanded",{...methods,extra:()=>{}}),
    /expanded store contract mismatch \(unexpected: extra\)/
  );

  const source=readFileSync(join(__dirname,"..","src","database.js"),"utf8");
  assert.match(source,/return\s*defineStore\s*\(\s*"local"\s*,\s*\{/);
  assert.match(source,/return\s*defineStore\s*\(\s*"turso"\s*,\s*\{/);
});
