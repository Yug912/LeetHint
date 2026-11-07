// Tests for the Worker's endpoints — run with: node --test tests/*.test.mjs
// Providers, KV and the rate limiters are simulated.
import { test } from 'node:test';
import assert from 'node:assert/strict';

let aiCalls = 0, groqStatus = 200;
globalThis.fetch = async (url) => {
  if (String(url).endsWith('/models')) return Response.json({ data: [{ id: 'openai/gpt-oss-120b' }] });
  if (String(url).includes('leetcode.com/graphql')) return Response.json({ data: { topTwoContests: [] } });   // no contest running
  aiCalls++;
  if (groqStatus === 429) {
    return Response.json({ error: { message: 'Rate limit reached for tokens per minute (TPM). Please try again in 30s.' } }, { status: 429 });
  }
  return new Response('data: {"choices":[{"delta":{"content":"---CODE--- ok"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');
};
const { default: worker } = await import('../backend/src/index.js');

// A rate limiter that allows `limit` calls per key
const limiter = limit => {
  const used = new Map();
  return { limit: async ({ key }) => { used.set(key, (used.get(key) || 0) + 1); return { success: used.get(key) <= limit }; } };
};
const kvStore = () => {
  const kv = new Map();
  return { kv, binding: {
    getWithMetadata: async k => kv.has(k) ? { value: kv.get(k), metadata: { kind: 'openai' } } : { value: null },
    put: async (k, v) => { kv.set(k, v); }
  } };
};
const baseEnv = (extra = {}) => ({ GROQ_API_KEY: 'test', PROVIDER_ORDER: 'groq', ...extra });
const INSTALL_A = '3f2a9c1e-5b7d-4e8a-9c21-7d4e5f6a8b90';
const INSTALL_B = '7d4e5f6a-8b90-4e8a-9c21-3f2a9c1e5b7d';

async function call(env, path, { method = 'POST', body, install, ip = '1.2.3.4' } = {}) {
  const headers = { 'Content-Type': 'application/json', Origin: 'chrome-extension://test', 'CF-Connecting-IP': ip };
  if (install) headers['X-LeetHint-Install'] = install;
  const pending = [];
  const res = await worker.fetch(new Request(`https://api.test${path}`, { method, headers, body: body && JSON.stringify(body) }),
                                 env, { waitUntil: p => pending.push(p) });
  const text = await res.text();
  await Promise.all(pending);
  return { res, text, json: () => JSON.parse(text) };
}
const problem = slug => ({ slug, title: slug, difficulty: 'Easy', description: 'Do it.', cppSnippet: 'class Solution {};' });


test('GET /config: defaults, dashboard overrides, cached for an hour', async () => {
  let r = await call(baseEnv(), '/config', { method: 'GET' });
  assert.deepEqual(r.json(), { interview: true, fix: true, trialInterviewsPerWeek: 1, trialInterviewMinutes: 15, trialFixesPerDay: 3, message: '' });
  assert.equal(r.res.headers.get('Cache-Control'), 'public, max-age=3600');
  r = await call(baseEnv({ CONFIG_INTERVIEW: 'false', TRIAL_FIXES_PER_DAY: '5', CONFIG_MESSAGE: 'Maintenance tonight' }), '/config', { method: 'GET' });
  assert.equal(r.json().interview, false);
  assert.equal(r.json().trialFixesPerDay, 5);
  assert.equal(r.json().message, 'Maintenance tonight');
});

test('POST /v1/report: stored once per problem, install and day', async () => {
  const { kv, binding } = kvStore();
  const env = baseEnv({ HINTS_CACHE: binding });
  const body = { slug: 'two-sum', promptVersion: 'p7', reason: 'wrong_solution', note: 'fails [3,3]' };
  assert.equal((await call(env, '/v1/report', { body, install: INSTALL_A })).res.status, 204);
  await call(env, '/v1/report', { body, install: INSTALL_A });            // same day, same install → same key
  await call(env, '/v1/report', { body, install: INSTALL_B });
  const reports = [...kv.keys()].filter(k => k.startsWith('report:two-sum:'));
  assert.equal(reports.length, 2);
  assert.equal(JSON.parse(kv.get(reports[0])).reason, 'wrong_solution');
  assert.equal((await call(env, '/v1/report', { body: { slug: '../x' }, install: INSTALL_A })).res.status, 400);
});

