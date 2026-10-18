import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import {execFileSync} from 'node:child_process';

const root=fs.mkdtempSync(path.join(os.tmpdir(),'fourth-setup-route-'));
const dataRoot=path.join(root,'data');
const packageRoot=path.join(root,'package');
const control=path.join(root,'control.json');
const invocations=path.join(root,'invocations.jsonl');
process.env.OPENCLAW_DATA_DIR=dataRoot;
process.env.OPENCLAW_ENTRY=path.join(packageRoot,'dist','entry.mjs');
process.env.OPENCLAW_GATEWAY_TOKEN='synthetic-gateway-token';
process.env.WRAPPER_ADMIN_PASSWORD='synthetic-admin-password';
fs.mkdirSync(path.join(packageRoot,'dist','plugin-sdk'),{recursive:true});
fs.writeFileSync(path.join(packageRoot,'package.json'),JSON.stringify({name:'openclaw',version:'2026.10.4',type:'module'}));
fs.writeFileSync(process.env.OPENCLAW_ENTRY,`
import fs from 'node:fs';import path from 'node:path';
const args=process.argv.slice(2), control=JSON.parse(fs.readFileSync(${JSON.stringify(control)},'utf8'));
fs.appendFileSync(${JSON.stringify(invocations)},JSON.stringify(args)+'\\n');
const filename=process.env.OPENCLAW_CONFIG_PATH;
if(args[0]==='onboard'){
 if(control.delay)await new Promise(resolve=>setTimeout(resolve,control.delay));
 fs.mkdirSync(path.dirname(filename),{recursive:true});
 fs.writeFileSync(filename,JSON.stringify({agents:{defaults:{workspace:process.env.OPENCLAW_WORKSPACE_DIR,model:{primary:'minimax/test-model'}}},gateway:{controlUi:{}}}));
 process.exit(control.onboardExit||0);
}
if(args[0]==='config'&&args[1]==='set'){
 if(control.failPatch){process.stderr.write('synthetic-provider-key');process.exit(17);}
 const strict=args.includes('--strict-json');const at=strict?3:2;
 const config=JSON.parse(fs.readFileSync(filename,'utf8'));let node=config;
 const keys=args[at].split('.');for(const key of keys.slice(0,-1))node=node[key]||=( {} );
 node[keys.at(-1)]=strict?JSON.parse(args[at+1]):args[at+1];
 fs.writeFileSync(filename,JSON.stringify(config));
}
if(args[0]==='config'&&args[1]==='validate')process.exit(control.failValidate?18:0);
if(args[0]==='backup'&&args[1]==='create'){
 const archive=args[args.indexOf('--output')+1];fs.mkdirSync(path.dirname(archive),{recursive:true});fs.writeFileSync(archive,'synthetic-verified-backup');
}
if(args[0]==='backup'&&args[1]==='restore'){
 const target=args[args.indexOf('--target')+1], archiveRoot='synthetic-official-backup',stateArchive=archiveRoot+'/payload/state';
 const state=process.env.OPENCLAW_STATE_DIR;
 fs.mkdirSync(path.join(target,archiveRoot,'payload'),{recursive:true});fs.cpSync(state,path.join(target,stateArchive),{recursive:true});
 const workspaces=control.backupExternal?[control.backupExternal]:control.backupMultiple?[path.join(state,'workspace-archivist'),path.join(state,'workspace')]:[path.join(state,'workspace')];
 const assets=[{kind:'state',sourcePath:state,archivePath:stateArchive}];
 if(control.backupExternal){const workspaceArchive=archiveRoot+'/payload/external';fs.cpSync(control.backupExternal,path.join(target,workspaceArchive),{recursive:true});assets.push({kind:'workspace',sourcePath:control.backupExternal,archivePath:workspaceArchive});}
 const manifest={schemaVersion:1,archiveRoot,paths:{stateDir:state,configPath:path.join(state,'openclaw.json'),workspaceDirs:workspaces,agentRoots:[]},assets,sqliteSnapshots:[]};
 fs.writeFileSync(path.join(target,archiveRoot,'manifest.json'),JSON.stringify(manifest));
}

`);
fs.writeFileSync(path.join(packageRoot,'dist','plugin-sdk','provider-auth.js'),`
import fs from 'node:fs';
export async function ensureAuthProfileStore(){const flags=JSON.parse(fs.readFileSync(${JSON.stringify(control)},'utf8'));return {profiles:flags.noCredentials?{}:{'minimax:default':{type:'api_key',provider:'minimax',key:'synthetic-provider-key'}}};}
export function listProfilesForProvider(store,provider){return Object.keys(store.profiles).filter(id=>store.profiles[id].provider===provider);}
`);
const {gatewayManager}=await import('../services/gatewayManager.js');
let running=false, starts=0;
gatewayManager.start=async()=>{running=true;starts++;};
gatewayManager.stop=async()=>{running=false;};
gatewayManager.isRunning=()=>running;
gatewayManager.getState=()=>running?'running':'stopped';
const {setupRoutes}=await import('./setup.js');
const app=express();app.use(express.json());app.use('/setup',setupRoutes);
app.use((error,_req,res,_next)=>res.status(error.status||500).json({ok:false,error:error.message}));
const server=app.listen(0,'127.0.0.1');
await new Promise((resolve,reject)=>{server.once('listening',resolve);server.once('error',reject);});
const base=`http://127.0.0.1:${server.address().port}`;
const payload={provider:'minimax',apiKey:'synthetic-provider-key'};
const auth={authorization:'Bearer synthetic-admin-password','content-type':'application/json'};
const request=(url,body,headers=auth)=>fetch(base+url,{method:'POST',headers,body:JSON.stringify(body)});
function flags(values={}){fs.writeFileSync(control,JSON.stringify(values));}
function calls(){return fs.existsSync(invocations)?fs.readFileSync(invocations,'utf8').trim().split('\n').filter(Boolean).map(JSON.parse):[];}

