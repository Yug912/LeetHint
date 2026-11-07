// Free trials (A12), reports (A5) and the blocklist (A14) — run with: node --test tests/*.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fakeD1 } from './helpers/fake-d1.mjs';
import { isoWeek, nextMondayIso, nextUtcMidnightIso } from '../backend/src/store.js';

let aiCalls = 0;
globalThis.fetch = async (url) => {
  if (String(url).endsWith('/models')) return Response.json({ data: [{ id: 'openai/gpt-oss-120b' }] });
  aiCalls++;
  return new Response('data: {"choices":[{"delta":{"content":"x"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');
};
const { default: worker } = await import('../backend/src/index.js?trials');

const ME = '11111111-1111-4111-8111-111111111111';
const IV = n => `aaaaaaaa-aaaa-4aaa-8aaa-${String(n).padStart(12, '0')}`;
const problem = { slug: 'two-sum', title: 'Two Sum', difficulty: 'Easy', description: 'x', cppSnippet: 'class Solution {};' };

function post(env, path, body, install = ME) {
  return worker.fetch(new Request('https://api.test' + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: 'chrome-extension://test', ...(install ? { 'X-LeetHint-Install': install } : {}) },
    body: JSON.stringify(body)
  }), env, { waitUntil() {} });
}
const fix = (env, extra = {}, install) => post(env, '/v1/generate', { action: 'fix', problem, code: 'class Solution {};', ...extra }, install);
const turn = (env, interviewId, event) => post(env, '/v1/generate', { action: 'interview_turn', problem, interview: { interviewId, event, history: [] } });

test('ISO weeks and reset times', () => {
  assert.equal(isoWeek(Date.UTC(2026, 10, 23)), '2026-W48');   // Mon 23 Nov 2026
  assert.equal(isoWeek(Date.UTC(2026, 0, 1)), '2026-W01');     // Thu 1 Jan 2026
  assert.equal(isoWeek(Date.UTC(2027, 0, 1)), '2026-W53');     // Fri 1 Jan 2027 belongs to 2026's last week
  assert.equal(nextMondayIso(Date.UTC(2026, 10, 18, 15)), '2026-11-23T00:00:00Z');
  assert.equal(nextMondayIso(Date.UTC(2026, 10, 23, 1)), '2026-11-30T00:00:00Z');
  assert.equal(nextUtcMidnightIso(Date.UTC(2026, 10, 18, 15)), '2026-11-19T00:00:00Z');
});

test('the 4th fix of a day is refused with trial_used', async () => {
  const env = { GROQ_API_KEY: 't', PROVIDER_ORDER: 'groq', DB: fakeD1() };
  for (let i = 0; i < 3; i++) assert.equal((await fix(env)).status, 200);
  const r = await fix(env);
  assert.equal(r.status, 403);
  const b = await r.json();
  assert.equal(b.error, 'trial_used');
  assert.equal(b.action, 'fix');
  assert.match(b.resetsAt, /^\d{4}-\d\d-\d\dT00:00:00Z$/);
});

test('signature fixes and requests without an install ID are not trials', async () => {
  const env = { GROQ_API_KEY: 't', PROVIDER_ORDER: 'groq', DB: fakeD1() };
  for (let i = 0; i < 5; i++) assert.equal((await fix(env, { reason: 'signature' })).status, 200);
  for (let i = 0; i < 5; i++) assert.equal((await fix(env, {}, '')).status, 200);
  assert.equal((await fix(env)).status, 200);   // the user still has all 3 trials
});

test('2nd new interview of a week is refused; later turns of the admitted one are not', async () => {
  const env = { GROQ_API_KEY: 't', PROVIDER_ORDER: 'groq', DB: fakeD1() };
  assert.equal((await turn(env, IV(1), 'start')).status, 200);
  assert.equal((await turn(env, IV(1), 'start')).status, 200);    // a retried start counts once
  for (let i = 0; i < 5; i++) assert.equal((await turn(env, IV(1), 'answer')).status, 200);
  const r = await turn(env, IV(2), 'start');
  assert.equal(r.status, 403);
  assert.equal((await r.json()).action, 'interview');
});

test('a fix that fails before generating gives the trial back', async () => {
  const env = { GROQ_API_KEY: 't', PROVIDER_ORDER: 'groq', DB: fakeD1() };
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => Response.json({ error: { message: 'Rate limit reached. Please try again in 30s.' } }, { status: 429 });
  for (let i = 0; i < 4; i++) assert.equal((await fix(env)).status, 429);   // busy, not trial_used
  globalThis.fetch = realFetch;
  assert.equal(env.DB.db.prepare('SELECT count FROM usage').get().count, 0);
});

test('reports: stored, duplicate within a day ignored, 204', async () => {
  const env = { DB: fakeD1() };
  const report = { slug: 'two-sum', promptVersion: 'p7', reason: 'wrong_solution', note: 'fails [3,3]' };
  for (let i = 0; i < 2; i++) assert.equal((await post(env, '/v1/report', report)).status, 204);
  const rows = env.DB.db.prepare('SELECT * FROM reports').all();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].reason, 'wrong_solution');
  assert.equal(rows[0].note, 'fails [3,3]');
  assert.equal((await post(env, '/v1/report', { ...report, reason: 'nonsense' })).status, 400);
});

test('reports without D1 go to KV', async () => {
  const kv = new Map();
  const env = { HINTS_CACHE: { getWithMetadata: async k => ({ value: kv.get(k) ?? null }), put: async (k, v) => kv.set(k, v) } };
  const report = { slug: 'two-sum', promptVersion: 'p7', reason: 'wrong_hint' };
  await post(env, '/v1/report', report); await post(env, '/v1/report', report);
  assert.equal(kv.size, 1);
});

test('a blocked install gets 403 blocked on every /v1 request', async () => {
  const env = { GROQ_API_KEY: 't', PROVIDER_ORDER: 'groq', DB: fakeD1() };
  env.DB.db.prepare("INSERT INTO blocked (install_id) VALUES (?)").run(ME);
  const r = await post(env, '/v1/generate', { action: 'hints', problem });
  assert.equal(r.status, 403);
  assert.deepEqual(await r.json(), { error: 'blocked' });
  assert.equal((await post(env, '/v1/report', { slug: 'two-sum', reason: 'other' })).status, 403);
});
