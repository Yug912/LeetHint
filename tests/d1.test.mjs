// The shared cache in D1 with KV as read fallback (A8) — run with: node --test tests/*.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fakeD1 } from './helpers/fake-d1.mjs';
import { readCache, writeCache } from '../backend/src/store.js';

let aiCalls = 0;
globalThis.fetch = async (url) => {
  if (String(url).endsWith('/models')) return Response.json({ data: [{ id: 'openai/gpt-oss-120b' }] });
  aiCalls++;
  return new Response('data: {"choices":[{"delta":{"content":"---HINT1--- ok ---HINT2--- ok ---HINT3--- ok ---HINT4--- ok"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');
};
const { default: worker } = await import('../backend/src/index.js?d1');
const problem = { slug: 'two-sum', title: 'Two Sum', difficulty: 'Easy', description: 'Find two numbers.' };

async function hints(env, slug = 'two-sum') {
  const pending = [];
  const res = await worker.fetch(new Request('https://api.test/v1/generate', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'chrome-extension://test' },
    body: JSON.stringify({ action: 'hints', problem: { ...problem, slug } })
  }), env, { waitUntil: p => pending.push(p) });
  await res.text();
  await Promise.all(pending);
  return res.headers.get('X-LeetHint-Cache');
}

test('miss → hit through D1', async () => {
  const DB = fakeD1();
  const env = { GROQ_API_KEY: 't', PROVIDER_ORDER: 'groq', DB };
  assert.equal(await hints(env), 'MISS');
  assert.equal(DB.db.prepare('SELECT COUNT(*) AS n FROM cache').get().n, 1);
  assert.equal(await hints(env), 'HIT');
  assert.equal(aiCalls, 1);
});

test('KV is still read as a fallback, D1 receives new writes', async () => {
  const DB = fakeD1();
  const kv = new Map([['k1', 'old reply']]);
  const env = { DB, HINTS_CACHE: { getWithMetadata: async k => ({ value: kv.get(k) ?? null, metadata: { kind: 'gemini' } }), put: async () => assert.fail('no KV writes') } };
  assert.deepEqual(await readCache(env, 'k1'), { raw: 'old reply', kind: 'gemini', layer: 'kv' });
  await writeCache(env, 'k2', 'new reply', 'openai');
  assert.deepEqual(await readCache(env, 'k2'), { raw: 'new reply', kind: 'openai', layer: 'd1' });
});

test('translations and fixes older than 30 days count as a miss', async () => {
  const env = { DB: fakeD1() };
  const old = Date.now() - 31 * 24 * 3600 * 1000;
  await writeCache(env, 'old', 'x', 'openai', old);
  await writeCache(env, 'p9:translate-java:two-sum:abc', 'x', 'openai', old);
  assert.equal(await readCache(env, 'old'), null);
  assert.equal(await readCache(env, 'p9:translate-java:two-sum:abc'), null);
});

test('hints and solutions never expire (D1 and the KV-only setup)', async () => {
  const env = { DB: fakeD1() };
  const year = Date.now() - 400 * 24 * 3600 * 1000;
  for (const key of ['p9:hints:two-sum:abc', 'p9:hints-python3:two-sum:abc', 'p9:solve:two-sum:abc']) {
    await writeCache(env, key, 'x', 'openai', year);
    assert.equal((await readCache(env, key))?.layer, 'd1', key);
  }
  const puts = [];
  const kvOnly = { HINTS_CACHE: { put: async (k, v, opts) => puts.push([k, opts]) } };
  await writeCache(kvOnly, 'p9:hints:two-sum:abc', 'x', 'openai');
  await writeCache(kvOnly, 'p9:translate-java:two-sum:abc', 'x', 'openai');
  assert.equal(puts[0][1].expirationTtl, undefined);
  assert.equal(puts[1][1].expirationTtl, 30 * 24 * 3600);
});

