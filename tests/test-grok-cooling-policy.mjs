/** Real repository Core/SDK/retry behavior, with synthetic failures and no network path. */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { Socket } from 'node:net';
import { pathToFileURL } from 'node:url';
const runtime = createRequire(new URL('../dsh-runtime/package.json', import.meta.url));
const loadRuntime = name => import(pathToFileURL(runtime.resolve(name)).href);
const [{ PiAiAdapter, Config }, { resolveRetryPolicy }, { apply: installRetry }, { xaiProvider }] = await Promise.all([
  loadRuntime('@deepseek-ai/dsh-llm-pi-ai'), loadRuntime('@deepseek-ai/dsh-llm'),
  loadRuntime('@deepseek-ai/dsh-llm-retry'),
  import(new URL('../dsh-runtime/node_modules/@earendil-works/pi-ai/dist/providers/xai.js', import.meta.url).href),
]);
// This upstream fixture has only builtin imports and is never given real DSH state.
const purgeSource = await readFile(new URL('./fixtures/dsh-purge-1.1.82/continue-retry.js', import.meta.url), 'utf8');
const purgeHash = createHash('sha256').update(purgeSource).digest('hex');
assert.equal(purgeHash, 'b4710fb4eb9990801756e5396f447f9da227177db78d3fff4880509d527be6d0');
const { installContinueRetry } = await import('data:text/javascript;base64,' + Buffer.from(purgeSource).toString('base64'));
const originalFetch=globalThis.fetch;
const originalConnect=Socket.prototype.connect;
const hadPending=Object.prototype.hasOwnProperty.call(globalThis,'__dshPurgeRetryPending');
const originalPending=globalThis.__dshPurgeRetryPending;
Socket.prototype.connect=function(){throw new Error('External networking is forbidden in the cooling-policy fixture')};
let calls=0,fixtureMode='429';
globalThis.fetch=async()=>{
 calls++;
 if(fixtureMode==='transport')throw new TypeError('fetch failed: synthetic transport fixture');
 return Response.json({error:{message:fixtureMode==='429'?'Synthetic upstream account cooling':'Synthetic server error',type:fixtureMode==='429'?'rate_limit_error':'server_error',code:fixtureMode==='429'?'upstream_cooling':'server_error'}},{status:fixtureMode==='429'?429:500,headers:{'retry-after':'30'}});
};
function adapterFor(policy){
 const profile={provider:'xai',displayName:'xAI fixture',streamIdleTimeoutMs:1000,
  maxRequestImageBytes:8*1024*1024,requestImagePixelBudget:2048*2048,requestImageMaxBytes:1024*1024,
  retryPolicy:policy,modelErrors:new Map(),configuredMaxTokens:new Map(),piProvider:{...xaiProvider(),auth:{apiKey:{name:'fixture key',resolve:async()=>({auth:{apiKey:'synthetic-not-a-real-key'},source:'fixture'})}}}};
 return new PiAiAdapter({profiles:()=>new Map([['xai',profile]]),resolveApiKey:async()=> 'synthetic-not-a-real-key',resolveAttachments:()=>undefined});
}
async function failureOf(adapter,expectedCode='RATE_LIMIT'){
 let failure;
 for await(const c of adapter.stream({provider:'xai',model:'grok-4.6',reasoningEffort:'low',messages:[{role:'user',content:[{type:'text',text:'Synthetic retry fixture; no network.'}]}],maxTokens:16,signal:AbortSignal.timeout(5000)})){
  if(c.type==='finish'&&c.reason.kind==='error')failure=c.reason.failure;
 }
 assert(failure);assert.equal(failure.code,expectedCode);return failure;
}
function retryFixture(purgeAutoRetry){
 let projection,state,cleanup;const events=[],listeners=[];
 const ctx={sessionProjections:{register:spec=>{projection=spec;state=spec.init()},stateOf:()=>state},
  logger:{warn(){}},on:(name,fn)=>{if(name==='agent/request-error')listeners.push(fn);return()=>{}},effect:fn=>{cleanup=fn()}};
 installRetry(ctx,{}, {random:()=>0.5});
 const purge=purgeAutoRetry===undefined?undefined:installContinueRetry(ctx,{getConfig:()=>({autoRetry:purgeAutoRetry,retryMax:3,autoContinue:false,continueMax:3,continueText:'continue'})});
 const agent={id:'synthetic-retry-session',session:{id:'synthetic-retry-session',append:(type,data)=>{events.push({type,data});state=projection.apply(state,{type,data})}}};
 const dispatch=(payload,index=0)=>index<listeners.length?listeners[index](payload,()=>dispatch(payload,index+1)):Promise.resolve(undefined);
 return {agent,events,handle:payload=>dispatch(payload),cleanup:async()=>{purge?.dispose();await cleanup()}};
}
async function immediateBackoff(fn,delays){
 const originalSet=globalThis.setTimeout,originalClear=globalThis.clearTimeout;const pending=new Set();
 globalThis.setTimeout=(callback,ms)=>{delays.push(ms);const id={fixtureTimer:true};pending.add(id);queueMicrotask(()=>{if(pending.delete(id))callback()});return id};
 globalThis.clearTimeout=id=>{if(id?.fixtureTimer)pending.delete(id);else originalClear(id)};
 try{return await fn()}finally{globalThis.setTimeout=originalSet;globalThis.clearTimeout=originalClear}
}
const normal=resolveRetryPolicy(undefined,'synthetic normal');
const noRateLimit=resolveRetryPolicy({mode:'normal',maxRetries:5,retryableCodes:['EMPTY_RESPONSE','SERVER','TIMEOUT','TRANSPORT']},'synthetic no rate-limit');
async function runScenario(name,policy,augment,expectedCode='RATE_LIMIT',purgeAutoRetry){
 const adapter=adapterFor(policy),retry=retryFixture(purgeAutoRetry),startCalls=calls,delays=[];let lastFailure;
 try{
  for(let attempt=0;attempt<8;attempt++){
   const failure=await failureOf(adapter,expectedCode);lastFailure=augment?{...failure,...augment}:failure;
   const decision=await immediateBackoff(()=>retry.handle({agent:retry.agent,turn:1,step:1,provider:'xai',failure:lastFailure,retryPolicy:adapter.providerRetryPolicy('xai'),signal:new AbortController().signal}),delays);
   if(decision?.kind!=='retry')break;
  }
 }finally{await retry.cleanup()}
 return {name,fixtureMode,purgeAutoRetry:purgeAutoRetry??null,httpRequests:calls-startCalls,retries:retry.events.filter(e=>e.type==='llm/retry').length,delaysMs:delays,totalDelayMs:delays.reduce((a,b)=>a+b,0),retryAfterHint:lastFailure.providerRetryAfterMs??null,lastCode:lastFailure.code};
}
try{
 const baseline=await failureOf(adapterFor(normal));
 assert.equal(baseline.providerRetryAfterMs,undefined);assert.equal(baseline.status,undefined);assert.match(baseline.message,/429/);
 const scenarios=[];
 scenarios.push(await runScenario('actual current default pipeline loses Retry-After',normal));
 scenarios.push(await runScenario('profile excludes automatic rate-limit retry',noRateLimit));
 scenarios.push(await runScenario('existing Harness respects a preserved long cooldown',normal,{providerRetryAfterMs:30000}));
 assert.equal(scenarios[0].httpRequests,6);assert.deepEqual(scenarios[0].delaysMs,[500,1000,2000,4000,8000]);
 assert.equal(scenarios[1].httpRequests,1);assert.equal(scenarios[1].retries,0);
 assert.equal(scenarios[2].httpRequests,1);assert.equal(scenarios[2].retries,0);
 fixtureMode='500';scenarios.push(await runScenario('same profile keeps server-error retries',noRateLimit,undefined,'SERVER'));
 fixtureMode='transport';scenarios.push(await runScenario('same profile keeps transport-error retries',noRateLimit,undefined,'TRANSPORT'));
 assert.equal(scenarios[3].httpRequests,6);assert.equal(scenarios[3].retries,5);
 assert.equal(scenarios[4].httpRequests,6);assert.equal(scenarios[4].retries,5);
 fixtureMode='429';
 scenarios.push(await runScenario('Core default plus enabled Purge extra retry',normal,undefined,'RATE_LIMIT',true));
 scenarios.push(await runScenario('selective Core policy still gets a Purge extra retry',noRateLimit,undefined,'RATE_LIMIT',true));
 scenarios.push(await runScenario('selective Core policy plus disabled redundant Purge retry',noRateLimit,undefined,'RATE_LIMIT',false));
 assert.equal(scenarios[5].httpRequests,7);assert.equal(scenarios[6].httpRequests,2);assert.equal(scenarios[7].httpRequests,1);
 fixtureMode='500';scenarios.push(await runScenario('full public config keeps server retries with Purge extra retry disabled',noRateLimit,undefined,'SERVER',false));
 fixtureMode='transport';scenarios.push(await runScenario('full public config keeps transport retries with Purge extra retry disabled',noRateLimit,undefined,'TRANSPORT',false));
 assert.equal(scenarios[8].httpRequests,6);assert.equal(scenarios[8].retries,5);assert.equal(scenarios[9].httpRequests,6);assert.equal(scenarios[9].retries,5);
 const configured=Config({providers:{xai:{api:'openai-responses',baseURL:'http://127.0.0.1:8000/v1',models:[{id:'grok-4.6',input:['text','image']}],maxRequestImageBytes:8*1024*1024,retryPolicy:{mode:'normal',maxRetries:5,retryableCodes:['EMPTY_RESPONSE','SERVER','TIMEOUT','TRANSPORT']}}}});
 assert.equal(Config.dict.providers.meta.volatile,true);assert.equal(configured.providers.get().xai.maxRequestImageBytes,8388608);
 const configCheck={providersDictVolatile:true,path:['providers','xai','maxRequestImageBytes'],acceptedBytes:configured.providers.get().xai.maxRequestImageBytes,retryPolicyAccepted:true};
 const report={status:'passed',runtime:{execPath:process.execPath,version:process.version},input:{httpStatus:429,retryAfterSeconds:30,code:'upstream_cooling'},configCheck,observedFailure:{code:baseline.code,status:baseline.status??null,providerRetryAfterMs:baseline.providerRetryAfterMs??null},scenarios,networkRequests:0,productionModified:false};
 console.log(JSON.stringify({status:report.status,runtime:report.runtime,input:report.input,configCheck:report.configCheck,observedFailure:report.observedFailure,scenarioCount:scenarios.length,scenarios:scenarios.map(({name,lastCode,httpRequests,retries,totalDelayMs,purgeAutoRetry})=>({name,code:lastCode,httpRequests,retries,totalDelayMs,purgeAutoRetry})),networkRequests:0,installedPurgeRead:false,productionModified:false},null,2));
}finally{
 globalThis.fetch=originalFetch;Socket.prototype.connect=originalConnect;
 if(hadPending)globalThis.__dshPurgeRetryPending=originalPending;else delete globalThis.__dshPurgeRetryPending;
}
