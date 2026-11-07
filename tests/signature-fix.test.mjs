// Server cache for the automatic signature fix (task A2) — run with: node --test tests/*.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';

let aiCalls = 0;
globalThis.fetch = async (url) => {
  if (String(url).endsWith('/models')) return Response.json({ data: [{ id: 'openai/gpt-oss-120b' }] });
  aiCalls++;
  return new Response('data: {"choices":[{"delta":{"content":"---CODE--- ok"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');
};
const { default: worker } = await import('../backend/src/index.js?sigfix');

const kv = new Map();
const env = {
  GROQ_API_KEY: 'test', PROVIDER_ORDER: 'groq',
  HINTS_CACHE: {
    getWithMetadata: async k => kv.has(k) ? { value: kv.get(k), metadata: { kind: 'openai' } } : { value: null },
    put: async (k, v) => { kv.set(k, v); }
  }
};
const problem = { slug: 'two-sum', title: 'Two Sum', difficulty: 'Easy', description: 'Find two numbers.', cppSnippet: 'class Solution { vector<int> twoSum(); };' };

async function fix(extra) {
  const pending = [];
  const res = await worker.fetch(new Request('https://api.test/v1/generate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: 'chrome-extension://test' },
    body: JSON.stringify({ action: 'fix', problem, code: 'class Solution { int two_sum(); };', ...extra })
  }), env, { waitUntil: p => pending.push(p) });
  await res.text();
  await Promise.all(pending);
  return res.headers.get('X-LeetHint-Cache');
}

test('signature fix: MISS then HIT, stored under p7:fix-signature', async () => {
  assert.equal(await fix({ reason: 'signature' }), 'MISS');
  assert.equal(await fix({ reason: 'signature' }), 'HIT');
  assert.equal(aiCalls, 1);
  assert.ok([...kv.keys()].every(k => /^p\d+:fix-signature:two-sum:[0-9a-f]{64}$/.test(k)));
});

test('a fix with a failing test, or without the reason, is never cached', async () => {
  const before = kv.size;
  assert.equal(await fix({ reason: 'signature', failure: 'Expected: [0,1]' }), 'MISS');
  assert.equal(await fix({ reason: 'signature', failure: 'Expected: [0,1]' }), 'MISS');
  assert.equal(await fix({}), 'MISS');
  assert.equal(await fix({}), 'MISS');
  assert.equal(kv.size, before);
});
