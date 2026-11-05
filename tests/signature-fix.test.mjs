// Tests for caching the automatic signature fix (contract item 8) — run with: node --test tests/*.test.mjs
// The AI provider and Cloudflare KV are simulated, as in tests/cache.test.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';

let aiCalls = 0;
globalThis.fetch = async (url) => {
  if (String(url).endsWith('/models')) return Response.json({ data: [{ id: 'openai/gpt-oss-120b' }] });
  aiCalls++;
  return new Response('data: {"choices":[{"delta":{"content":"---CODE--- fixed"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');
};
const { default: worker } = await import('../backend/src/index.js');

const kv = new Map();
const env = {
  GROQ_API_KEY: 'test', PROVIDER_ORDER: 'groq',
  HINTS_CACHE: {
    getWithMetadata: async k => kv.has(k) ? { value: kv.get(k), metadata: { kind: 'openai' } } : { value: null },
    put: async (k, v) => { kv.set(k, v); }
  }
};
const problem = { slug: 'two-sum', title: 'Two Sum', difficulty: 'Easy', description: 'Find two numbers that add up to target.',
                  cppSnippet: 'class Solution {\npublic:\n    vector<int> twoSum(vector<int>& nums, int target) {\n    }\n};' };
const cachedCode = 'class Solution {\npublic:\n    vector<int> two_sum(vector<int>& nums, int target) { return {}; }\n};';

async function fix(fields) {
  const pending = [];
  const res = await worker.fetch(new Request('https://api.test/v1/generate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: 'chrome-extension://test' },
    body: JSON.stringify({ action: 'fix', problem, code: cachedCode, ...fields })
  }), env, { waitUntil: p => pending.push(p) });
  assert.equal(res.status, 200);
  await res.text();
  await Promise.all(pending);
  return res.headers.get('X-LeetHint-Cache');
}

const fixKeys = () => [...kv.keys()].filter(k => k.includes(':fix'));

test('two identical signature fixes: MISS then HIT, one AI call, stored under p7:fix-signature', async () => {
  const before = aiCalls;
  assert.equal(await fix({ reason: 'signature' }), 'MISS');
  assert.equal(await fix({ reason: 'signature' }), 'HIT');
  assert.equal(aiCalls - before, 1);
  assert.equal(fixKeys().length, 1);
  assert.match(fixKeys()[0], /^p7:fix-signature:two-sum:[0-9a-f]{64}$/);
});

test('other code fills only its own key — the shared fix is untouched', async () => {
  const shared = fixKeys()[0];
  const sharedValue = kv.get(shared);
  const pending = [];
  const res = await worker.fetch(new Request('https://api.test/v1/generate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: 'chrome-extension://test' },
    body: JSON.stringify({ action: 'fix', reason: 'signature', problem, code: 'class Solution { /* poisoned */ };' })
  }), env, { waitUntil: p => pending.push(p) });
  await res.text();
  await Promise.all(pending);
  assert.equal(res.headers.get('X-LeetHint-Cache'), 'MISS');
  assert.equal(fixKeys().length, 2);
  assert.equal(kv.get(shared), sharedValue);
});

test('a fix with a failure field is never cached, even with reason: "signature"', async () => {
  const keysBefore = kv.size, callsBefore = aiCalls;
  const failure = 'Input: nums = [3,3], target = 6\nOutput: []\nExpected: [0,1]';
  assert.equal(await fix({ failure }), 'MISS');
  assert.equal(await fix({ failure }), 'MISS');
  assert.equal(await fix({ reason: 'signature', failure }), 'MISS');
  assert.equal(await fix({ reason: 'signature', failure }), 'MISS');
  assert.equal(aiCalls - callsBefore, 4);
  assert.equal(kv.size, keysBefore);
});

test('a plain fix (no reason) stays uncached', async () => {
  const keysBefore = kv.size, callsBefore = aiCalls;
  assert.equal(await fix({}), 'MISS');
  assert.equal(await fix({ reason: 'other' }), 'MISS');
  assert.equal(aiCalls - callsBefore, 2);
  assert.equal(kv.size, keysBefore);
});
