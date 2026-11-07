// Cheaper interviews, server half (A13) — run with: node --test tests/*.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildPrompt, buildInterviewTurnPrompt } from '../shared/prompts.js';
import { fakeD1 } from './helpers/fake-d1.mjs';

const problem = { slug: 'two-sum', title: 'Two Sum', description: 'x' };
const history = [{ role: 'interviewer', text: 'Hi! Read the problem.' }, { role: 'candidate', text: 'Can values repeat?' }];

test('interview_summary asks for exactly 5 lines from the transcript', () => {
  const p = buildPrompt('interview_summary', problem, '', { interview: { history } });
  assert.match(p, /EXACTLY 5 short plain-text lines/);
  assert.match(p, /Candidate: Can values repeat\?/);
});

test('a turn renders the summary above the recent turns', () => {
  const p = buildInterviewTurnPrompt(problem, { event: 'answer', summary: '1. Asked about repeats.', history });
  assert.match(p, /SUMMARY OF THE EARLIER INTERVIEW:\n1\. Asked about repeats\.\n\nMOST RECENT TURNS:\nInterviewer: Hi!/);
});

test('durationMin sets the minutes and the pacing points', () => {
  const p = buildInterviewTurnPrompt(problem, { event: 'answer', elapsedSec: 300, durationMin: 15 });
  assert.match(p, /15-minute coding interview/);
  assert.match(p, /5 of 15 minutes used/);
  assert.match(p, /reach coding by ~5 min and finish coding by ~12 min/);
  assert.match(buildInterviewTurnPrompt(problem, { event: 'timeup', durationMin: 15 }), /Time is up \(15 minutes\)/);
  assert.match(buildInterviewTurnPrompt(problem, { event: 'answer' }), /30-minute coding interview/);   // default
});

test('server: summary uses the fast tier and is never cached; trial code events refused', async () => {
  const models = [];
  globalThis.fetch = async (url, init) => {
    if (String(url).endsWith('/models')) return Response.json({ data: [{ id: 'openai/gpt-oss-120b' }, { id: 'openai/gpt-oss-20b' }] });
    models.push(JSON.parse(init.body).model);
    return new Response('data: {"choices":[{"delta":{"content":"1. x"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');
  };
  const { default: worker } = await import('../backend/src/index.js?summary');
  const kv = new Map();
  const env = { GROQ_API_KEY: 't', PROVIDER_ORDER: 'groq', DB: fakeD1(),
                HINTS_CACHE: { getWithMetadata: async k => ({ value: kv.get(k) ?? null }), put: async (k, v) => kv.set(k, v) } };
  const call = (action, interview, install = '11111111-1111-4111-8111-111111111111') => worker.fetch(new Request('https://api.test/v1/generate', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'chrome-extension://test', 'X-LeetHint-Install': install },
    body: JSON.stringify({ action, problem, interview })
  }), env, { waitUntil() {} });
  for (let i = 0; i < 2; i++) assert.equal((await call('interview_summary', { history })).headers.get('X-LeetHint-Cache'), 'MISS');
  assert.deepEqual(models, ['openai/gpt-oss-20b', 'openai/gpt-oss-20b']);
  assert.equal(kv.size, 0);
  const r = await call('interview_turn', { event: 'code', history, code: 'int x;' });
  assert.equal(r.status, 400);
  assert.equal((await r.json()).error, 'code_checks_off');
});
