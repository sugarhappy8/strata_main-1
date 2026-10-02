// @ts-check
"use strict";

const {SOCIAL_AUTH_SQL}=require("./social-auth-schema");

/** @param {import("./domain-types").SocialSignInStateRecord} record */
const stateArgs=(record)=>[record.stateHash,record.provider,record.browserHash,record.nonce,record.codeVerifier,record.intent,record.nextPath,record.redirectUri,record.createdAt,record.expiresAt];
/** @param {import("./domain-types").AccountIdentityRecord} identity */
const identityArgs=(identity)=>[identity.provider,identity.subject,identity.userId,identity.email,identity.tokenSealed,identity.at,identity.at];
/** @param {import("./domain-types").SocialAccountRecord} account */
const userArgs=(account)=>[account.id,account.name,account.email,account.createdAt,account.createdAt];
/** @param {any} row */
function signInMethods(row){
  if(!row)return null;
  const providers=String(row.providers||"").split(",").filter(Boolean).sort();
  return {hasPassword:Boolean(Number(row.has_password)),providers};
}

/** @param {import("./domain-types").LocalSocialAuthStoreDependencies} dependencies @returns {import("./domain-types").SocialAuthStore} */
function createLocalSocialAuthMethods({db,statements,plainRow}){
  /** @param {string} name */
  const statement=(name)=>{const prepared=statements[name];if(!prepared)throw new Error(`Missing sign-in statement: ${name}`);return prepared;};
  /** @param {string} name @param {unknown[]} args */
  const one=(name,args)=>plainRow(statement(name).get(...args));
  return {
    async insertSocialSignInState(record){return Boolean(one("insertSocialSignInState",stateArgs(record)));},
    async recordSocialSignInReturn(stateHash,provider,code,profileName,now){return one("recordSocialSignInReturn",[code,profileName,now,stateHash,provider,now]);},
    async discardSocialSignInState(stateHash){return one("discardSocialSignInState",[stateHash]);},
    async consumeSocialSignInState(stateHash,browserHash,now){return one("consumeSocialSignInState",[stateHash,browserHash,now]);},
    async accountIdentity(provider,subject){return one("accountIdentity",[provider,subject]);},
    async accountIdentities(userId){return statement("accountIdentities").all(userId).map((row)=>plainRow(row));},
    async accountSignInMethods(userId){return signInMethods(one("accountSignInMethods",[userId]));},
    async linkAccountIdentity(identity){return Boolean(one("linkAccountIdentity",[identity.provider,identity.subject,identity.email,identity.tokenSealed,identity.at,identity.at,identity.userId]));},
    async touchAccountIdentity(identity){return Boolean(one("touchAccountIdentity",[identity.email,identity.tokenSealed,identity.at,identity.provider,identity.subject,identity.userId]));},
    async createSocialAccount(account,identity){
      let open=false;
      try{
        db.exec("BEGIN IMMEDIATE");open=true;
        const user=one("insertSocialUser",userArgs(account));
        statement("insertAccountIdentity").run(...identityArgs(identity));
        db.exec("COMMIT");open=false;
        return user;
      }catch(error){if(open)try{db.exec("ROLLBACK");}catch{/* Keep the original error. */}throw error;}
    },
    async pendingSignInRevocations(limit){return statement("pendingSignInRevocations").all(limit).map((row)=>plainRow(row));},
    async completeSignInRevocation(id){statement("completeSignInRevocation").run(id);},
    async retrySignInRevocation(id){statement("retrySignInRevocation").run(id);},
    async deleteExpiredSocialSignInData(now,staleBefore){statement("deleteExpiredSocialSignInStates").run(now);statement("deleteStaleSignInRevocations").run(staleBefore);}
  };
}

/** @param {import("./domain-types").TursoSocialAuthStoreDependencies} dependencies @returns {import("./domain-types").SocialAuthStore} */
function createTursoSocialAuthMethods({client,first,all,run,plainRow}){
  return {
    async insertSocialSignInState(record){return Boolean(await first(SOCIAL_AUTH_SQL.insertSocialSignInState,stateArgs(record)));},
    recordSocialSignInReturn:(stateHash,provider,code,profileName,now)=>first(SOCIAL_AUTH_SQL.recordSocialSignInReturn,[code,profileName,now,stateHash,provider,now]),
    discardSocialSignInState:(stateHash)=>first(SOCIAL_AUTH_SQL.discardSocialSignInState,[stateHash]),
    consumeSocialSignInState:(stateHash,browserHash,now)=>first(SOCIAL_AUTH_SQL.consumeSocialSignInState,[stateHash,browserHash,now]),
    accountIdentity:(provider,subject)=>first(SOCIAL_AUTH_SQL.accountIdentity,[provider,subject]),
    accountIdentities:(userId)=>all(SOCIAL_AUTH_SQL.accountIdentities,[userId]),
    async accountSignInMethods(userId){return signInMethods(await first(SOCIAL_AUTH_SQL.accountSignInMethods,[userId]));},
    async linkAccountIdentity(identity){return Boolean(await first(SOCIAL_AUTH_SQL.linkAccountIdentity,[identity.provider,identity.subject,identity.email,identity.tokenSealed,identity.at,identity.at,identity.userId]));},
    async touchAccountIdentity(identity){return Boolean(await first(SOCIAL_AUTH_SQL.touchAccountIdentity,[identity.email,identity.tokenSealed,identity.at,identity.provider,identity.subject,identity.userId]));},
    async createSocialAccount(account,identity){
      // A Turso batch is one transaction: the account never exists without the sign-in that created it.
      const results=await client.batch([{sql:SOCIAL_AUTH_SQL.insertSocialUser,args:userArgs(account)},{sql:SOCIAL_AUTH_SQL.insertAccountIdentity,args:identityArgs(identity)}],"write");
      return plainRow(results[0]?.rows?.[0],results[0]?.columns);
    },
    pendingSignInRevocations:(limit)=>all(SOCIAL_AUTH_SQL.pendingSignInRevocations,[limit]),
    async completeSignInRevocation(id){await run(SOCIAL_AUTH_SQL.completeSignInRevocation,[id]);},
    async retrySignInRevocation(id){await run(SOCIAL_AUTH_SQL.retrySignInRevocation,[id]);},
    async deleteExpiredSocialSignInData(now,staleBefore){
      await client.batch([{sql:SOCIAL_AUTH_SQL.deleteExpiredSocialSignInStates,args:[now]},{sql:SOCIAL_AUTH_SQL.deleteStaleSignInRevocations,args:[staleBefore]}],"write");
    }
  };
}

module.exports={createLocalSocialAuthMethods,createTursoSocialAuthMethods};
