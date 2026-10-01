"use strict";

const test=require("node:test");
const assert=require("node:assert/strict");
const fs=require("node:fs");
const os=require("node:os");
const path=require("node:path");

const {
  DEFAULT_MANIFEST,
  ReleaseVersionError,
  auditRelease,
  parseArguments,
  baseVersionFor,
  packageBuild,
  runRelease,
  validateVersion
}=require("../scripts/release-version");

test("the release manifest covers every versioned offline-workout surface",()=>{
  for(const relative of ["public/pages/workout-offline.html","public/scripts/workout-offline.js","test/workout-offline.test.js"]){
    assert.ok(DEFAULT_MANIFEST.textFiles.includes(relative),`${relative} must advance with the public build`);
  }
});

const FIXTURE_MANIFEST={
  textFiles:["README.md","public/page.html"],
  readmeFiles:["README.md"]
};

function write(root,relative,content){
  const file=path.join(root,relative);
  fs.mkdirSync(path.dirname(file),{recursive:true});
  fs.writeFileSync(file,content,"utf8");
}

function makeFixture(version="1.2.3"){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),"strata-release-version-"));
  const packageVersion=baseVersionFor(version);
  const packageJson={name:"fixture",version:packageVersion,...(version===packageVersion?{}:{strataBuild:version})};
  write(root,"package.json",`${JSON.stringify(packageJson,null,2)}\n`);
  write(root,"package-lock.json",`${JSON.stringify({name:"fixture",version:packageVersion,lockfileVersion:3,packages:{"":{name:"fixture",version:packageVersion}}},null,2)}\n`);
  write(root,"README.md",[
    `STRATA fixture. Build ${version} is the current release.`,
    `**Build ${version} is a deterministic test release.**`,
    `Build ${version} separates browser files from private code.`,
    `Build ${version} has public pages.`,
    `[Release guide](docs/release-${version}.md).`,
    "Build 1.0.0 remains historical."
  ].join("\n"));
  write(root,"public/page.html",`<link href="/app.css?v=${version}"><p>Build ${version}</p>\n`);
  for(const relative of ["node_modules/dependency/version.txt",".git/internal-version","data/private-version.txt"]){
    write(root,relative,`private ${version}\n`);
  }
  return root;
}

test("release versions require strict x.y.z values with an optional three-digit build revision",()=>{
  for(const valid of ["0.0.0","1.2.3","10.20.300","1.2.3.000","6.9.9.007"])assert.equal(validateVersion(valid),valid);
  for(const invalid of [null,"","1.2","v1.2.3","01.2.3","1.02.3","1.2.3-beta","1.2.3.4","1.2.3.0007"]){
    assert.throws(()=>validateVersion(invalid),ReleaseVersionError);
  }
  assert.equal(baseVersionFor("6.9.9.007"),"6.9.9");
  assert.equal(packageBuild({version:"6.9.9",strataBuild:"6.9.9.007"}),"6.9.9.007");
  assert.throws(()=>packageBuild({version:"6.9.8",strataBuild:"6.9.9.007"}),/does not belong/);
  for(const strataBuild of ["",null,false,0]){
    assert.throws(()=>packageBuild({version:"6.9.9",strataBuild}),/package\.json STRATA build must use strict/);
  }
  assert.deepEqual(parseArguments(["--check"]),{check:true,dryRun:false,target:null,help:false});
  assert.deepEqual(parseArguments(["--dry-run","2.0.0"]),{check:false,dryRun:true,target:"2.0.0",help:false});
  assert.throws(()=>parseArguments(["--check","2.0.0"]),/--check must be used by itself/);
});

