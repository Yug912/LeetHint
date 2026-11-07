// Tests for the shared QuotaKeeper — run with: node --test tests/*.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { QuotaKeeper } from '../backend/src/quota.js';

const T0 = Date.UTC(2026, 10, 7, 10, 0, 0);

// The Durable Object namespace: ONE keeper, shared by every caller
function quotaNamespace(env) {
  const keeper = new QuotaKeeper({}, env);
  return { keeper, idFromName: n => n, get: () => ({ fetch: (url, init) => keeper.fetch(new Request(url, init)) }) };
}

test('per-minute budget: shared, refused with the wait, fresh next minute', () => {
  const k = new QuotaKeeper({}, {});
  assert.deepEqual(k.reserve({ key: 'Groq/m', tokens: 5000, perMinute: 8000 }, T0), { ok: true });
  const refused = k.reserve({ key: 'Groq/m', tokens: 5000, perMinute: 8000 }, T0 + 10_000);
  assert.equal(refused.ok, false);
  assert.equal(refused.waitMs, 50_000);
  assert.deepEqual(k.reserve({ key: 'Groq/other', tokens: 5000, perMinute: 8000 }, T0), { ok: true });   // per model
  assert.deepEqual(k.reserve({ key: 'Groq/m', tokens: 5000, perMinute: 8000 }, T0 + 60_000), { ok: true });
  assert.deepEqual(k.reserve({ key: 'Workers AI/x', tokens: 50_000, perMinute: 0 }, T0), { ok: true });   // no known cap
});

test('trial share: personal AI stops at its daily cap; hints are never limited by it', () => {
  const k = new QuotaKeeper({}, { TRIAL_DAILY_TOKENS: '10000' });
  assert.equal(k.reserve({ key: 'a', tokens: 6000, trial: true }, T0).ok, true);
  assert.deepEqual(k.reserve({ key: 'a', tokens: 6000, trial: true }, T0), { ok: false, trialFull: true });
  assert.equal(k.reserve({ key: 'a', tokens: 6000 }, T0).ok, true);                          // a hint request
  assert.equal(k.reserve({ key: 'a', tokens: 6000, trial: true }, T0 + 86_400_000).ok, true); // next day
});

test('trial share defaults to 25% of the daily budget', () => {
  assert.equal(new QuotaKeeper({}, { DAILY_TOKENS: '2000000' }).trialBudget(), 500_000);
});

test('trial interviews: at most 3 at once, whole budget up front, slot freed after 40 minutes', () => {
  const k = new QuotaKeeper({}, { TRIAL_DAILY_TOKENS: '1000000' });
  for (const id of ['i1', 'i2', 'i3']) assert.deepEqual(k.admitInterview({ interviewId: id, tokens: 60_000 }, T0), { ok: true });
  assert.deepEqual(k.admitInterview({ interviewId: 'i1', tokens: 60_000 }, T0), { ok: true });   // same one again: fine
  assert.deepEqual(k.admitInterview({ interviewId: 'i4', tokens: 60_000 }, T0), { ok: false, reason: 'busy' });
  assert.deepEqual(k.admitInterview({ interviewId: 'i4', tokens: 60_000 }, T0 + 41 * 60_000), { ok: true });
  const small = new QuotaKeeper({}, { TRIAL_DAILY_TOKENS: '50000' });
  assert.deepEqual(small.admitInterview({ interviewId: 'x', tokens: 60_000 }, T0), { ok: false, reason: 'trialFull' });
});

test('two Worker copies share ONE per-minute budget: the second request moves to the next provider', async () => {
  globalThis.fetch = async url => String(url).endsWith('/models')
    ? Response.json({ data: [{ id: 'openai/gpt-oss-120b' }] })
    : new Response('data: {}\n\n');
  const env = { GROQ_API_KEY: 'test', PROVIDER_ORDER: 'groq,workersai', AI: { run: async () => new ReadableStream() } };
  env.QUOTA = quotaNamespace(env);
  // Each import is a separate copy with its own memory, like two Worker isolates
  const copy1 = await import('../backend/src/providers.js?copy=1');
  const copy2 = await import('../backend/src/providers.js?copy=2');
  const prompt = 'x'.repeat(7000);   // ~2,000 tokens + 4,000 reply → 6,000 of Groq's 8,000 a minute
  assert.equal((await copy1.openStream(env, prompt, { maxTokens: 4000 })).label, 'Groq (openai/gpt-oss-120b)');
  assert.equal((await copy2.openStream(env, prompt, { maxTokens: 4000 })).label, 'Workers AI (@cf/openai/gpt-oss-120b)');
});

test('a daily-limit pause seen by one copy is honoured by the others', async () => {
  globalThis.fetch = async url => String(url).endsWith('/models')
    ? Response.json({ data: [{ id: 'openai/gpt-oss-120b' }] })
    : Response.json({ error: { message: 'Rate limit reached for tokens per day (TPD). Please try again in 3h.' } }, { status: 429 });
  const env = { GROQ_API_KEY: 'test', PROVIDER_ORDER: 'groq,workersai', AI: { run: async () => new ReadableStream() } };
  env.QUOTA = quotaNamespace(env);
  const copy1 = await import('../backend/src/providers.js?copy=3');
  const copy2 = await import('../backend/src/providers.js?copy=4');
  await copy1.openStream(env, 'p', { maxTokens: 100 });           // Groq says "daily limit" → paused for everyone
  let groqCalls = 0;
  globalThis.fetch = async url => {
    if (String(url).endsWith('/models')) return Response.json({ data: [{ id: 'openai/gpt-oss-120b' }] });
    groqCalls++;
    return new Response('data: {}\n\n');
  };
  assert.equal((await copy2.openStream(env, 'p', { maxTokens: 100 })).label, 'Workers AI (@cf/openai/gpt-oss-120b)');
  assert.equal(groqCalls, 0);
});
