"use strict";

// Linked Google and Apple sign-ins behave the same on SQLite and Turso: single-use sign-in states, account
// creation that never leaves a half-made account, linking only to verified accounts, and the delete trigger that
// queues a sealed Apple token for revocation however the account is deleted.
const test=require("node:test"),assert=require("node:assert/strict");
const {mkdirSync,mkdtempSync,rmSync}=require("node:fs"),{join}=require("node:path");
const {DatabaseSync}=require("node:sqlite");
const {createStore,isUniqueViolation}=require("../src/database");

const ROOT=join(__dirname,".."),NOW=1_800_000_000_000;

function fakeTursoClient(capture){
  const database=new DatabaseSync(":memory:",{enableForeignKeyConstraints:true});capture(database);
  async function execute(statement){
    const sql=typeof statement==="string"?statement:statement.sql,args=typeof statement==="string"?[]:(statement.args||[]),prepared=database.prepare(sql);
    if(/^\s*(?:SELECT|WITH|PRAGMA)\b/i.test(sql)||/\bRETURNING\b/i.test(sql)){
      const objects=prepared.all(...args),columns=prepared.columns().map((column)=>column.name);
      return {columns,rows:objects.map((row)=>columns.map((column)=>row[column])),rowsAffected:objects.length};
    }
    return {columns:[],rows:[],rowsAffected:Number(prepared.run(...args).changes)};
  }
  return {execute,async batch(statements){database.exec("BEGIN IMMEDIATE");try{const results=[];for(const statement of statements)results.push(await execute(statement));database.exec("COMMIT");return results;}catch(error){try{database.exec("ROLLBACK");}catch{/* Keep the statement error. */}throw error;}},close(){database.close();}};
}

async function bothStores(){
  mkdirSync(join(ROOT,"test-runtime"),{recursive:true});
  const directory=mkdtempSync(join(ROOT,"test-runtime","social-store-")),saved={...process.env};
  let local,turso,tursoDatabase;
  try{
    process.env.NODE_ENV="test";process.env.STRATA_DATA_DIR=directory;delete process.env.TURSO_DATABASE_URL;delete process.env.TURSO_AUTH_TOKEN;
    local=await createStore(ROOT);
    delete process.env.STRATA_DATA_DIR;process.env.TURSO_DATABASE_URL="https://social-store.invalid";process.env.TURSO_AUTH_TOKEN="social-store-token";
    turso=await createStore(ROOT,{tursoClientFactory:()=>fakeTursoClient((database)=>{tursoDatabase=database;})});
  }finally{for(const key of ["NODE_ENV","STRATA_DATA_DIR","TURSO_DATABASE_URL","TURSO_AUTH_TOKEN"]){if(saved[key]===undefined)delete process.env[key];else process.env[key]=saved[key];}}
  const localDatabase=()=>new DatabaseSync(join(directory,"strata.sqlite"),{timeout:5000});
  return {
    adapters:[
      {store:local,raw:(callback)=>{const db=localDatabase();try{return callback(db);}finally{db.close();}}},
      {store:turso,raw:(callback)=>callback(tursoDatabase)}
    ],
    async close(){await Promise.all([local.close(),turso.close()]);rmSync(directory,{recursive:true,force:true});}
  };
}

const state=(stateHash,extra={})=>({stateHash,provider:"google",browserHash:"browser-hash",nonce:"nonce",codeVerifier:"verifier",intent:"signup",nextPath:"/planner.html",redirectUri:"https://x.test/auth/social/google/callback",createdAt:NOW,expiresAt:NOW+600_000,...extra});

test("SQLite and Turso keep sign-in states single-use and bound to one browser",{concurrency:false},async()=>{
  const stores=await bothStores();
  try{
    for(const {store} of stores.adapters){
      assert.equal(await store.insertSocialSignInState(state("state-a")),true);
      assert.equal(await store.recordSocialSignInReturn("state-a","apple","code-1",null,NOW+1),null,"another provider cannot return to it");
      assert.deepEqual({...await store.recordSocialSignInReturn("state-a","google","code-1","Ada",NOW+1)},{intent:"signup",next_path:"/planner.html"});
      assert.equal(await store.recordSocialSignInReturn("state-a","google","code-2",null,NOW+2),null,"a state returns once");
      assert.equal(await store.consumeSocialSignInState("state-a","other-browser",NOW+3),null);
      const consumed=await store.consumeSocialSignInState("state-a","browser-hash",NOW+3);
      assert.deepEqual({...consumed},{provider:"google",nonce:"nonce",code_verifier:"verifier",intent:"signup",next_path:"/planner.html",redirect_uri:"https://x.test/auth/social/google/callback",code:"code-1",profile_name:"Ada"});
      assert.equal(await store.consumeSocialSignInState("state-a","browser-hash",NOW+4),null,"and finishes once");

      await store.insertSocialSignInState(state("state-b",{intent:"login",nextPath:"/pricing"}));
      assert.equal(await store.consumeSocialSignInState("state-b","browser-hash",NOW+5),null,"a state that never returned cannot finish");
      assert.deepEqual({...await store.discardSocialSignInState("state-b")},{intent:"login",next_path:"/pricing"});
      await store.insertSocialSignInState(state("state-old",{expiresAt:NOW-1}));
      assert.equal(await store.recordSocialSignInReturn("state-old","google","code",null,NOW),null,"an expired state cannot return");
      await store.deleteExpiredSocialSignInData(NOW,NOW-1);
      assert.equal(await store.discardSocialSignInState("state-old"),null,"cleanup removed it");
    }
  }finally{await stores.close();}
});

