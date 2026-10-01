// @ts-check
"use strict";

const {AI_SQL}=require("./ai-schema");

/** @param {{statements:Record<string,import("./domain-types").PreparedStatementLike>,plainRow:(row:any)=>any}} dependencies @returns {import("./domain-types").AiStore} */
function createLocalAiMethods({statements,plainRow}){
  /** @param {string} name */
  const statement=(name)=>{const prepared=statements[name];if(!prepared)throw new Error(`Missing Strata AI statement: ${name}`);return prepared;};
  return {
    async aiSettings(userId){return plainRow(statement("aiSettings").get(userId));},
    async upsertAiSettings(userId,settings){return plainRow(statement("upsertAiSettings").get(settings.consentAt,settings.consentVersion,settings.dailyBrief?1:0,settings.updatedAt,userId));},
    async briefCandidates(limit,offset){return statement("briefCandidates").all(limit,offset).map((row)=>plainRow(row));},
    async aiUsage(date,scope){return statement("aiUsage").all(date,scope).map((row)=>plainRow(row));},
    async addAiUsage(date,scope,kind,requests,tokens){statement("addAiUsage").run(date,scope,kind,requests,tokens);},
    async refundAiUsage(date,scope,kind){statement("refundAiUsage").run(date,scope,kind);},
    async aiUsageTotals(date){return statement("aiUsageTotals").all(date).map((row)=>plainRow(row));},
    async aiUsageTop(date,limit){return statement("aiUsageTop").all(date,limit).map((row)=>plainRow(row));},
    async deleteOldAiUsage(beforeDate){statement("deleteOldAiUsage").run(beforeDate);}
  };
}

/** @param {{first:(sql:string,args:any[])=>Promise<any>,all:(sql:string,args:any[])=>Promise<any[]>,run:(sql:string,args:any[])=>Promise<any>}} dependencies @returns {import("./domain-types").AiStore} */
function createTursoAiMethods({first,all,run}){
  return {
    aiSettings:(userId)=>first(AI_SQL.aiSettings,[userId]),
    upsertAiSettings:(userId,settings)=>first(AI_SQL.upsertAiSettings,[settings.consentAt,settings.consentVersion,settings.dailyBrief?1:0,settings.updatedAt,userId]),
    briefCandidates:(limit,offset)=>all(AI_SQL.briefCandidates,[limit,offset]),
    aiUsage:(date,scope)=>all(AI_SQL.aiUsage,[date,scope]),
    async addAiUsage(date,scope,kind,requests,tokens){await run(AI_SQL.addAiUsage,[date,scope,kind,requests,tokens]);},
    async refundAiUsage(date,scope,kind){await run(AI_SQL.refundAiUsage,[date,scope,kind]);},
    aiUsageTotals:(date)=>all(AI_SQL.aiUsageTotals,[date]),
    aiUsageTop:(date,limit)=>all(AI_SQL.aiUsageTop,[date,limit]),
    async deleteOldAiUsage(beforeDate){await run(AI_SQL.deleteOldAiUsage,[beforeDate]);}
  };
}

/** @param {Record<string,import("./domain-types").PreparedStatementLike>} statements @param {string} userId */
function deleteLocalAiData(statements,userId){
  for(const name of ["deleteAiSettingsForDeletedUser","deleteAiUsageForDeletedUser"]){
    const statement=statements[name];if(!statement)throw new Error(`Missing Strata AI deletion statement: ${name}`);statement.run(userId,userId);
  }
}

/** @param {string} userId */
function aiDeletionBatch(userId){return [
  {sql:AI_SQL.deleteAiSettingsForDeletedUser,args:[userId,userId]},
  {sql:AI_SQL.deleteAiUsageForDeletedUser,args:[userId,userId]}
];}

module.exports={aiDeletionBatch,createLocalAiMethods,createTursoAiMethods,deleteLocalAiData};
