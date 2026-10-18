import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root=fs.mkdtempSync(path.join(os.tmpdir(),'fourth-runtime-'));
process.env.OPENCLAW_DATA_DIR=path.join(root,'data');
process.env.OPENCLAW_ENTRY=path.join(root,'package','dist','entry.mjs');
process.env.OPENCLAW_GATEWAY_TOKEN='synthetic-gateway-token';
process.env.WRAPPER_ADMIN_PASSWORD='synthetic-admin-password';
fs.mkdirSync(path.dirname(process.env.OPENCLAW_ENTRY),{recursive:true});
fs.writeFileSync(process.env.OPENCLAW_ENTRY, `
if(process.argv.includes('wait'))setInterval(()=>{},1000);
else process.stdout.write(JSON.stringify({args:process.argv.slice(2),state:process.env.OPENCLAW_STATE_DIR,workspace:process.env.OPENCLAW_WORKSPACE_DIR,config:process.env.OPENCLAW_CONFIG_PATH,home:process.env.HOME}));
`);
const {runCli,runSdk}=await import('./openclawRuntime.js');

test.after(()=>fs.rmSync(root,{recursive:true,force:true}));
test('CLI uses template roots, honors staged config, and redacts secret flag values',async()=>{
 const result=await runCli(['probe','--minimax-api-key','synthetic-secret'],{env:{OPENCLAW_CONFIG_PATH:'/staging/candidate.json'}});
 assert.equal(result.code,0);
 const output=JSON.parse(result.output);
 assert.equal(output.state,path.join(root,'data','.openclaw'));
 assert.equal(output.workspace,path.join(root,'data','.openclaw','workspace'));
 assert.equal(output.config,'/staging/candidate.json');
 assert.equal(output.home,path.join(root,'data'));
 assert.deepEqual(output.args,['probe','--minimax-api-key','[REDACTED]']);
});
test('CLI cancellation never converts a signalled command into success',async()=>{
 const result=await runCli(['wait'],{timeoutMs:15});
 assert.equal(result.code,124);assert.equal(result.timedOut,true);
 const controller=new AbortController();controller.abort();
 const aborted=await runCli(['probe'],{signal:controller.signal});
 assert.equal(aborted.code,130);assert.equal(aborted.aborted,true);
});
test('each SDK call gets a fresh module owner and reads the latest durable state',async()=>{
 const durable=path.join(root,'pairing.json');
 const sdkPath=path.join(root,'device-sdk.mjs');
 fs.writeFileSync(sdkPath,`import fs from 'node:fs';const captured=JSON.parse(fs.readFileSync(${JSON.stringify(durable)},'utf8'));export async function listDevicePairing(){return captured;}`);
 fs.writeFileSync(durable,JSON.stringify({pending:[{requestId:'first'}],paired:[]}));
 assert.equal((await runSdk('devices-list',{sdkPath})).pending[0].requestId,'first');
 fs.writeFileSync(durable,JSON.stringify({pending:[{requestId:'second'}],paired:[]}));
 assert.equal((await runSdk('devices-list',{sdkPath})).pending[0].requestId,'second');
});
