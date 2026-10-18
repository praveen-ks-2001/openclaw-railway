import { AsyncLocalStorage } from 'node:async_hooks';

const ownerContext = new AsyncLocalStorage();
let active = null;
let bootFailure = null;
let shuttingDown = false;
const readers = new Set();
function unavailable(message, status) { const error = new Error(message); error.status = status; return error; }
export const getBootFailure = () => bootFailure;
export const setBootFailure = (value) => { bootFailure = value || null; };
export const isOperationActive = () => Boolean(active || shuttingDown);
export const isCurrentOperationOwner = () => active !== null && ownerContext.getStore() === active;
export const getOperationSignal = () => isCurrentOperationOwner() ? active.controller.signal : undefined;
export const getOperationState = () => ({ active: Boolean(active), name: active?.name || null, bootFailure, shuttingDown });
export function assertOperationsAvailable() {
  if (shuttingDown) throw unavailable('The service is shutting down', 503);
  if (active && !isCurrentOperationOwner()) throw unavailable('Another maintenance operation is running. Try again when it finishes.', 409);
  if (bootFailure) throw unavailable('Upgrade recovery requires attention. Use Admin recovery to deliberately retry, or restore a compatible backup.', 503);
}
export async function withStateRead(name, action) {
  if (isCurrentOperationOwner()) return action({ name, signal: active.controller.signal });
  assertOperationsAvailable();
  const controller = new AbortController();
  const record = { controller, done: null };
  // Register before yielding: a mutation closes admission and drains readers.
  readers.add(record);
  record.done = Promise.resolve().then(() => action({ name, signal: controller.signal }));
  try { return await record.done; }
  finally { readers.delete(record); }
}
export async function withExclusiveOperation(name, action, { signal, allowBootFailure = false } = {}) {
  if (shuttingDown) throw unavailable('The service is shutting down', 503);
  if (active) throw unavailable('Another maintenance operation is running. Try again when it finishes.', 409);
  if (bootFailure && !allowBootFailure) throw unavailable('Upgrade recovery requires attention before changing this installation.', 503);
  const controller = new AbortController();
  const owner = { name, controller, done: null };
  const abort = () => controller.abort(signal.reason);
  if (signal?.aborted) abort();
  else signal?.addEventListener('abort', abort, { once: true });
  active = owner;
  owner.done = ownerContext.run(owner, async () => {
    await Promise.allSettled([...readers].map((reader) => reader.done));
    if (controller.signal.aborted) throw controller.signal.reason || unavailable('Operation cancelled', 499);
    return action({ name, signal: controller.signal });
  });
  try { return await owner.done; }
  finally { signal?.removeEventListener('abort', abort); if (active === owner) active = null; }
}
export async function stopOperations() {
  shuttingDown = true;
  for (const reader of readers) reader.controller.abort(new Error('Service shutting down'));
  active?.controller.abort(new Error('Service shutting down'));
  try { await active?.done; } catch {}
  await Promise.allSettled([...readers].map((reader) => reader.done));
}
