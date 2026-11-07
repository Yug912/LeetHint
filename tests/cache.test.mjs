// Tests for the server's shared hints cache — run with: node --test tests/*.test.mjs
// The AI provider and Cloudflare KV are simulated.
import { test } from 'node:test';
import assert from 'node:assert/strict';

let aiCalls = 0;
globalThis.fetch = async (url) => {
  if (String(url).endsWith('/models')) return Response.json({ data: [{ id: 'openai/gpt-oss-120b' }] });
  if (String(url).includes('leetcode.com/graphql')) return Response.json({ data: { topTwoContests: [] } });   // no contest running
  aiCalls++;
  return new Response('data: {"choices":[{"delta":{"content":"---HINT1--- ok"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');
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
const problem = { slug: 'two-sum', title: 'Two Sum', difficulty: 'Easy', description: 'Find two numbers that add up to target.', cppSnippet: 'class Solution {};' };

async function hints(language) {
  const pending = [];
  const res = await worker.fetch(new Request('https://api.test/v1/generate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: 'chrome-extension://test' },
    body: JSON.stringify({ action: 'hints', problem, ...(language ? { language, snippet: 'class Solution {};' } : {}) })
  }), env, { waitUntil: p => pending.push(p) });
  await res.text();
  await Promise.all(pending);
  return res.headers.get('X-LeetHint-Cache');
}

test('one generation serves every language', async () => {
  assert.equal(await hints('python3'), 'MISS');   // first user ever: Python
  assert.equal(aiCalls, 1);
  assert.equal(kv.size, 2);                       // saved as Python AND as the shared copy
  assert.equal(await hints(), 'HIT');             // C++ user
  assert.equal(await hints('java'), 'HIT');       // Java user: shared copy, translated later
  assert.equal(await hints('python3'), 'HIT');    // another Python user
  assert.equal(aiCalls, 1);                       // the AI ran only once
});
