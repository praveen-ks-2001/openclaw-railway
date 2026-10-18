import test from 'node:test';
import assert from 'node:assert/strict';
import { validateSetupForm } from './validation.js';
const valid = { provider: 'minimax', apiKey: 'synthetic-provider-key' };

test('invalid payloads and non-string fields fail cleanly before subprocess construction', () => {
  for (const body of [null, undefined, [], 'text', {...valid, provider: {}}, {...valid, apiKey: ['x']}, {...valid, model: 'a\0b'}, {...valid, apiKey: 'x'.repeat(16385)}]) {
    assert.ok(validateSetupForm(body).errors.length);
  }
});
test('existing setup IDs and supported OAuth remain valid', () => {
  assert.deepEqual(validateSetupForm(valid).errors, []);
  assert.deepEqual(validateSetupForm({provider:'openai', authMode:'oauth'}).errors, []);
  assert.deepEqual(validateSetupForm({provider:'xai', authMode:'oauth'}).errors, []);
  assert.ok(validateSetupForm({provider:'minimax', authMode:'oauth'}).errors.length);
});
test('custom/local endpoints require actual HTTP hosts and custom model identifiers', () => {
  for (const customUrl of ['https://', 'https://user:secret@example.com', 'ftp://example.com', 'https://example.com/#fragment']) {
    assert.ok(validateSetupForm({...valid, provider:'custom', customUrl, model:'model'}).errors.length);
  }
  assert.ok(validateSetupForm({...valid, provider:'custom', customUrl:'https://example.com/v1'}).errors.length);
  assert.deepEqual(validateSetupForm({...valid, provider:'custom', customUrl:'https://example.com/v1', model:'test-model'}).errors, []);
});
test('partial channel credentials and impossible scheduling inputs fail before any write', () => {
  for (const extra of [{mattermostToken:'synthetic'}, {mattermostUrl:'https://chat.example'}, {slackBotToken:'synthetic'}, {sessionResetHour:'abc'}, {sessionResetHour:'24'}, {sessionResetHour:'-1'}]) {
    assert.ok(validateSetupForm({...valid, ...extra}).errors.length);
  }
});
