import test from 'node:test';
import assert from 'node:assert/strict';
import { buildOnboardArgs, PROVIDER_MAP, OAUTH_AUTH_CHOICE, toAuthPayload, runOpenclawPty } from './onboardBuilder.js';
import { ALL_AUTH_OPTIONS, requiredOfficialPlugins } from '../core/openclaw-compat.js';
import { WORKSPACE_DIR } from '../config/index.js';

test('every existing provider ID maps to a supported target auth choice', () => {
  for (const [provider, mapping] of Object.entries(PROVIDER_MAP)) {
    const data = {provider, apiKey:'synthetic-key', model:'synthetic-model', customUrl:'https://example.com/v1', ollamaUrl:'http://ollama:11434', cloudflareAccountId:'synthetic-account', cloudflareGatewayId:'synthetic-gateway'};
    const args = buildOnboardArgs(data);
    assert.ok(ALL_AUTH_OPTIONS.some(option => option.value === mapping.authChoice), provider);
    assert.ok(args.includes('--non-interactive'), provider);
    assert.ok(!args.includes('--classic'), provider);
    assert.equal(args[args.indexOf('--workspace') + 1], WORKSPACE_DIR);
    assert.ok(WORKSPACE_DIR.endsWith('/.openclaw/workspace'));
  }
});
test('only supported device-code methods opt into the classic interactive flow', () => {
  for (const key of Object.keys(OAUTH_AUTH_CHOICE)) {
    const provider = key.split(':')[0];
    const args = buildOnboardArgs({provider,authMode:'oauth'});
    assert.ok(args.includes('--classic'));
    assert.ok(!args.includes('--non-interactive'));
    assert.ok(args.includes('--skip-hooks'));
    assert.ok(args.includes('--suppress-gateway-token-output'));
  }
});
test('provider and channel plugin selection follows this template payload names', () => {
  const payload = toAuthPayload({provider:'deepseek',apiKey:'synthetic',mattermostToken:'synthetic-token',slackBotToken:'synthetic-bot',slackAppToken:'synthetic-app'});
  assert.deepEqual(requiredOfficialPlugins({payload}).map(item=>item.plugin).sort(), ['deepseek','mattermost','slack']);
  assert.ok(requiredOfficialPlugins({payload:toAuthPayload({provider:'openai'})}).some(item=>item.plugin === 'codex'));
});
test('Groq gets a concrete compatible endpoint/model and local Ollama strips provider prefix', () => {
  const groq = buildOnboardArgs({provider:'groq',apiKey:'synthetic'});
  assert.equal(groq[groq.indexOf('--custom-base-url')+1], 'https://api.groq.com/openai/v1');
  assert.equal(groq[groq.indexOf('--custom-model-id')+1], 'llama-3.3-70b-versatile');
  const ollama = buildOnboardArgs({provider:'ollama',ollamaUrl:'http://ollama:11434',model:'ollama/llama3.3'});
  assert.equal(ollama[ollama.indexOf('--custom-model-id')+1], 'llama3.3');
});

test('PTY device sign-in redacts secrets split between chunks and settles nonzero exits', async () => {
  const chunks=[];
  const result=await runOpenclawPty(['onboard'], {
    secrets:['synthetic-secret'], onOutput:chunk=>chunks.push(chunk),
    spawnPty:()=>({ onData(callback){queueMicrotask(()=>{callback('Visit https://auth.example code ABCD\nsynthetic-');callback('secret\n');});}, onExit(callback){setImmediate(()=>callback({exitCode:7}));}, write(){}, kill(){} }),
  });
  assert.equal(result.code,7);
  assert.match(chunks.join(''),/https:\/\/auth.example/);
  assert.doesNotMatch(chunks.join(''),/synthetic-secret/);
  assert.match(chunks.join(''),/\[REDACTED\]/);
});
test('PTY timeout and client abort terminate the owned command and cannot report success', async () => {
  for (const reason of ['timeout','abort']) {
    const controller=new AbortController();let exit, killed=[];
    const promise=runOpenclawPty(['onboard'], {
      signal:controller.signal,timeoutMs:reason==='timeout'?10:1000,
      spawnPty:()=>({ onData(){},onExit(callback){exit=callback;},write(){},kill(signal){killed.push(signal);queueMicrotask(()=>exit({exitCode:0}));} }),
    });
    if(reason==='abort')controller.abort();
    const result=await promise;
    assert.equal(result.code,reason==='timeout'?124:130);
    assert.deepEqual(killed,['SIGTERM']);
  }
});
