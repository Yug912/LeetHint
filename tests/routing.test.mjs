// Tests for backend model routing — run with: node --test tests/*.test.mjs
// Groq and Workers AI are simulated; `busy` models answer 429 (rate limited).
import { test } from 'node:test';
import assert from 'node:assert/strict';

const GROQ_MODELS = ['openai/gpt-oss-120b', 'openai/gpt-oss-20b', 'qwen/qwen3.8-27b'];
let run = 0;

// A fresh copy of providers.js per test, so rate-limit memory doesn't leak between tests
async function setup(busy = []) {
  const { openStream } = await import(`../backend/src/providers.js?run=${++run}`);
  globalThis.fetch = async (url, init) => {
    if (String(url).endsWith('/models')) return Response.json({ data: GROQ_MODELS.map(id => ({ id })) });
    const { model } = JSON.parse(init.body);
    if (busy.includes(model)) {
      return Response.json({ error: { message: 'Rate limit reached for tokens per minute (TPM). Please try again in 30s.' } }, { status: 429 });
    }
    return new Response('data: {}\n\n');
  };
  const env = {
    GROQ_API_KEY: 'test', PROVIDER_ORDER: 'groq,workersai',
    AI: { run: async () => new ReadableStream({ start: c => c.close() }) }
  };
  return tier => openStream(env, 'prompt', { tier, maxTokens: 1000 }).then(r => r.label);
}

test('each feature starts on its own model', async () => {
  const pick = await setup();
  assert.equal(await pick('main'), 'Groq (openai/gpt-oss-120b)');        // hints
  assert.equal(await pick('interview'), 'Groq (qwen/qwen3.8-27b)');      // interview turns
  assert.equal(await pick('judge'), 'Groq (openai/gpt-oss-120b)');       // scorecard
  assert.equal(await pick('fast'), 'Groq (openai/gpt-oss-20b)');         // translations
});

test('interview: busy model → next strong model, never the small one first', async () => {
  let pick = await setup(['qwen/qwen3.8-27b']);
  assert.equal(await pick('interview'), 'Groq (openai/gpt-oss-120b)');
  pick = await setup(['qwen/qwen3.8-27b', 'openai/gpt-oss-120b']);
  assert.equal(await pick('interview'), 'Workers AI (@cf/openai/gpt-oss-120b)');
});

test('scorecard: busy 120b → qwen', async () => {
  const pick = await setup(['openai/gpt-oss-120b']);
  assert.equal(await pick('judge'), 'Groq (qwen/qwen3.8-27b)');
});

test('a server error on one Gemini model moves on to its next model, not to another provider', async () => {
  const { openStream } = await import(`../backend/src/providers.js?run=${++run}`);
  globalThis.fetch = async (url) => /gemini-3\.8-flash/.test(String(url))
    ? new Response('', { status: 524 })                       // the first model times out
    : new Response('data: {}\n\n');
  const env = { GEMINI_API_KEY: 'test', PROVIDER_ORDER: 'gemini,workersai', AI: { run: async () => new ReadableStream() } };
  const { label } = await openStream(env, 'prompt', { tier: 'main', maxTokens: 1000 });
  assert.equal(label, 'Gemini (gemini-flash-latest)');
});

test('Hard: a model that would cut the reply short goes after one with the full budget', async () => {
  const pick = await setup();
  // Groq's 8k tokens/minute can't fit a 7,000-token Hard reply → Workers AI first
  const { openStream } = await import(`../backend/src/providers.js?run=${++run}`);
  const env = { GROQ_API_KEY: 'test', PROVIDER_ORDER: 'groq,workersai', AI: { run: async () => new ReadableStream({ start: c => c.close() }) } };
  const realisticPrompt = 'x'.repeat(10000);   // ~2,900 tokens, like a real Hard problem
  assert.equal((await openStream(env, realisticPrompt, { tier: 'hard', maxTokens: 7000 })).label, 'Workers AI (@cf/openai/gpt-oss-120b)');
  // A small Hard request that fits → Groq's 120b, never the 20b
  assert.equal(await pick('hard'), 'Groq (openai/gpt-oss-120b)');
});

test('hints: busy 120b → another model still answers', async () => {
  const pick = await setup(['openai/gpt-oss-120b']);
  assert.notEqual(await pick('main'), 'Groq (openai/gpt-oss-120b)');
});