test('the KV fallback ends after KV_FALLBACK_UNTIL, and a KV failure is a miss', async () => {
  const { kvFallbackOpen } = await import('../backend/src/store.js');
  const DB = { prepare: () => ({ bind: () => ({ first: async () => null }) }) };
  const HINTS_CACHE = { getWithMetadata: async () => ({ value: 'old', metadata: { kind: 'openai' } }) };
  const env = { DB, HINTS_CACHE, KV_FALLBACK_UNTIL: '2026-12-15' };
  assert.equal(kvFallbackOpen(env, Date.parse('2026-12-15T23:00:00Z')), true);
  assert.equal(kvFallbackOpen(env, Date.parse('2026-12-16T00:00:01Z')), false);
  assert.equal(kvFallbackOpen({ DB }), true);                       // no date → open
  assert.equal(kvFallbackOpen({ HINTS_CACHE, KV_FALLBACK_UNTIL: '2000-01-01' }), true);   // no D1 → KV is the store
  assert.equal((await readCache(env, 'k', Date.parse('2026-12-01T00:00:00Z')))?.layer, 'kv');
  assert.equal(await readCache(env, 'k', Date.parse('2026-12-20T00:00:00Z')), null);
  const broken = { DB, HINTS_CACHE: { getWithMetadata: async () => { throw new Error('KV down'); } } };
  assert.equal(await readCache(broken, 'k'), null);
});

// A finished reply that leaked raw reasoning and mangled the ---TAG---
// delimiters must not be cached: the extension can't parse it, and every
// later user would get the same error (seen live on Coin Change, p9).
import { hasRequiredSections } from '../backend/src/store.js';
const sse = (...parts) => parts.map(p => `data: {"choices":[{"delta":{"content":${JSON.stringify(p)}}}]}\n\n`).join('') + 'data: [DONE]\n\n';

test('cache check: hints need all four hint sections, split across chunks is fine', () => {
  const good = sse('---APP', 'ROACH--- x\n---', 'HINT1--- a\n---HINT2--- b\n', '---HINT3--- c\n---HINT4', '--- d\n---END---');
  assert.equal(hasRequiredSections(good, 'p9:hints:two-sum:abc'), true);
  assert.equal(hasRequiredSections(good, 'p9:hints-python3:two-sum:abc'), true);
  assert.equal(hasRequiredSections(sse('---HINT1--- a ---HINT2--- b'), 'p9:hints:two-sum:abc'), false);
});

test('cache check: leaked reasoning and chat tokens are refused', () => {
  const leaked = sse('analysis: We need to produce final answer\n--- H hint1: ask\n', '---HINT1--- a ---HINT2--- b ---HINT3--- c ---HINT4--- d\n--- END---<|return|>');
  assert.equal(hasRequiredSections(leaked, 'p9:hints:coin-change:abc'), false);
  assert.equal(hasRequiredSections(sse('analysis: think\n--- H hint1 x\n--- CODE---'), 'p9:hints:coin-change:abc'), false);
});

test('cache check: solve/fix need a CODE section; other actions are not checked', () => {
  assert.equal(hasRequiredSections(sse('---APPROACH--- x\n---CODE---\n```cpp\nint f();\n```'), 'p9:solve:two-sum:abc'), true);
  assert.equal(hasRequiredSections(sse('---APPROACH--- x only'), 'p9:solve:two-sum:abc'), false);
  assert.equal(hasRequiredSections(sse('---APPROACH--- x only'), 'p9:fix-signature:two-sum:abc'), false);
  assert.equal(hasRequiredSections(sse('def f(): pass'), 'p9:translate-python3:two-sum:abc'), true);
  const gemini = 'data: {"candidates":[{"content":{"parts":[{"text":"---HINT1--- a ---HINT2--- b ---HINT3--- c ---HINT4--- d"}]},"finishReason":"STOP"}]}\n\n';
  assert.equal(hasRequiredSections(gemini, 'p9:hints:two-sum:abc'), true);
  const workersai = 'data: {"response":"---HINT1--- a ---HINT2--- b "}\n\ndata: {"response":"---HINT3--- c ---HINT4--- d"}\n\ndata: [DONE]\n\n';
  assert.equal(hasRequiredSections(workersai, 'p9:hints:two-sum:abc'), true);
});
