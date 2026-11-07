// Monitoring (A14): events and GET /stats — run with: node --test tests/*.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fakeD1 } from './helpers/fake-d1.mjs';

globalThis.fetch = async (url) => {
  if (String(url).endsWith('/models')) return Response.json({ data: [{ id: 'openai/gpt-oss-120b' }] });
  return new Response('data: {"choices":[{"delta":{"content":"x"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');
};
const { default: worker } = await import('../backend/src/index.js?stats');
const ME = '11111111-1111-4111-8111-111111111111';

function setup() {
  const events = [];
  return { events, env: { GROQ_API_KEY: 't', PROVIDER_ORDER: 'groq', DB: fakeD1(), STATS_TOKEN: 's3cret',
                          EVENTS: { writeDataPoint: e => events.push(e) } } };
}
const fix = env => worker.fetch(new Request('https://api.test/v1/generate', {
  method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'chrome-extension://test', 'X-LeetHint-Install': ME },
  body: JSON.stringify({ action: 'fix', problem: { slug: 'two-sum', title: 'Two Sum', difficulty: 'Easy', description: 'x' }, code: 'class Solution {};' })
}), env, { waitUntil() {} });
const stats = (env, token) => worker.fetch(new Request(`https://api.test/stats${token ? '?token=' + token : ''}`), env, {});

test('/stats with the right token shows today; without it, 404', async () => {
  const { env } = setup();
  for (let i = 0; i < 4; i++) await (await fix(env)).text();
  assert.equal((await stats(env)).status, 404);
  assert.equal((await stats(env, 'wrong!')).status, 404);
  assert.equal((await stats({ ...env, STATS_TOKEN: '' }, '')).status, 404);
  const r = await stats(env, 's3cret');
  assert.equal(r.status, 200);
  const s = await r.json();
  assert.ok(s.tokensReservedByProvider.Groq > 0);
  assert.deepEqual(s.trialsGranted, { fix: { count: 3, installs: 1 } });
  assert.ok(s.trialShareLeftPercent < 100);
});

test('one event per /v1 request: action, provider, outcome, trial', async () => {
  const { env, events } = setup();
  for (let i = 0; i < 4; i++) await (await fix(env)).text();
  assert.equal(events.length, 4);
  assert.deepEqual(events[0].blobs, ['fix', 'miss', 'Groq', 'ok', 'granted']);
  assert.deepEqual(events[3].blobs, ['fix', '', '', 'trial_used', 'refused']);
  assert.deepEqual(events[3].doubles, [403]);
});
