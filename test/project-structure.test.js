"use strict";

const test=require("node:test");
const assert=require("node:assert/strict");
const {existsSync,readdirSync,readFileSync}=require("node:fs");
const {extname,join,relative,sep}=require("node:path");

const PROJECT_ROOT=join(__dirname,"..");
const PUBLIC_ROOT=join(PROJECT_ROOT,"public");
const SRC_ROOT=join(PROJECT_ROOT,"src");
const slash=(value)=>value.split(sep).join("/");

function walk(directory){
  const files=[];
  for(const entry of readdirSync(directory,{withFileTypes:true})){
    const absolute=join(directory,entry.name);
    assert.equal(entry.isSymbolicLink(),false,`${slash(relative(PROJECT_ROOT,absolute))} must not be a symlink`);
    if(entry.isDirectory())files.push(...walk(absolute));
    else files.push(absolute);
  }
  return files;
}

test("keeps root, private server, and public browser files separated",()=>{
  for(const required of [
    "server.js","src/server.js","src/account-export.js","src/account-self-service.js","src/account-self-service-schema.js","src/account-self-service-store.js","src/admin.js","src/admin-mfa.js","src/auth.js","src/billing-store.js","src/database.js","src/domain-types.d.ts","src/email.js","src/http.js","src/legacy-checkout.js","src/paddle-catalog.js","src/paddle-checkout-retirement.js","src/paddle-webhooks.js","src/payments.js","src/plans.d.ts","src/plans.js","src/product-signals-schema.js","src/product-signals.js","src/progression.js","src/schema.js","src/service-composition.js","src/setup.js","src/store-contract.js","src/support.js","src/training-loop-schema.js","src/training-loop-store.js","src/training.js","src/workouts.d.ts",
    "src/data/discovery-data.json","public/pages/index.html","public/pages/forgot-password.html",
    "public/pages/reset-password.html","public/pages/delete-account.html",
    "public/pages/admin.html","public/scripts/admin.js","public/styles/admin.css",
    "public/scripts/app.js","public/scripts/account-recovery.js","public/styles/styles.css",
    "public/data/exercises.json","public/fonts/manrope-latin.woff2","public/fonts/dm-mono-400-latin.woff2","public/fonts/dm-mono-500-latin.woff2","public/images/strata-layers.jpg","public/images/hero-training.jpg","public/images/training-story.jpg","public/styles/fonts.css","public/service-worker.js","public/manifest.webmanifest"
  ])assert.ok(existsSync(join(PROJECT_ROOT,required)),`${required} must exist`);

  assert.deepEqual(readdirSync(PUBLIC_ROOT).sort(),[
    "data","fonts","icons","images","manifest.webmanifest","pages","scripts","service-worker.js","styles"
  ]);
  assert.deepEqual(readdirSync(SRC_ROOT).sort(),["access-controls-schema.js","access-controls-store.js","access-controls.js","account-export.js","account-self-service-schema.js","account-self-service-store.js","account-self-service.js","admin-mfa.js","admin-user-actions.js","admin.js","ai-catalog.js","ai-core.js","ai-provider.js","ai.js","auth.js","billing-schema.js","billing-store.js","billing.js","checkout-reconciliation.js","coaching-core.js","coaching-evidence.js","coaching-prescription-core.js","coaching-schema.js","coaching-store.js","coaching-training-core.js","coaching.js","data","database.js","domain-types.d.ts","email.js","energy-activity-core.js","energy-calibration-core.js","energy-planning-core.js","energy-scenarios-core.js","http.js","legacy-checkout.js","meal-planning-core.js","migrations.js","observability.js","paddle-catalog.js","paddle-checkout-retirement.js","paddle-subscriptions.js","paddle-webhooks.js","payments.js","plans.d.ts","plans.js","product-signals-schema.js","product-signals.js","progression.js","schema.js","server.js","service-composition.js","setup.js","static-assets.js","store-contract.js","support.js","training-loop-schema.js","training-loop-store.js","training.js","workouts.d.ts","workouts.js"]);

  const rootFiles=readdirSync(PROJECT_ROOT,{withFileTypes:true}).filter((entry)=>entry.isFile()).map((entry)=>entry.name);
  assert.deepEqual(rootFiles.filter((name)=>name.endsWith(".js")).sort(),["server.js"]);
  assert.deepEqual(rootFiles.filter((name)=>/\.(?:html|css|webmanifest|jpe?g|png|svg)$/.test(name)),[]);
  assert.deepEqual(walk(SRC_ROOT).map((file)=>slash(relative(SRC_ROOT,file))).filter((name)=>/\.(?:html|css|webmanifest|jpe?g|png|svg)$/.test(name)),[]);
  assert.match(readFileSync(join(PROJECT_ROOT,"server.js"),"utf8"),/require\("\.\/src\/server"\);/);
});

