// One global quota (A11) — run with: node --test tests/*.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { QuotaBook, QuotaKeeper, quotaClient, SHARES } from '../backend/src/quota.js';

const T0 = Date.UTC(2026, 10, 20, 12);

test('the day is split 70 / 25 / 5', () => {
  assert.deepEqual(SHARES, { hints: 0.70, trial: 0.25, reserve: 0.05 });
  const b = new QuotaBook({}, 1000);
  assert.equal(b.reserve({ key: 'G/m', provider: 'G', tokens: 250, share: 'trial' }, T0).ok, true);
  assert.deepEqual(b.reserve({ key: 'G/m', provider: 'G', tokens: 1, share: 'trial' }, T0), { ok: false, reason: 'daily_share' });
  assert.equal(b.reserve({ key: 'G/m', provider: 'G', tokens: 700, share: 'hints' }, T0).ok, true);
  // hints may borrow the 5% reserve, trials may not
  assert.equal(b.reserve({ key: 'G/m', provider: 'G', tokens: 50, share: 'hints' }, T0).ok, true);
  assert.deepEqual(b.snapshot({}, T0).used, { hints: 700, trial: 250, reserve: 50 });
  assert.equal(b.reserve({ key: 'G/m', provider: 'G', tokens: 1, share: 'hints' }, T0).ok, false);
  assert.equal(b.snapshot({}, T0).byProvider.G, 1000);
});

test('the budget resets at midnight UTC', () => {
  const b = new QuotaBook({}, 1000);
  b.reserve({ key: 'k', tokens: 250, share: 'trial' }, T0);
  assert.equal(b.reserve({ key: 'k', tokens: 250, share: 'trial' }, T0 + 12 * 3600e3).ok, true);
});

test('paused models and providers are refused until their pause ends', () => {
  const b = new QuotaBook({}, 1e6);
  b.pause({ key: 'Groq/a', until: T0 + 1000 });
  b.pause({ key: 'Workers AI', until: T0 + 1000 });
  assert.deepEqual(b.reserve({ key: 'Groq/a', provider: 'Groq', tokens: 1 }, T0), { ok: false, reason: 'paused' });
  assert.equal(b.reserve({ key: 'Groq/b', provider: 'Groq', tokens: 1 }, T0).ok, true);
  assert.equal(b.reserve({ key: 'Workers AI/x', provider: 'Workers AI', tokens: 1 }, T0).ok, false);
  assert.equal(b.reserve({ key: 'Groq/a', provider: 'Groq', tokens: 1 }, T0 + 2000).ok, true);
  assert.deepEqual(Object.keys(b.snapshot({}, T0).paused).sort(), ['Groq/a', 'Workers AI']);
});

test('trial interviews: at most 3 at once, and only with ~60k trial tokens left', () => {
  const b = new QuotaBook({}, 1e6);
  for (const id of ['a', 'b', 'c']) assert.equal(b.admitInterview({ id }, T0).ok, true);
  assert.deepEqual(b.admitInterview({ id: 'd' }, T0), { ok: false, reason: 'busy' });
  assert.equal(b.admitInterview({ id: 'a' }, T0).ok, true);           // a running one is fine
  b.endInterview({ id: 'a' });
  assert.equal(b.admitInterview({ id: 'd' }, T0).ok, true);
  assert.equal(b.admitInterview({ id: 'e' }, T0 + 41 * 60e3).ok, true); // idle ones expire
  const poor = new QuotaBook({}, 200_000);                              // trial share = 50k < 60k
  assert.deepEqual(poor.admitInterview({ id: 'x' }, T0), { ok: false, reason: 'daily_share' });
});

test('the Durable Object keeps its book in storage across restarts', async () => {
  const store = new Map();
  const ctx = { storage: { get: async k => store.get(k), put: async (k, v) => { store.set(k, structuredClone(v)); } } };
  const env = { QUOTA_DAILY_TOKENS: '1000' };
  const ask = (dobj, op, args) => dobj.fetch(new Request(`https://quota/${op}`, { method: 'POST', body: JSON.stringify(args) })).then(r => r.json());
  let dobj = new QuotaKeeper(ctx, env);
  assert.equal((await ask(dobj, 'reserve', { key: 'k', tokens: 200, share: 'trial' })).ok, true);
  dobj = new QuotaKeeper(ctx, env);                                     // evicted and restarted
  assert.deepEqual(await ask(dobj, 'reserve', { key: 'k', tokens: 100, share: 'trial' }), { ok: false, reason: 'daily_share' });
});

test('client: Durable Object when bound, never throws when it fails', async () => {
  const env = { QUOTA: { idFromName: n => n, get: () => ({ fetch: async () => { throw new Error('down'); } }) } };
  const q = quotaClient(env);
  assert.deepEqual(await q.reserve({ key: 'k', tokens: 1 }), { ok: true });
  assert.deepEqual(await q.snapshot(), { buckets: {}, paused: {} });
});

test('server: trial share used up → trial_used, while hints keep working', async () => {
  globalThis.fetch = async (url) => {
    if (String(url).endsWith('/models')) return Response.json({ data: [{ id: 'openai/gpt-oss-120b' }] });
    return new Response('data: {"choices":[{"delta":{"content":"x"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');
  };
  const { default: worker } = await import('../backend/src/index.js?quota');
  const env = { GROQ_API_KEY: 't', PROVIDER_ORDER: 'groq', QUOTA_DAILY_TOKENS: '20000' };   // trial share: 5,000
  const call = action => worker.fetch(new Request('https://api.test/v1/generate', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'chrome-extension://test' },
    body: JSON.stringify({ action, problem: { slug: 'two-sum', title: 'Two Sum', difficulty: 'Easy', description: 'x' }, code: 'class Solution {};' })
  }), env, { waitUntil() {} });
  assert.equal((await call('fix')).status, 200);        // ~4,000 tokens
  const r = await call('fix');
  assert.equal(r.status, 403);
  assert.equal((await r.json()).error, 'trial_used');
  assert.equal((await call('hints')).status, 200);
});