test('per-install limit: the 21st request is refused, other installs on the same IP are not', async () => {
  const env = baseEnv({ INSTALL_LIMITER: limiter(20), RATE_LIMITER: limiter(120) });
  const body = { slug: 'two-sum', reason: 'other' };
  for (let i = 0; i < 20; i++) assert.equal((await call(env, '/v1/report', { body, install: INSTALL_A })).res.status, 204);
  const refused = await call(env, '/v1/report', { body, install: INSTALL_A });
  assert.equal(refused.res.status, 429);
  assert.equal(refused.json().error, 'rate_limited');
  assert.equal(refused.res.headers.get('Retry-After'), '60');
  assert.equal((await call(env, '/v1/report', { body, install: INSTALL_B })).res.status, 204);
});

test('no or malformed install ID → the IP limit alone', async () => {
  const env = baseEnv({ INSTALL_LIMITER: limiter(0), RATE_LIMITER: limiter(1) });
  const body = { slug: 'two-sum', reason: 'other' };
  assert.equal((await call(env, '/v1/report', { body, install: 'not-a-uuid' })).res.status, 204);
  assert.equal((await call(env, '/v1/report', { body })).res.status, 429);   // IP limit (1) used up
});

test('the automatic signature fix is made once and shared; a user\'s own fix never is', async () => {
  const { binding } = kvStore();
  const env = baseEnv({ HINTS_CACHE: binding });
  const before = aiCalls;
  const sig = { action: 'fix', reason: 'signature', problem: problem('sig-fix'), code: 'class Wrong {};' };
  assert.equal((await call(env, '/v1/generate', { body: sig })).res.headers.get('X-LeetHint-Cache'), 'MISS');
  assert.equal((await call(env, '/v1/generate', { body: sig })).res.headers.get('X-LeetHint-Cache'), 'HIT');
  assert.equal(aiCalls - before, 1);
  const own = { ...sig, failure: 'Input: [3,3]\nExpected: [0,1]' };
  await call(env, '/v1/generate', { body: own });
  await call(env, '/v1/generate', { body: own });
  assert.equal(aiCalls - before, 3);
});

test('every provider busy → 429 "busy" with Retry-After and a place in line', async () => {
  groqStatus = 429;
  try {
    const r = await call(baseEnv(), '/v1/generate', { body: { action: 'hints', problem: problem('busy-case') } });
    assert.equal(r.res.status, 429);
    assert.equal(r.json().error, 'busy');
    assert.equal(r.json().retryAfter, 30);
    assert.equal(r.res.headers.get('Retry-After'), '30');
    assert.ok(r.json().position >= 1);
  } finally {
    groqStatus = 200;
  }
});