test("keeps credentials, databases, and private modules out of public",()=>{
  const allowedExtensions=new Set([".html",".css",".js",".json",".webmanifest",".svg",".png",".jpg",".jpeg",".woff2"]);
  const forbiddenNames=new Set(["server.js","auth.js","database.js","email.js","http.js","payments.js","plans.js","progression.js","schema.js","service-composition.js","store-contract.js","support.js","training-loop-schema.js","training-loop-store.js","training.js","workouts.js","discovery-data.json","render.yaml","package.json","package-lock.json"]);
  const textExtensions=new Set([".html",".css",".js",".json",".webmanifest",".svg"]);

  for(const file of walk(PUBLIC_ROOT)){
    const name=slash(relative(PUBLIC_ROOT,file)),base=name.split("/").at(-1),extension=extname(base).toLowerCase();
    assert.ok(allowedExtensions.has(extension),`${name} has an unexpected public file type`);
    assert.ok(!forbiddenNames.has(base),`${name} is server-only`);
    assert.doesNotMatch(name,/(?:^|\/)(?:\.env(?:\..*)?|data\/.*\.(?:sqlite(?:-(?:shm|wal))?|db)|.*\.(?:pem|key))$/i);
    if(textExtensions.has(extension)){
      const body=readFileSync(file,"utf8");
      assert.doesNotMatch(body,/\b(?:ADMIN_EMAIL|SUPPORT_EMAIL|PADDLE_API_KEY|PADDLE_WEBHOOK_SECRET|TURSO_AUTH_TOKEN|TURSO_DATABASE_URL|STRATA_DATA_DIR|RESEND_API_KEY|EMAIL_VERIFICATION_SECRET)\b/,`${name} references a server-only environment variable`);
      assert.doesNotMatch(body,/pdl_(?:live|sandbox|sdbx)_apikey_[A-Za-z0-9_-]{16,}|pdl_ntfset_[A-Za-z0-9_-]{16,}/i,`${name} contains a Paddle secret`);
      assert.doesNotMatch(body,/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,`${name} contains a private key`);
    }
  }
});

test("serves only explicitly mapped files from the public tree",()=>{
  const source=readFileSync(join(SRC_ROOT,"server.js"),"utf8");
  const block=source.match(/const STATIC_FILES = new Map\(\[([\s\S]*?)\]\);\nconst PAGE_ALIASES/);
  assert.ok(block,"src/server.js must declare a literal STATIC_FILES allowlist");
  const targets=[...block[1].matchAll(/\[\s*"[^"]+"\s*,\s*"([^"]+)"\s*\]/g)].map((match)=>match[1]).sort();
  const publicFiles=walk(PUBLIC_ROOT).map((file)=>slash(relative(PUBLIC_ROOT,file))).sort();
  assert.deepEqual(targets,publicFiles,"every public file must be explicitly mapped, with no unmapped clutter");
  assert.match(source,/if \(!STATIC_FILES\.has\(requested\)\) \{ json\(res,404,/);
  assert.match(source,/const publicFile=STATIC_FILES\.get\(requested\);[\s\S]*?join\(PUBLIC_ROOT,publicFile\)/);
  assert.doesNotMatch(source,/join\(PROJECT_ROOT,\s*(?:requested|url\.pathname)/);
});
