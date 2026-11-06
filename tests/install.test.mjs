// Tests for the anonymous install ID (api/install.js) — run with: node --test tests/*.test.mjs
// chrome.storage.local is simulated with a Map.
import { test } from 'node:test';
import assert from 'node:assert/strict';

const store = new Map();
globalThis.chrome = {
  storage: {
    local: {
      get: async key => (store.has(key) ? { [key]: store.get(key) } : {}),
      set: async obj => { for (const [k, v] of Object.entries(obj)) store.set(k, v); }
    }
  }
};

let run = 0;
const fresh = () => import(`../api/install.js?run=${++run}`);

test('creates one UUID and keeps it', async () => {
  store.clear();
  const { getInstallId } = await fresh();
  const a = await getInstallId();
  assert.match(a, /^[0-9a-f-]{36}$/);
  assert.equal(store.get('installId'), a);
  assert.equal(await getInstallId(), a);
});

test('the same ID survives an extension reload', async () => {
  const before = store.get('installId');
  const { getInstallId } = await fresh();   // a new module instance = reloaded extension
  assert.equal(await getInstallId(), before);
});

test('serverHeaders adds X-LeetHint-Install and keeps other headers', async () => {
  const { serverHeaders } = await fresh();
  const h = await serverHeaders({ 'Content-Type': 'application/json' });
  assert.equal(h['Content-Type'], 'application/json');
  assert.equal(h['X-LeetHint-Install'], store.get('installId'));
});

test('storage failure → no header, no error', async () => {
  const saved = globalThis.chrome.storage.local.get;
  globalThis.chrome.storage.local.get = async () => { throw new Error('storage gone'); };
  const { serverHeaders } = await fresh();
  assert.deepEqual(await serverHeaders({ a: '1' }), { a: '1' });
  globalThis.chrome.storage.local.get = saved;
});
