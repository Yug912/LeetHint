// Tests for /config (api/remote.js) — run with: node --test tests/*.test.mjs
// fetch, storage and timers are simulated.
import { test } from 'node:test';
import assert from 'node:assert/strict';

const store = new Map();
const storage = {
  get: async keys => Object.fromEntries([].concat(keys).filter(k => store.has(k)).map(k => [k, store.get(k)])),
  set: async obj => { for (const [k, v] of Object.entries(obj)) store.set(k, v); }
};
globalThis.chrome = { storage: { local: storage } };

const { getRemoteConfig, normalizeConfig, REMOTE_DEFAULTS, CONFIG_MAX_AGE_MS } = await import('../api/remote.js');

// ── /config ──
test('/config: missing endpoint, server off, HTML or a hang → everything on, no message', async () => {
  const base = { storage, baseUrl: 'https://w.test' };
  const hang = (url, { signal }) => new Promise((_, reject) => signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))));
  for (const fetchImpl of [
    async () => new Response('Not found', { status: 404 }),
    async () => { throw new TypeError('offline'); },
    async () => new Response('<html>', { status: 200 }),
    hang
  ]) {
    store.clear();
    assert.deepEqual(await getRemoteConfig({ ...base, fetchImpl }), { ...REMOTE_DEFAULTS });
  }
});

test('/config failing: asked at most once an hour, not on every panel open', async () => {
  store.clear();
  let calls = 0;
  const fetchImpl = async () => { calls++; return new Response('Not found', { status: 404 }); };
  const t0 = 5_000_000;
  for (let i = 0; i < 5; i++) await getRemoteConfig({ storage, fetchImpl, now: t0 + i * 60_000, baseUrl: 'https://w.test' });
  assert.equal(calls, 1);
  await getRemoteConfig({ storage, fetchImpl, now: t0 + CONFIG_MAX_AGE_MS, baseUrl: 'https://w.test' });
  assert.equal(calls, 2);
});

test('/config: concurrent callers share one request', async () => {
  store.clear();
  let calls = 0;
  const fetchImpl = async () => { calls++; await new Promise(r => setTimeout(r, 20)); return Response.json({ fix: false }); };
  const [a, b] = await Promise.all([getRemoteConfig({ storage, fetchImpl, baseUrl: 'https://w.test' }), getRemoteConfig({ storage, fetchImpl, baseUrl: 'https://w.test' })]);
  assert.equal(calls, 1);
  assert.equal(a.fix, false);
  assert.equal(b.fix, false);
});

test('/config: remoteConfigOverride (testing aid) wins with no request', async () => {
  store.clear();
  store.set('remoteConfigOverride', { interview: false, message: '  Server maintenance tonight  ' });
  let calls = 0;
  const c = await getRemoteConfig({ storage, fetchImpl: async () => { calls++; return Response.json({}); }, baseUrl: 'https://w.test' });
  assert.equal(calls, 0);
  assert.equal(c.interview, false);
  assert.equal(c.message, 'Server maintenance tonight');
  store.delete('remoteConfigOverride');
});

test('/config: message capped at 200 characters', () => {
  assert.equal(normalizeConfig({ message: 'x'.repeat(500) }).message.length, 200);
});

test('/config: fetched at most once an hour', async () => {
  store.clear();
  let calls = 0;
  const fetchImpl = async () => { calls++; return Response.json({ interview: false, message: 'Maintenance tonight' }); };
  const t0 = 1_000_000;
  const a = await getRemoteConfig({ storage, fetchImpl, now: t0, baseUrl: 'https://w.test' });
  assert.equal(a.interview, false);
  assert.equal(a.fix, true);
  assert.equal(a.message, 'Maintenance tonight');
  await getRemoteConfig({ storage, fetchImpl, now: t0 + CONFIG_MAX_AGE_MS - 1, baseUrl: 'https://w.test' });
  assert.equal(calls, 1);
  await getRemoteConfig({ storage, fetchImpl, now: t0 + CONFIG_MAX_AGE_MS, baseUrl: 'https://w.test' });
  assert.equal(calls, 2);
  assert.deepEqual(Object.keys(store.get('remoteConfig')).sort(), ['at', 'value']);
});

test('/config: only well-typed fields count', () => {
  const c = normalizeConfig({ interview: 'no', fix: false, trialInterviewMinutes: 15, trialFixesPerDay: -1, message: 42, extra: 1 });
  assert.equal(c.interview, true);           // not a boolean → default
  assert.equal(c.fix, false);
  assert.equal(c.trialInterviewMinutes, 15);
  assert.equal(c.trialFixesPerDay, null);
  assert.equal(c.message, '');
  assert.equal('extra' in c, false);
});
