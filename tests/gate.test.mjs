// Tests for request coalescing (ProblemGate) — run with: node --test tests/*.test.mjs
// The AI provider streams slowly so requests overlap; the Durable Object
// namespace is simulated (one instance per name, like Cloudflare's).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fakeD1 } from './helpers/fake-d1.mjs';

let aiCalls = 0;
const CHUNKS = ['data: {"choices":[{"delta":{"content":"---HINT1--- a"}}]}\n\n',
                'data: {"choices":[{"delta":{"content":" b"},"finish_reason":"stop"}]}\n\n', 'data: [DONE]\n\n'];
globalThis.fetch = async (url) => {
  if (String(url).endsWith('/models')) return Response.json({ data: [{ id: 'openai/gpt-oss-120b' }] });
  if (String(url).includes('leetcode.com/graphql')) return Response.json({ data: { topTwoContests: [] } });   // no contest running
  aiCalls++;
  const enc = new TextEncoder();
  return new Response(new ReadableStream({
    async start(c) {
      for (const chunk of CHUNKS) { await new Promise(r => setTimeout(r, 40)); c.enqueue(enc.encode(chunk)); }
      c.close();
    }
  }));
};
const { default: worker, ProblemGate } = await import('../backend/src/index.js');

function gateNamespace(env) {
  const instances = new Map();
  return {
    idFromName: name => name,
    get: id => {
      if (!instances.has(id)) instances.set(id, new ProblemGate({}, env));
      const gate = instances.get(id);
      return { fetch: (url, init) => gate.fetch(new Request(url, init)) };
    }
  };
}

const ask = (env, slug) => worker.fetch(new Request('https://api.test/v1/generate', {
  method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'chrome-extension://test' },
  body: JSON.stringify({ action: 'hints', problem: { slug, title: slug, difficulty: 'Easy', description: 'x', cppSnippet: '' } })
}), env, { waitUntil: () => {} });

test('10 users open the same new problem at once → ONE AI call, everyone gets the whole reply', async () => {
  const env = { GROQ_API_KEY: 'test', PROVIDER_ORDER: 'groq', DB: fakeD1() };
  env.GATE = gateNamespace(env);
  const before = aiCalls;
  const replies = await Promise.all(Array.from({ length: 10 }, () => ask(env, 'brand-new')));
  const texts = await Promise.all(replies.map(r => r.text()));
  assert.equal(aiCalls - before, 1);
  assert.ok(texts.every(t => t === CHUNKS.join('')), 'every reply is complete and identical');
  assert.deepEqual(replies.map(r => r.headers.get('X-LeetHint-Cache')).sort(), ['MISS', ...Array(9).fill('SHARED')]);
  // …and it was stored: the next user gets it from the cache
  await new Promise(r => setTimeout(r, 20));
  const later = await ask(env, 'brand-new');
  assert.equal(later.headers.get('X-LeetHint-Cache'), 'HIT');
  assert.equal(aiCalls - before, 1);
});

test('different problems are not merged', async () => {
  const env = { GROQ_API_KEY: 'test', PROVIDER_ORDER: 'groq', DB: fakeD1() };
  env.GATE = gateNamespace(env);
  const before = aiCalls;
  await Promise.all(['p-one', 'p-two'].map(s => ask(env, s).then(r => r.text())));
  assert.equal(aiCalls - before, 2);
});