test.beforeEach(()=>{
 running=false;starts=0;flags();
 fs.rmSync(dataRoot,{recursive:true,force:true});fs.rmSync(invocations,{force:true});
});
test.after(async()=>{await new Promise(resolve=>server.close(resolve));fs.rmSync(root,{recursive:true,force:true});});

test('setup mutations and backup require admin credentials',async()=>{
 const reset=await request('/setup/reset',{mode:'full'},{'content-type':'application/json'});
 assert.equal(reset.status,401);
 const backup=await fetch(base+'/setup/export');assert.equal(backup.status,401);
 assert.deepEqual(calls(),[]);
});
test('failed config patch preserves the incomplete marker and cannot report ready',async()=>{
 flags({failPatch:true});
 const response=await request('/setup/save',payload);
 assert.equal(response.status,500);const body=await response.json();assert.equal(body.ok,false);
 assert.doesNotMatch(JSON.stringify(body),/synthetic-provider-key/);
 assert.equal(starts,0);
 assert.ok(fs.existsSync(path.join(dataRoot,'.openclaw','.wrapper-setup-incomplete')));
});
test('onboard exit zero without persisted provider credentials is a setup failure',async()=>{
 flags({noCredentials:true});
 const response=await request('/setup/save',payload);
 assert.equal(response.status,500);assert.equal((await response.json()).ok,false);
 assert.equal(starts,0);
 assert.ok(fs.existsSync(path.join(dataRoot,'.openclaw','.wrapper-setup-incomplete')));
});
test('successful setup waits for ready and adopts verified state before returning success',async()=>{
 const response=await request('/setup/save',payload);
 assert.equal(response.status,200);assert.equal((await response.json()).ok,true);
 assert.equal(starts,1);assert.equal(running,true);
 assert.equal(fs.existsSync(path.join(dataRoot,'.openclaw','.wrapper-setup-incomplete')),false);
 const saved=JSON.parse(fs.readFileSync(path.join(dataRoot,'.openclaw','openclaw.json'),'utf8'));
 assert.equal(saved.gateway.controlUi.allowInsecureAuth,undefined);
 assert.equal(saved.agents.defaults.workspace,path.join(dataRoot,'.openclaw','workspace'));
 assert.ok(calls().some(args=>args[0]==='config'&&args[1]==='validate'));
 assert.ok(fs.existsSync(path.join(dataRoot,'.wrapper-upgrade-recovery','last-success.json')));
});
test('overlapping reset is rejected while setup owns state',async()=>{
 flags({delay:200});
 const pending=request('/setup/save',payload);
 const deadline=Date.now()+3000;
 while(!calls().some(args=>args[0]==='onboard')&&Date.now()<deadline)await new Promise(resolve=>setTimeout(resolve,10));
 assert.ok(calls().some(args=>args[0]==='onboard'));
 const reset=await request('/setup/reset',{mode:'full'});
 assert.equal(reset.status,409);
 const response=await pending;assert.equal(response.status,200);await response.json();
});

