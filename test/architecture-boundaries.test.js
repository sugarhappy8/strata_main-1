"use strict";

const test=require("node:test");
const assert=require("node:assert/strict");
const {mkdirSync,mkdtempSync,readFileSync,rmSync,writeFileSync}=require("node:fs");
const {tmpdir}=require("node:os");
const {join}=require("node:path");
const {analyzeArchitecture,dependencyCycles,loadPolicy,localDependencies,markdownReport,moduleReferences,sourceFiles,validateArchitecture}=require("../scripts/architecture-report");

test("server modules stay within reviewed size and dependency boundaries",()=>{
  const modules=analyzeArchitecture(),policy=loadPolicy();
  assert.deepEqual(validateArchitecture(modules,policy),[]);
  assert.deepEqual(dependencyCycles(modules),[]);
  const documentation=readFileSync(join(__dirname,"..","docs","module-architecture.md"),"utf8");
  assert.ok(documentation.includes(markdownReport(modules,policy)),"documented module metrics must match the live report");
});

test("domain services do not reach into the composition root or database adapter",()=>{
  const byFile=new Map(analyzeArchitecture().map((entry)=>[entry.file,entry]));
  for(const file of ["src/auth.js","src/admin.js","src/support.js","src/setup.js","src/product-signals.js","src/training.js","src/coaching.js","src/data-service.js","src/training-log.js","src/daily-snapshot.js"]){
    assert.ok(!byFile.get(file).dependencies.includes("src/server.js"));
    assert.ok(!byFile.get(file).dependencies.includes("src/database.js"));
  }
  assert.deepEqual(byFile.get("src/database.js").dependencies,["src/access-controls-store.js","src/account-self-service-store.js","src/ai-store.js","src/apple-billing-store.js","src/billing-store.js","src/coaching-store.js","src/data-layer-store.js","src/devices-store.js","src/migrations.js","src/schema.js","src/server-state-store.js","src/social-auth-store.js","src/store-contract.js","src/training-loop-store.js"]);
});

test("dependency analysis covers import calls and rejects computed module loading",()=>{
  assert.deepEqual(localDependencies('async function load(){return import("./database.js");}',"src/auth.js"),["src/database.js"]);
  assert.deepEqual(moduleReferences('const message="require(variable)"; /* import(path) */').unsafe,[]);
  assert.match(moduleReferences("const dependency='./database'; require(dependency);","src/auth.js").unsafe[0],/require must use exactly one string literal/);
  assert.match(moduleReferences("async function load(path){return import(path);}","src/auth.js").unsafe[0],/import must use exactly one string literal/);
  for(const source of [
    'const load=require; load("./database");',
    'module.require("./database");',
    '(0,require)("./database");',
    'const {createRequire}=require("node:module"); createRequire(import.meta.url)("./database");',
    'module["require"]("./database");',
    'module[`require`]("./database");',
    'module["requ"+"ire"]("./database");',
    'module[key]("./database");',
    'const load=module["require"].bind(module); load("./database");',
    'require("node:module")["createRequire"](import.meta.url)("./database");',
    'require("node:module")["create"+"Require"](import.meta.url)("./database");'
  ])assert.ok(moduleReferences(source,"src/auth.js").unsafe.length>0,source);
});

test("architecture inventory includes nested server JavaScript",t=>{
  const root=mkdtempSync(join(tmpdir(),"strata-architecture-"));
  t.after(()=>rmSync(root,{recursive:true,force:true}));
  mkdirSync(join(root,"src","nested"),{recursive:true});
  writeFileSync(join(root,"server.js"),'require("./src/entry");\n');
  writeFileSync(join(root,"src","entry.js"),'require("./nested/worker");\n');
  writeFileSync(join(root,"src","nested","worker.js"),'"use strict";\n');
  assert.deepEqual(sourceFiles(root),["server.js","src/entry.js","src/nested/worker.js"]);
});
