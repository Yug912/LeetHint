// The shared cache in D1 with KV as read fallback (A8) — run with: node --test tests/*.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fakeD1 } from './helpers/fake-d1.mjs';
import { readCache, writeCache } from '../backend/src/store.js';

let aiCalls = 0;
globalThis.fetch = async (url) => {
  if (String(url).endsWith('/models')) return Response.json({ data: [{ id: 'openai/gpt-oss-120b' }] });
  aiCalls++;
  return new Response('data: {"choices":[{"delta":{"content":"---HINT1--- ok"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');
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

test('rows older than 30 days count as a miss', async () => {
  const env = { DB: fakeD1() };
  await writeCache(env, 'old', 'x', 'openai', Date.now() - 31 * 24 * 3600 * 1000);
  assert.equal(await readCache(env, 'old'), null);
});
