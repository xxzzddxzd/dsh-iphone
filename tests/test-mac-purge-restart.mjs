import assert from 'node:assert/strict';
import vm from 'node:vm';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {readFile,writeFile,mkdtemp,mkdir,copyFile,rm} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import {tmpdir} from 'node:os';
import {createHash} from 'node:crypto';
import {patchPurgeManagedRestart,managedRestartInputs} from '../scripts/patch-mac-dsh-purge.mjs';
const root=new URL('./fixtures/dsh-purge-1.1.82/',import.meta.url);
const project=new URL('../',import.meta.url);
const cases=[];
if(typeof vm.SourceTextModule!=='function'){
 const child=spawnSync(process.execPath,['--experimental-vm-modules',fileURLToPath(import.meta.url)],{stdio:'inherit'});
 process.exit(child.status??1);
}
const digest=x=>createHash('sha256').update(x).digest('hex');
async function fixture(managed){
 const calls={spawn:[],copies:[],exit:[],timers:[],stages:[],core:[],responses:[]};
 const process={env:managed?{DSH_MANAGED_RESTART:'launchd'}:{},execPath:'/fixture/node',argv:['/fixture/node','/fixture/dsh/lib/bin.js','web','--no-open'],pid:1234,cwd:()=>'/fixture/cwd',exit:code=>calls.exit.push(code)};
 const fs={existsSync:()=>true,copyFileSync:(...args)=>calls.copies.push(args),promises:{}};
 const core={findDshBinRoot:()=>'/fixture/dsh',silenceCmdFlash:()=>calls.core.push('silence'),envForDetachedSpawn:()=>({FIXTURE:'true'}),gatherState:()=>{calls.core.push('gatherState');throw Error('Uninstall must reject before reading state')}};
 const context=vm.createContext({URL,process,setTimeout:(callback,ms)=>{calls.timers.push({callback,ms});return{}},console});
 const mocks={
  'node:fs':{default:fs,promises:fs.promises},'node:os':{default:{tmpdir:()=>'/fixture/tmp'}},'node:path':{default:path},
  'node:child_process':{spawn:(...args)=>{calls.spawn.push(args);return{unref(){}}}},'node:url':{fileURLToPath},
  './core.js':core,'./host.js':{},'./rules.js':{},'./update.js':{},'./drill-grant.js':{clearDrillGrant(){}},'./preset-default.js':{clearOwnedSelectedDefault(){},removeStaleAgentPresetDir(){}},
 };
 async function load(name){
  let source=await readFile(new URL(name,root),'utf8');
  const entry=managedRestartInputs.find(item=>item.relative==='lib/'+name);assert(entry);assert.equal(digest(source),entry.originalSHA256);
  for(const anchor of entry.anchors){assert.equal(source.split(anchor.before).length,2);source=source.replace(anchor.before,anchor.after)}
  assert.equal(digest(source),entry.patchedSHA256);
  const module=new vm.SourceTextModule(source,{context,identifier:'file:///fixture/lib/'+name,initializeImportMeta:meta=>{meta.url='file:///fixture/lib/'+name}});
  await module.link(specifier=>{
   const values=mocks[specifier];assert(values,`Unexpected module ${specifier}`);
   return new vm.SyntheticModule(Object.keys(values),function(){for(const [key,value]of Object.entries(values))this.setExport(key,value)},{context});
  });await module.evaluate();return module;
 }
 return {calls,context,process,load};
}
{
 const f=await fixture(true);const m=await f.load('web.js');m.namespace.scheduleRestart({headers:{host:'127.0.0.1:39999'}},null,{openBrowser:true});
 assert.equal(f.calls.spawn.length,0);assert.equal(f.calls.copies.length,0);assert.equal(f.calls.core.length,0);assert.equal(f.calls.timers.length,1);assert.equal(f.calls.timers[0].ms,250);assert.equal(f.calls.exit.length,0);
 f.calls.timers[0].callback();assert.deepEqual(f.calls.exit,[0]);cases.push('managed normal restart only exits after response window');
}
{
 const f=await fixture(true);const m=await f.load('web.js');assert.throws(()=>m.namespace.scheduleCleanupRestart({cleanup:['/fixture/package']}),/managed by launchd/);
 assert.equal(f.calls.spawn.length,0);assert.equal(f.calls.copies.length,0);assert.equal(f.calls.timers.length,0);cases.push('managed cleanup rejects before copying or spawning');
}
{
 const f=await fixture(false);const m=await f.load('web.js');m.namespace.scheduleRestart(null,null,{openBrowser:false});
 assert.equal(f.calls.spawn.length,1);const [exec,args,options]=f.calls.spawn[0];assert.equal(exec,'/fixture/node');assert.equal(args[0],'/fixture/lib/restart-web.js');assert.equal(options.detached,true);
 const payload=JSON.parse(options.env.DSH_PURGE_RESTART);assert.equal(payload.pid,1234);assert.equal(payload.openBrowser,false);assert.deepEqual(Array.from(payload.argv),['/fixture/dsh/lib/bin.js','web','--no-open']);
 assert.equal(f.calls.timers[0].ms,250);f.calls.timers[0].callback();assert.deepEqual(f.calls.exit,[0]);cases.push('unmanaged normal restart keeps legacy helper behavior');
}
{
 const f=await fixture(false);const m=await f.load('web.js');m.namespace.scheduleCleanupRestart({cleanup:['/fixture/package']});
 assert.equal(f.calls.copies.length,1);assert.equal(f.calls.spawn.length,1);assert.equal(f.calls.spawn[0][1][0],'/fixture/tmp/dsh-purge-uninst-1234.mjs');assert.equal(f.calls.timers[0].ms,400);
 const payload=JSON.parse(f.calls.spawn[0][2].env.DSH_PURGE_RESTART);assert.deepEqual(Array.from(payload.cleanup),['/fixture/package']);cases.push('unmanaged cleanup keeps copied cleanup helper behavior');
}
{
 const f=await fixture(true);const m=await f.load('uninstall.js');
 await assert.rejects(m.namespace.uninstallPurge({onStage:x=>f.calls.stages.push(x)}),/managed by launchd/);
 assert.deepEqual(f.calls.stages,[]);assert.deepEqual(f.calls.core,[]);assert.deepEqual(f.calls.copies,[]);cases.push('managed uninstall refuses before any state or profile mutation');
 // Execute the actual unmodified HTTP handler around the patched uninstaller.
 const handlerSource=await readFile(new URL('uninstall-http-handler.js',root),'utf8');
 Object.assign(f.context,{uninstaller:m.namespace,beginJob(){},endApply(){},setApplyProgress(){},ctx:{},hostctl:{currentSurface:()=> 'web',restartNote:()=> 'restart'},sendJson(_r,status,body){assert.equal(f.calls.responses.length,0,'Response was written twice');f.calls.responses.push({status,body})}});
 const handler=vm.runInContext('('+handlerSource+')',f.context);await handler({method:'POST'},{});
 assert.equal(f.calls.responses.length,1);assert.equal(f.calls.responses[0].status,500);assert.match(f.calls.responses[0].body.error,/managed by launchd/);assert.deepEqual(f.calls.core,[]);cases.push('actual HTTP uninstall handler returns one clear error before changes');
}
async function stagePurge(target){
 await mkdir(path.join(target,'lib'),{recursive:true});
 await writeFile(path.join(target,'package.json'),JSON.stringify({name:'dsh-purge',version:'1.1.82'})+'\n');
 for(const name of ['web.js','uninstall.js'])await copyFile(new URL(name,root),path.join(target,'lib',name));
}
const temporary=await mkdtemp(path.join(tmpdir(),'purge-managed-restart-test-'));
try{
 await stagePurge(temporary);
 await assert.rejects(patchPurgeManagedRestart(temporary,{check:true}),/patch is missing/);cases.push('check detects missing patch');
 await patchPurgeManagedRestart(temporary);await patchPurgeManagedRestart(temporary,{check:true});await patchPurgeManagedRestart(temporary);
 for(const entry of managedRestartInputs)assert.equal(digest(await readFile(path.join(temporary,entry.relative))),entry.patchedSHA256);cases.push('patch applies, verifies, and repeats without byte drift');
 await stagePurge(temporary);const web=await readFile(path.join(temporary,'lib/web.js'));await writeFile(path.join(temporary,'lib/uninstall.js'),'unexpected input');
 await assert.rejects(patchPurgeManagedRestart(temporary),/Unsupported/);assert.equal(digest(await readFile(path.join(temporary,'lib/web.js'))),digest(web));cases.push('unknown second file refuses before writing first file');
}finally{await rm(temporary,{recursive:true,force:true})}
// The actual Node --import bootstrap is exercised with a stub main module and
// an isolated DSH_HOME. It never starts DSH or reads an installed Purge package.
const preload=fileURLToPath(new URL('scripts/mac-dsh-preflight.mjs',project));
const preloadUrl=pathToFileURL(preload).href;
const preloadRoot=await mkdtemp(path.join(tmpdir(),'mac-dsh-preload-test-'));
try{
 const fakeDsh=path.join(preloadRoot,'selected DSH.mjs');
 const otherDsh=path.join(preloadRoot,'different entry.mjs');
 const log=path.join(preloadRoot,'main.jsonl');
 await writeFile(fakeDsh,`
import {appendFileSync} from 'node:fs';
const {macDshPreflight}=await import(process.env.MAC_DSH_TEST_PREFLIGHT);
appendFileSync(process.env.MAC_DSH_TEST_LOG,JSON.stringify({pid:process.pid,execPath:process.execPath,version:process.version,preflight:macDshPreflight,args:process.argv.slice(1),home:process.env.HOME,dshHome:process.env.DSH_HOME,profile:process.env.DSH_PROFILE})+'\\n');
`);
 await writeFile(otherDsh,'throw Error("The unexpected entry must not execute");\n');
 let ordinal=0;
 async function launch({marker='launchd',installed=false,unknown=false,broken=false,missingPackage=false,wrongPackage=false,args=['web','--no-open'],main=fakeDsh,expected=fakeDsh,alreadyPatched=false}={}){
  const dshHome=path.join(preloadRoot,`home-${++ordinal}`);
  const purge=path.join(dshHome,'profiles/web/node_modules/dsh-purge');
  if(installed){
   await stagePurge(purge);
   if(unknown)await writeFile(path.join(purge,'lib/uninstall.js'),'unknown version');
   if(missingPackage)await rm(path.join(purge,'package.json'));
   if(wrongPackage)await writeFile(path.join(purge,'package.json'),JSON.stringify({name:'not-purge'}));
   if(alreadyPatched)await patchPurgeManagedRestart(purge);
  }
  if(broken){await mkdir(path.dirname(purge),{recursive:true});const {symlink}=await import('node:fs/promises');await symlink(path.join(preloadRoot,'missing-package'),purge);}
  await writeFile(log,'');
  const env={...process.env,DSH_HOME:dshHome,DSH_PROFILE:'desktop',DSH_MANAGED_RESTART:marker,
   DSH_MAC_DSH_BIN:expected,MAC_DSH_TEST_PREFLIGHT:preloadUrl,MAC_DSH_TEST_LOG:log};
  if(marker===null)delete env.DSH_MANAGED_RESTART;
  const result=spawnSync(process.execPath,['--import',preloadUrl,main,...args],{env,encoding:'utf8',timeout:10000});
  const calls=(await readFile(log,'utf8')).trim().split('\n').filter(Boolean).map(line=>JSON.parse(line));
  return {result,calls,purge,dshHome};
 }
 {
  const r=await launch();assert.equal(r.result.status,0,r.result.stderr);assert.equal(r.calls.length,1);
  assert.equal(r.calls[0].pid,r.result.pid);assert.equal(r.calls[0].preflight.pid,r.calls[0].pid);assert.equal(r.calls[0].execPath,process.execPath);
  assert.deepEqual(r.calls[0].args,[fakeDsh,'web','--no-open']);assert.equal(r.calls[0].profile,'web');assert.equal(r.calls[0].home,process.env.HOME);assert.equal(r.calls[0].dshHome,r.dshHome);assert.equal(r.calls[0].preflight.purgeStatus,'absent');
  cases.push('Node preload and main share one PID, keep HOME, fix web, and allow absent optional Purge');
 }
 {
  const r=await launch({installed:true});assert.equal(r.result.status,0,r.result.stderr);assert.equal(r.calls.length,1);assert.equal(r.calls[0].preflight.purgeStatus,'patched');assert.equal(r.calls[0].pid,r.result.pid);
  await patchPurgeManagedRestart(r.purge,{check:true});for(const entry of managedRestartInputs)assert.equal(digest(await readFile(path.join(r.purge,entry.relative))),entry.patchedSHA256);
  cases.push('Node preload patches the fixture before the stub main executes');
 }
 {
  const r=await launch({installed:true,alreadyPatched:true});assert.equal(r.result.status,0,r.result.stderr);assert.equal(r.calls.length,1);await patchPurgeManagedRestart(r.purge,{check:true});cases.push('Node preload accepts an already-patched fixture');
 }
 {
  const r=await launch({installed:true,unknown:true});assert.notEqual(r.result.status,0);assert.match(r.result.stderr,/Unsupported Purge/);assert.equal(r.calls.length,0);
  assert.equal(digest(await readFile(path.join(r.purge,'lib/web.js'))),managedRestartInputs[0].originalSHA256);cases.push('Node preload refuses unknown preimages before main or partial writes');
 }
 for(const marker of [null, '', 'other']){const r=await launch({marker});assert.notEqual(r.result.status,0);assert.match(r.result.stderr,/DSH_MANAGED_RESTART=launchd/);assert.equal(r.calls.length,0);}
 cases.push('Node preload refuses missing or invalid managed marker before main');
 {
  for(const args of [['tui','--no-open'],['--profile','web'],['web','--no-open','--port','9999']]){const r=await launch({args});assert.notEqual(r.result.status,0);assert.match(r.result.stderr,/other profiles and arguments are not accepted/);assert.equal(r.calls.length,0)}
  cases.push('Node preload refuses other profiles and extra arguments before main');
 }
 {
  const r=await launch({broken:true});assert.notEqual(r.result.status,0);assert.match(r.result.stderr,/Purge package is incomplete/);assert.equal(r.calls.length,0);cases.push('Node preload refuses a broken installed Purge link');
 }
 {
  const r=await launch({installed:true,missingPackage:true});assert.notEqual(r.result.status,0);assert.match(r.result.stderr,/Purge package is incomplete/);assert.equal(r.calls.length,0);
  const wrong=await launch({installed:true,wrongPackage:true});assert.notEqual(wrong.result.status,0);assert.match(wrong.result.stderr,/Expected a dsh-purge package root/);assert.equal(wrong.calls.length,0);cases.push('Node preload refuses missing or mismatched package metadata');
 }
 {
  const r=await launch({main:otherDsh});assert.notEqual(r.result.status,0);assert.match(r.result.stderr,/does not match the selected DSH CLI/);assert.equal(r.calls.length,0);
  const missing=await launch({expected:path.join(preloadRoot,'missing-dsh')});assert.notEqual(missing.result.status,0);assert.match(missing.result.stderr,/ENOENT/);assert.equal(missing.calls.length,0);cases.push('Node preload validates the selected main entry before executing it');
 }
}finally{await rm(preloadRoot,{recursive:true,force:true})}
console.log(JSON.stringify({status:'passed',runtime:{execPath:process.execPath,version:process.version},caseCount:cases.length,cases,realDSHStarted:false,installedPurgeRead:false,productionModified:false},null,2));