test("zero-padded build revisions preserve npm-compatible package metadata",t=>{
  const root=makeFixture();
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  fs.appendFileSync(path.join(root,"README.md"),"\nCandidate 1.2.3.007 must not become a doubled build.\n","utf8");

  runRelease({root,target:"1.2.3.007",manifest:FIXTURE_MANIFEST,logger:{log(){}}});
  let pkg=JSON.parse(fs.readFileSync(path.join(root,"package.json"),"utf8"));
  let lock=JSON.parse(fs.readFileSync(path.join(root,"package-lock.json"),"utf8"));
  assert.equal(pkg.version,"1.2.3");
  assert.equal(pkg.strataBuild,"1.2.3.007");
  assert.equal(lock.version,"1.2.3");
  assert.equal(lock.packages[""].version,"1.2.3");
  assert.match(fs.readFileSync(path.join(root,"README.md"),"utf8"),/Candidate 1\.2\.3\.007 must not become a doubled build/);
  assert.doesNotMatch(fs.readFileSync(path.join(root,"README.md"),"utf8"),/1\.2\.3\.007\.007/);
  assert.doesNotThrow(()=>auditRelease(root,"1.2.3.007",FIXTURE_MANIFEST));

  const dryRunOutput=[];
  const dryRun=runRelease({root,target:"1.2.3.008",dryRun:true,manifest:FIXTURE_MANIFEST,logger:{log(line){dryRunOutput.push(line);}}});
  assert.equal(dryRun.plans.some(({relative})=>relative==="package-lock.json"),false,"same-base revisions must not report an unchanged lockfile");
  assert.doesNotMatch(dryRunOutput.join("\n"),/package-lock\.json/);
  runRelease({root,target:"1.2.3.008",manifest:FIXTURE_MANIFEST,logger:{log(){}}});
  pkg=JSON.parse(fs.readFileSync(path.join(root,"package.json"),"utf8"));
  lock=JSON.parse(fs.readFileSync(path.join(root,"package-lock.json"),"utf8"));
  assert.equal(pkg.version,"1.2.3");
  assert.equal(pkg.strataBuild,"1.2.3.008");
  assert.equal(lock.version,"1.2.3");
  assert.match(fs.readFileSync(path.join(root,"public/page.html"),"utf8"),/v=1\.2\.3\.008[\s\S]*Build 1\.2\.3\.008/);
});

test("release checks require every current README anchor",t=>{
  const root=makeFixture();
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const readmePath=path.join(root,"README.md");
  fs.writeFileSync(readmePath,fs.readFileSync(readmePath,"utf8").replace(
    "**Build 1.2.3 is a deterministic test release.**",
    "**Build 1.2.3 makes a deterministic test release.**"
  ),"utf8");
  assert.throws(
    ()=>auditRelease(root,"1.2.3",FIXTURE_MANIFEST),
    /README\.md is missing its README release heading release-version marker/
  );
});

test("release checks identify exact drift before any write",t=>{
  const root=makeFixture();
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  write(root,"public/page.html",'<link href="/app.css?v=1.2.2"><p>Build 1.2.3</p>\n');
  assert.throws(
    ()=>runRelease({root,target:"1.2.4",dryRun:true,manifest:FIXTURE_MANIFEST,logger:{log(){}}}),
    error=>{
      assert.match(error.message,/Release version drift detected/);
      assert.match(error.message,/public\/page\.html:1 asset version is 1\.2\.2; expected 1\.2\.3 from package\.json/);
      return true;
    }
  );
  assert.equal(JSON.parse(fs.readFileSync(path.join(root,"package.json"),"utf8")).version,"1.2.3");
});

test("release checks reject malformed public version suffixes",t=>{
  const root=makeFixture();
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  write(root,"public/page.html",'<link href="/app.css?v=1.2.3+oops"><script>const BUILD="1.2.3-beta"</script><p>Build 1.2.3garbage</p>\n');
  assert.throws(
    ()=>auditRelease(root,"1.2.3",FIXTURE_MANIFEST),
    error=>{
      assert.match(error.message,/asset version is 1\.2\.3\+oops; expected 1\.2\.3/);
      assert.match(error.message,/build constant is 1\.2\.3-beta; expected 1\.2\.3/);
      assert.match(error.message,/build label is 1\.2\.3garbage; expected 1\.2\.3/);
      return true;
    }
  );
  for(const suffix of ["%2E008","/oops"]){
    write(root,"public/page.html",`<link href="/app.css?v=1.2.3${suffix}"><p>Build 1.2.3</p>\n`);
    assert.throws(
      ()=>auditRelease(root,"1.2.3",FIXTURE_MANIFEST),
      error=>{
        assert.match(error.message,new RegExp(`asset version is 1\\.2\\.3${suffix.replace(/[.*+?^${}()|[\]\\]/g,"\\$&")}; expected 1\\.2\\.3`));
        return true;
      }
    );
  }
});