test('free trials: the 4th fix of a day and a 2nd interview in a week are refused', async () => {
  const { fakeD1 } = await import('./helpers/fake-d1.mjs');
  const env = baseEnv({ DB: fakeD1() });
  const fix = { action: 'fix', problem: problem('trial-fix'), code: 'class Solution {};' };
  for (let i = 0; i < 3; i++) assert.equal((await call(env, '/v1/generate', { body: fix, install: INSTALL_A })).res.status, 200);
  const refused = await call(env, '/v1/generate', { body: fix, install: INSTALL_A });
  assert.equal(refused.res.status, 403);
  assert.equal(refused.json().error, 'trial_used');
  assert.equal(refused.json().action, 'fix');
  assert.match(refused.json().resetsAt, /^\d{4}-\d\d-\d\dT00:00:00Z$/);
  // the automatic signature fix and old extensions (no install ID) are not trials
  assert.equal((await call(env, '/v1/generate', { body: { ...fix, reason: 'signature' }, install: INSTALL_A })).res.status, 200);
  assert.equal((await call(env, '/v1/generate', { body: fix })).res.status, 200);

  const turn = (interviewId, event) => ({ action: 'interview_turn', problem: problem('trial-iv'),
    interview: { interviewId, event, stage: 'intro', history: [] } });
  const IV1 = '11111111-2222-4333-8444-555555555555', IV2 = '66666666-7777-4888-9999-000000000000';
  assert.equal((await call(env, '/v1/generate', { body: turn(IV1, 'start'), install: INSTALL_A })).res.status, 200);
  assert.equal((await call(env, '/v1/generate', { body: turn(IV1, 'answer'), install: INSTALL_A })).res.status, 200);
  const second = await call(env, '/v1/generate', { body: turn(IV2, 'start'), install: INSTALL_A });
  assert.equal(second.res.status, 403);
  assert.equal(second.json().action, 'interview');
  assert.equal((await call(env, '/v1/generate', { body: turn(IV2, 'answer'), install: INSTALL_A })).res.status, 403);
});

test('a blocked install is refused everywhere', async () => {
  const { fakeD1 } = await import('./helpers/fake-d1.mjs');
  const env = baseEnv({ DB: fakeD1() });
  env.DB.db.prepare('INSERT INTO blocked (install_id, reason, created) VALUES (?, ?, ?)').run(INSTALL_B, 'abuse', 0);
  const r = await call(env, '/v1/report', { body: { slug: 'two-sum' }, install: INSTALL_B });
  assert.equal(r.res.status, 403);
  assert.equal(r.json().error, 'blocked');
});

test('trial interview code checks get a silent reply with no AI call; summaries are never cached', async () => {
  const { binding } = kvStore();
  const env = baseEnv({ HINTS_CACHE: binding });
  const before = aiCalls;
  const code = { action: 'interview_turn', problem: problem('iv-code'), interview: { event: 'code', stage: 'coding', history: [] } };
  const r = await call(env, '/v1/generate', { body: code, install: INSTALL_A });
  assert.equal(r.res.headers.get('X-LeetHint-Cache'), 'SKIP');
  assert.match(r.text, /\\"reply\\":\\"\\",\\"stage\\":\\"coding\\"/);
  assert.equal(aiCalls, before);
  await call(env, '/v1/generate', { body: code });                         // old extension: still checks code
  assert.equal(aiCalls, before + 1);
  const sum = { action: 'interview_summary', problem: problem('iv-sum'), interview: { history: [] } };
  assert.equal((await call(env, '/v1/generate', { body: sum, install: INSTALL_A })).res.headers.get('X-LeetHint-Cache'), 'MISS');
  assert.equal((await call(env, '/v1/generate', { body: sum, install: INSTALL_A })).res.headers.get('X-LeetHint-Cache'), 'MISS');
});

test('GET /stats: 404 without the token; with it, today\'s counters', async () => {
  const { fakeD1 } = await import('./helpers/fake-d1.mjs');
  const env = baseEnv({ DB: fakeD1(), STATS_TOKEN: 'secret-token' });
  const hint = { action: 'hints', problem: problem('stats-case') };
  await call(env, '/v1/generate', { body: hint, install: INSTALL_A });   // miss → AI
  await call(env, '/v1/generate', { body: hint, install: INSTALL_A });   // hit
  const statsReq = token => worker.fetch(new Request(`https://api.test/stats${token ? '?token=' + token : ''}`), env, { waitUntil: () => {} });
  assert.equal((await statsReq('')).status, 404);
  assert.equal((await statsReq('wrong')).status, 404);
  const stats = await (await statsReq('secret-token')).json();
  assert.equal(stats.counters['action:hints'], 2);
  assert.equal(stats.counters['ai:Groq'], 1);
  assert.equal(stats.counters['cache:hit:memory'] ?? stats.counters['cache:hit:d1'], 1);
  assert.deepEqual(stats.providers, ['Groq']);
});
