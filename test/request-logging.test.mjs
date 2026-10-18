import test from 'node:test';
import assert from 'node:assert/strict';
import { safeRequestPath } from '../src/middleware/logger.js';

test('request diagnostics omit query credentials while retaining ordinary route paths', () => {
  assert.equal(safeRequestPath('/api/chat/media/outgoing/id/full?mediaTicket=synthetic-secret'), '/api/chat/media/outgoing/id/full');
  assert.equal(safeRequestPath('/api/status?token=synthetic-secret'), '/api/status');
});
test('request diagnostics conceal integration and path-based download capabilities', () => {
  for (const route of ['/hooks/synthetic-secret', '/j/synthetic-secret', '/__openclaw__/worker/synthetic-secret', '/__openclaw__/worker-transfer/synthetic-secret', '/api/artifacts/download/synthetic-secret'])
    assert.equal(safeRequestPath(route).includes('synthetic-secret'), false);
});