test("SQLite and Turso create, link, and delete provider sign-ins the same way",{concurrency:false},async()=>{
  const stores=await bothStores();
  try{
    for(const {store,raw} of stores.adapters){
      const identity={provider:"apple",subject:"apple-sub",userId:"social-user",email:"relay@privaterelay.appleid.com",tokenSealed:"v1.sealed",at:NOW};
      const created=await store.createSocialAccount({id:"social-user",name:"Grace",email:"relay@privaterelay.appleid.com",createdAt:NOW},identity);
      assert.deepEqual({...created},{id:"social-user",name:"Grace",email:"relay@privaterelay.appleid.com",created_at:NOW,email_verified_at:NOW,auth_version:1,suspended_at:null});
      assert.equal((await store.accountIdentity("apple","apple-sub")).id,"social-user");
      assert.deepEqual(await store.accountSignInMethods("social-user"),{hasPassword:false,providers:["apple"]});
      assert.equal(raw((db)=>db.prepare("SELECT password_hash,password_salt FROM users WHERE id='social-user'").get()).password_hash,"");

      await assert.rejects(store.createSocialAccount({id:"duplicate",name:"Copy",email:"RELAY@privaterelay.appleid.com",createdAt:NOW},{...identity,subject:"apple-sub-2",userId:"duplicate"}),(error)=>isUniqueViolation(error));
      assert.equal(raw((db)=>db.prepare("SELECT COUNT(*) AS count FROM users WHERE id='duplicate'").get()).count,0,"a refused sign-in leaves no account behind");

      await store.insertUser({id:"password-user",name:"Linus",email:"linus@example.test",passwordHash:"hash",passwordSalt:"salt",createdAt:NOW});
      const google={provider:"google",subject:"google-sub",userId:"password-user",email:"linus@example.test",tokenSealed:null,at:NOW};
      assert.equal(await store.linkAccountIdentity(google),false,"an unverified account gains no sign-in");
      raw((db)=>db.prepare("UPDATE users SET email_verified_at=? WHERE id='password-user'").run(NOW));
      assert.equal(await store.linkAccountIdentity(google),true);
      assert.equal(await store.linkAccountIdentity({...google,subject:"google-sub-2"}),false,"one Google account per STRATA account");
      assert.deepEqual(await store.accountSignInMethods("password-user"),{hasPassword:true,providers:["google"]});
      assert.equal(await store.touchAccountIdentity({...google,email:"linus@new.example",at:NOW+5}),true);
      assert.deepEqual((await store.accountIdentities("password-user")).map((row)=>({...row})),[{provider:"google",email:"linus@new.example",token_sealed:null,linked_at:NOW,last_used_at:NOW+5}]);

      // However a user is deleted, the trigger removes its sign-ins and queues only sealed tokens for revocation.
      raw((db)=>{db.prepare("DELETE FROM users WHERE id='social-user'").run();db.prepare("DELETE FROM users WHERE id='password-user'").run();});
      assert.equal(raw((db)=>db.prepare("SELECT COUNT(*) AS count FROM account_identities").get()).count,0);
      const queued=await store.pendingSignInRevocations(25);
      assert.deepEqual(queued.map((row)=>[row.provider,row.token_sealed,Number(row.attempts)]),[["apple","v1.sealed",0]]);
      await store.retrySignInRevocation(Number(queued[0].id));
      assert.equal(Number((await store.pendingSignInRevocations(25))[0].attempts),1);
      await store.completeSignInRevocation(Number(queued[0].id));
      assert.deepEqual(await store.pendingSignInRevocations(25),[]);
    }
  }finally{await stores.close();}
});
