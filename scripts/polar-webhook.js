"use strict";

// Manages the app's one Polar AccessLink webhook. Polar signs every delivery with the webhook's secret, which
// Polar shows only when the webhook is created, so `create` prints it once for POLAR_WEBHOOK_SECRET.
//
//   npm run polar:webhook -- status
//   npm run polar:webhook -- create [--url https://example.com/api/devices/polar/webhook] [--events EXERCISE,SLEEP]
//   npm run polar:webhook -- delete [--id <webhook id>]

const {devicesSettings}=require("../src/devices-config");
const {createPolarClient}=require("../src/polar-client");

const DEFAULT_EVENTS=Object.freeze(["EXERCISE","SLEEP","CONTINUOUS_HEART_RATE"]);
const WEBHOOK_PATH="/api/devices/polar/webhook";

/** @param {string[]} argv */
function parseArgs(argv){
  const [command="status",...rest]=argv,options={};
  for(let index=0;index<rest.length;index+=1){
    const flag=rest[index];
    if(!["--url","--events","--id"].includes(flag)||rest[index+1]===undefined)throw new Error(`Unknown or incomplete option: ${flag}`);
    options[flag.slice(2)]=rest[index+1];index+=1;
  }
  if(!["status","create","delete"].includes(command))throw new Error(`Unknown command: ${command}. Use status, create, or delete.`);
  return {command,options};
}

/** The public address Polar should call: --url, or APP_BASE_URL plus the webhook path. */
function webhookUrl(options,env){
  const value=options.url||(String(env.APP_BASE_URL||"").trim().replace(/\/+$/,"")+WEBHOOK_PATH);
  let url;
  try{url=new URL(value);}catch{throw new Error("Set APP_BASE_URL or pass --url with the public webhook address.");}
  if(url.protocol!=="https:")throw new Error("Polar can only call an https:// webhook address.");
  return url.toString();
}
function eventsFrom(options){
  const events=String(options.events||DEFAULT_EVENTS.join(",")).split(",").map((event)=>event.trim().toUpperCase()).filter(Boolean);
  if(!events.length||events.some((event)=>!/^[A-Z_]{2,40}$/.test(event)))throw new Error("--events must be a comma-separated list such as EXERCISE,SLEEP.");
  return events;
}
/** @param {any} item */
const describe=(item)=>`${item.id} · ${item.url} · ${(item.events||[]).join(", ")}${item.active===false?" · inactive":""}`;

/**
 * @param {{command:string,options:Record<string,string>,env:Record<string,string|undefined>,client?:any,logger?:{log:Function}}} input
 */
async function run({command,options,env,client,logger=console}){
  const settings=devicesSettings(env);
  if(!settings.polar.clientId||!settings.polar.clientSecret||!settings.polar.apiBase)throw new Error("POLAR_CLIENT_ID and POLAR_CLIENT_SECRET are required.");
  const polar=client||createPolarClient({settings});
  const existing=((await polar.webhook("GET",""))?.data)||[];
  const hooks=Array.isArray(existing)?existing:[existing];
  if(command==="status"){
    if(!hooks.length)logger.log("No Polar webhook is registered. Run: npm run polar:webhook -- create");
    for(const item of hooks)logger.log(describe(item));
    return {webhooks:hooks.length};
  }
  if(command==="delete"){
    const id=options.id||hooks[0]?.id;
    if(!id){logger.log("No Polar webhook is registered.");return {deleted:false};}
    await polar.webhook("DELETE",`/${encodeURIComponent(String(id))}`);
    logger.log(`Deleted Polar webhook ${id}. Remove POLAR_WEBHOOK_SECRET or replace it after creating a new webhook.`);
    return {deleted:true};
  }
  if(hooks.length)throw new Error(`Polar already has a webhook for this app (${describe(hooks[0])}). Delete it first to create a new one.`);
  const created=(await polar.webhook("POST","",{events:eventsFrom(options),url:webhookUrl(options,env)}))?.data||{};
  const secret=String(created.signature_secret_key||"");
  logger.log(`Created Polar webhook ${created.id||""} for ${created.url||webhookUrl(options,env)}.`);
  if(secret)logger.log(`Set this as POLAR_WEBHOOK_SECRET in your host's settings, then redeploy. Polar will not show it again:\n${secret}`);
  else logger.log("Polar did not return a signing secret. Delete this webhook and create it again.");
  return {created:true,secret:Boolean(secret)};
}

if(require.main===module){
  (async()=>{
    try{await run({...parseArgs(process.argv.slice(2)),env:process.env});}
    catch(error){console.error(error instanceof Error?error.message:String(error));process.exitCode=1;}
  })();
}

module.exports={DEFAULT_EVENTS,WEBHOOK_PATH,eventsFrom,parseArgs,run,webhookUrl};
