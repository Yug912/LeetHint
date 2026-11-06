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

test('concurrent calls on a fresh install share ONE id', async () => {
  store.clear();
  const { getInstallId } = await fresh();
  const ids = await Promise.all([getInstallId(), getInstallId(), getInstallId()]);
  assert.equal(new Set(ids).size, 1);
  assert.equal(ids[0], store.get('installId'));
});

test('side panel and service worker racing on a fresh install settle on the stored id', async () => {
  store.clear();
  const panel = await fresh(), worker = await fresh();   // two contexts = two module instances
  await Promise.all([panel.getInstallId(), worker.getInstallId()]);
  const stored = store.get('installId');
  assert.equal(await panel.getInstallId(), stored);
  assert.equal(await worker.getInstallId(), stored);
});

test('the static cache request never carries the install header', async () => {
  const { fetchStaticHints } = await import('../api/static.js');
  let headers;
  await fetchStaticHints('two-sum', { baseUrl: 'https://c.test', fetchImpl: async (url, init) => { headers = init.headers; return new Response('', { status: 404 }); } });
  assert.equal(headers, undefined);
});
