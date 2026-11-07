// Merge identical requests (A10) — run with: node --test tests/*.test.mjs
// The Durable Object runtime is simulated: one ProblemGate instance per name.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fakeD1 } from './helpers/fake-d1.mjs';

let providerCalls = 0;
const REPLY = ['data: {"choices":[{"delta":{"content":"---HINT1--- a"}}]}\n\n',
               'data: {"choices":[{"delta":{"content":" b"}}]}\n\n',
               'data: {"choices":[{"delta":{"content":" c"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n'];
globalThis.fetch = async (url) => {
  if (String(url).endsWith('/models')) return Response.json({ data: [{ id: 'openai/gpt-oss-120b' }] });
  providerCalls++;
  // A slow stream, so the other requests arrive while it's still being written
  const enc = new TextEncoder();
  return new Response(new ReadableStream({
    async start(c) { for (const piece of REPLY) { await new Promise(r => setTimeout(r, 15)); c.enqueue(enc.encode(piece)); } c.close(); }
  }));
};
const { default: worker, ProblemGate } = await import('../backend/src/index.js?gate');

function fakeNamespace(Cls, env) {
  const objects = new Map();
  return {
    idFromName: name => name,
    get: id => {
      if (!objects.has(id)) objects.set(id, new Cls({ storage: {} }, env));
      const obj = objects.get(id);
      return { fetch: (url, init) => obj.fetch(new Request(url, init)) };
    }
  };
}

test('10 parallel requests for one new problem → 1 provider call, all get the full reply', async () => {
  const env = { GROQ_API_KEY: 't', PROVIDER_ORDER: 'groq', DB: fakeD1() };
  env.GATE = fakeNamespace(ProblemGate, env);
  const call = () => worker.fetch(new Request('https://api.test/v1/generate', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'chrome-extension://test' },
    body: JSON.stringify({ action: 'hints', problem: { slug: 'brand-new', title: 'New', difficulty: 'Easy', description: 'x' } })
  }), env, { waitUntil() {} });
  const replies = await Promise.all(Array.from({ length: 10 }, call));
  const texts = await Promise.all(replies.map(r => r.text()));
  assert.equal(providerCalls, 1);
  for (const t of texts) assert.equal(t, REPLY.join(''));
  assert.equal(replies.filter(r => /\[joined\]/.test(r.headers.get('X-LeetHint-Model'))).length, 9);
  await new Promise(r => setTimeout(r, 20));
  assert.equal(env.DB.db.prepare('SELECT COUNT(*) AS n FROM cache').get().n, 1);   // the gate wrote the cache
  const again = await call();
  assert.equal(again.headers.get('X-LeetHint-Cache'), 'HIT');
  assert.equal(providerCalls, 1);
});

test('a gate whose provider is busy answers busy, and the next request tries again', async () => {
  const real = globalThis.fetch;
  globalThis.fetch = async () => Response.json({ error: { message: 'Rate limit reached. Please try again in 30s.' } }, { status: 429 });
  const env = { GROQ_API_KEY: 't', PROVIDER_ORDER: 'groq', DB: fakeD1() };
  env.GATE = fakeNamespace(ProblemGate, env);
  const call = () => worker.fetch(new Request('https://api.test/v1/generate', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'chrome-extension://test' },
    body: JSON.stringify({ action: 'hints', problem: { slug: 'busy-one', title: 'B', difficulty: 'Easy', description: 'x' } })
  }), env, { waitUntil() {} });
  const r = await call();
  assert.equal(r.status, 429);
  assert.equal((await r.json()).error, 'busy');
  globalThis.fetch = real;
  const ok = await call();
  assert.equal(ok.status, 200);
  await ok.text();
});