test("dry runs report the allowlisted plan without touching any file",t=>{
  const root=makeFixture();
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const before=new Map([
    "package.json","package-lock.json","README.md","public/page.html",
    "node_modules/dependency/version.txt",".git/internal-version","data/private-version.txt"
  ].map(relative=>[relative,fs.readFileSync(path.join(root,relative),"utf8")]));
  const output=[];
  const result=runRelease({root,target:"1.2.4",dryRun:true,manifest:FIXTURE_MANIFEST,logger:{log(line){output.push(line);}}});
  assert.equal(result.changed,false);
  assert.equal(result.dryRun,true);
  assert.match(output.join("\n"),/No files written/);
  for(const [relative,content] of before){
    assert.equal(fs.readFileSync(path.join(root,relative),"utf8"),content,`${relative} must remain unchanged`);
  }
});

test("updates advance only explicit release files and preserve excluded trees",t=>{
  const root=makeFixture();
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const excluded=["node_modules/dependency/version.txt",".git/internal-version","data/private-version.txt"];
  const result=runRelease({root,target:"1.2.4",manifest:FIXTURE_MANIFEST,logger:{log(){}}});
  assert.equal(result.changed,true);
  assert.equal(JSON.parse(fs.readFileSync(path.join(root,"package.json"),"utf8")).version,"1.2.4");
  const lock=JSON.parse(fs.readFileSync(path.join(root,"package-lock.json"),"utf8"));
  assert.equal(lock.version,"1.2.4");
  assert.equal(lock.packages[""].version,"1.2.4");
  assert.match(fs.readFileSync(path.join(root,"public/page.html"),"utf8"),/v=1\.2\.4[\s\S]*Build 1\.2\.4/);
  const readme=fs.readFileSync(path.join(root,"README.md"),"utf8");
  assert.match(readme,/Build 1\.2\.4 is the current release/);
  assert.match(readme,/docs\/release-1\.2\.4\.md/);
  assert.match(readme,/Build 1\.0\.0 remains historical/);
  for(const relative of excluded)assert.equal(fs.readFileSync(path.join(root,relative),"utf8"),"private 1.2.3\n");
  assert.doesNotThrow(()=>auditRelease(root,"1.2.4",FIXTURE_MANIFEST));
});

test("a changelog entry for a build the version markers do not carry fails the release check until the bump",t=>{
  const root=makeFixture();
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const manifest={...FIXTURE_MANIFEST,changelog:"CHANGELOG.md"};
  assert.equal(DEFAULT_MANIFEST.changelog,"CHANGELOG.md");
  write(root,"CHANGELOG.md","# Changelog\n\n## 1.2.3 — Current\n\n- Shipped.\n");
  assert.equal(auditRelease(root,"1.2.3",manifest).filesChecked,5);
  write(root,"CHANGELOG.md","# Changelog\n\n## Unreleased\n\n## 1.2.4 — Next\n\n- Written before the bump.\n\n## 1.2.3 — Current\n");
  assert.throws(()=>runRelease({root,check:true,manifest,logger:{log(){}}}),/CHANGELOG\.md describes 1\.2\.4 as the newest build, but package\.json is 1\.2\.3; run the release version tool for 1\.2\.4/);
  runRelease({root,target:"1.2.4",manifest,logger:{log(){}}});
  assert.doesNotThrow(()=>runRelease({root,check:true,manifest,logger:{log(){}}}),"the bump that carries the entry passes");
  write(root,"CHANGELOG.md","# Changelog\n");
  assert.throws(()=>auditRelease(root,"1.2.4",manifest),/describes no release as the newest build/);
});
