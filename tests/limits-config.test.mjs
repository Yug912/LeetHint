// Per-install rate limit (A6) and GET /config (A7) — run with: node --test tests/*.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';

globalThis.fetch = async (url) => {
  if (String(url).endsWith('/models')) return Response.json({ data: [{ id: 'openai/gpt-oss-120b' }] });
  return new Response('data: {"choices":[{"delta":{"content":"x"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');
};
const { default: worker } = await import('../backend/src/index.js?limits');

// Same semantics as the Workers Rate Limiting binding: `limit` per key per window
function fakeLimiter(limit) {
  const used = new Map();
  return { limit: async ({ key }) => { used.set(key, (used.get(key) || 0) + 1); return { success: used.get(key) <= limit }; } };
}

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const problem = { slug: 'two-sum', title: 'Two Sum', difficulty: 'Easy', description: 'x' };

function call(env, install, ip = '1.2.3.4') {
  return worker.fetch(new Request('https://api.test/v1/generate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: 'chrome-extension://test', 'CF-Connecting-IP': ip,
               ...(install ? { 'X-LeetHint-Install': install } : {}) },
    body: JSON.stringify({ action: 'hints', problem })
  }), env, { waitUntil() {} });
}

test('25 quick requests from one install: 429 rate_limited from the 21st', async () => {
  const env = { GROQ_API_KEY: 't', PROVIDER_ORDER: 'groq', INSTALL_LIMITER: fakeLimiter(20), RATE_LIMITER: fakeLimiter(120) };
  const statuses = [];
  for (let i = 0; i < 25; i++) { const r = await call(env, A); statuses.push(r.status); if (i === 20) {
    assert.deepEqual(await r.json(), { error: 'rate_limited', retryAfter: 60, message: 'Too many requests — wait a minute and try again.' });
    assert.equal(r.headers.get('Retry-After'), '60');
  } else await r.text(); }
  assert.deepEqual(statuses.slice(0, 20), Array(20).fill(200));
  assert.deepEqual(statuses.slice(20), Array(5).fill(429));
});

test('two installs behind one IP do not block each other', async () => {
  const env = { GROQ_API_KEY: 't', PROVIDER_ORDER: 'groq', INSTALL_LIMITER: fakeLimiter(20), RATE_LIMITER: fakeLimiter(120) };
  for (let i = 0; i < 20; i++) await (await call(env, A)).text();
  assert.equal((await call(env, A)).status, 429);
  assert.equal((await call(env, B)).status, 200);
});

test('no or malformed install ID → IP limit alone (old extensions keep working)', async () => {
  const install = fakeLimiter(20);
  const env = { GROQ_API_KEY: 't', PROVIDER_ORDER: 'groq', INSTALL_LIMITER: install, RATE_LIMITER: fakeLimiter(2) };
  assert.equal((await call(env, '')).status, 200);
  assert.equal((await call(env, 'not-a-uuid')).status, 200);
  assert.equal((await call(env, '')).status, 429);
});

test('CORS allows the install header', async () => {
  const r = await worker.fetch(new Request('https://api.test/v1/generate', { method: 'OPTIONS', headers: { Origin: 'chrome-extension://test' } }), {}, {});
  assert.match(r.headers.get('Access-Control-Allow-Headers'), /X-LeetHint-Install/);
});

test('GET /config: contract defaults, vars override, cached 1 hour', async () => {
  const get = env => worker.fetch(new Request('https://api.test/config', { headers: { Origin: 'chrome-extension://test' } }), env, {});
  let r = await get({});
  assert.equal(r.headers.get('Cache-Control'), 'public, max-age=3600');
  assert.ok(r.headers.get('Access-Control-Allow-Origin'));
  assert.deepEqual(await r.json(), { interview: true, fix: true, trialInterviewsPerWeek: 1, trialInterviewMinutes: 15, trialFixesPerDay: 3, message: '' });
  r = await get({ CONFIG_INTERVIEW: 'false', CONFIG_TRIAL_FIXES_PER_DAY: '5', CONFIG_MESSAGE: 'Maintenance tonight' });
  const c = await r.json();
  assert.equal(c.interview, false);
  assert.equal(c.trialFixesPerDay, 5);
  assert.equal(c.message, 'Maintenance tonight');
});
