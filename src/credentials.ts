import { AsyncLocalStorage } from 'node:async_hooks';
import type { RequestCredentials } from './types.js';

// Request-scoped credential store. In gateway mode the HTTP layer runs each
// request inside runWithCredentials(); the client reads from it and, when a
// scope exists, never falls back to process.env (CWE-306). Outside a scope
// (stdio / single-tenant) the client reads TDSYNNEX_* from process.env.
const credStore = new AsyncLocalStorage<RequestCredentials>();

export function runWithCredentials<T>(creds: RequestCredentials, fn: () => T): T {
  return credStore.run(creds, fn);
}

export function scopedCredentials(): RequestCredentials | undefined {
  return credStore.getStore();
}