test('state-only ZIP refuses a single external workspace without relocating data and restarts the previous Gateway',async()=>{
 const state=path.join(dataRoot,'.openclaw'),external=path.join(root,'external-workspace');
 fs.mkdirSync(state,{recursive:true});fs.mkdirSync(external,{recursive:true});
 fs.writeFileSync(path.join(state,'openclaw.json'),JSON.stringify({agents:{defaults:{workspace:external}}}));
 fs.writeFileSync(path.join(external,'MEMORY.md'),'external authored bytes stay in place');
 const originalConfig=fs.readFileSync(path.join(state,'openclaw.json'));
 flags({backupExternal:external});running=true;
 const response=await fetch(base+'/setup/export',{headers:auth});
 assert.equal(response.status,422);
 assert.equal(response.headers.get('content-disposition'),null);
 const body=await response.json();assert.equal(body.ok,false);
 assert.match(body.error,/outside its OpenClaw state directory/);
 assert.match(body.error,/OpenClaw backup CLI/);
 assert.ok(!JSON.stringify(body).includes(external),'unsupported-layout error must not reveal local paths');
 assert.deepEqual(fs.readFileSync(path.join(state,'openclaw.json')),originalConfig);
 assert.equal(fs.readFileSync(path.join(external,'MEMORY.md'),'utf8'),'external authored bytes stay in place');
 assert.equal(fs.existsSync(path.join(state,'workspace','MEMORY.md')),false);
 assert.equal(running,true);assert.equal(starts,1);
 assert.deepEqual(calls().filter(args=>args[0]==='backup').map(args=>args[1]),['create','restore']);
});

test('state-only ZIP exports both nested workspaces without replacing main with the first manifest workspace',async()=>{
 const state=path.join(dataRoot,'.openclaw');
 for(const workspace of ['workspace','workspace-archivist'])fs.mkdirSync(path.join(state,workspace),{recursive:true});
 fs.writeFileSync(path.join(state,'openclaw.json'),JSON.stringify({agents:{defaults:{workspace:path.join(state,'workspace')},entries:{main:{workspace:path.join(state,'workspace')},archivist:{workspace:path.join(state,'workspace-archivist')}}}}));
 fs.writeFileSync(path.join(state,'workspace','MEMORY.md'),'main must remain main');
 fs.writeFileSync(path.join(state,'workspace-archivist','MEMORY.md'),'archivist must remain archivist');
 flags({backupMultiple:true});running=true;
 const response=await fetch(base+'/setup/export',{headers:auth});
 assert.equal(response.status,200);assert.match(response.headers.get('content-disposition'),/attachment/);
 const archive=path.join(root,'nested-export.zip');fs.writeFileSync(archive,Buffer.from(await response.arrayBuffer()));
 assert.equal(execFileSync('unzip',['-P','synthetic-admin-password','-p',archive,'data/.openclaw/workspace/MEMORY.md'],{encoding:'utf8'}),'main must remain main');
 assert.equal(execFileSync('unzip',['-P','synthetic-admin-password','-p',archive,'data/.openclaw/workspace-archivist/MEMORY.md'],{encoding:'utf8'}),'archivist must remain archivist');
 assert.equal(running,true);assert.equal(starts,1);
});
