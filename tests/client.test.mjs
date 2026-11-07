// The extension's AI client: static files (B1), install ID (B2), waiting line
// and server messages (B5), own-key routing (B8) — run with: node --test tests/*.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installFakeChrome } from './helpers/fake-chrome.mjs';

const store = installFakeChrome();
const ai = await import('../api/ai.js');
const { CACHE_URL, BACKEND_URL } = await import('../api/config.js');

const FILE = {
  slug: 'two-sum', title: 'Two Sum', difficulty: 'Easy', promptVersion: 'p7', generatedAt: '2026-11-20',
  pattern: 'Hash Map', tc: 'O(n)', sc: 'O(n)', spaceBreakdown: '- map: n entries', approach: 'One pass with a map.',
  hints: ['h1', 'h2', 'h3', 'h4'],
  followUps: [{ q: 'Sorted?', a: 'Two pointers.' }, { q: 'Q2', a: 'A2' }, { q: 'Q3', a: 'A3' }],
  code: { cpp: 'class Solution {};', java: 'class Solution {}', python3: 'class Solution: pass', javascript: 'var twoSum = function() {};' },
  verified: { compiled: true }
};
const problem = { slug: 'two-sum', title: 'Two Sum', difficulty: 'Easy', description: 'x', cppSnippet: 'class Solution {};', codeSnippets: { python3: 'class Solution:' } };
const sse = text => `data: ${JSON.stringify({ choices: [{ delta: { content: text }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`;
const REPLY = '---APPROACH---\nA.\n---TC---\nO(n)\n---SC---\nO(1)\n---PATTERN---\nX\n---HINT1---\na\n---HINT2---\nb\n---HINT3---\nc\n---HINT4---\nd\n---CODE---\n```cpp\nclass Solution {};\n```\n---END---';

let calls;
function serve(handler) {
  calls = [];
  globalThis.fetch = async (url, init = {}) => { calls.push({ url: String(url), init }); return handler(String(url), init); };
}

test('a static file maps to the panel\'s hint object', () => {
  const h = ai.mapStaticFile(FILE);
  assert.equal(h.hint1, 'h1');
  assert.equal(h.hint4, 'h4');
  assert.equal(h.hint5, '```cpp\nclass Solution {};\n```\nApproach: One pass with a map. · TC O(n) · SC O(n)');
  assert.equal(h.optimal_tc, 'O(n)');
  assert.equal(h.sc_breakdown, '- map: n entries');
  assert.deepEqual(Object.keys(h.translations), ['java', 'python3', 'javascript']);
  assert.equal(h.followUps.length, 3);
  assert.equal(h.source, 'static');
  assert.equal(h.promptVersion, 'p7');
  assert.equal(ai.mapStaticFile({ hints: ['a'] }), null);
});

test('static file live → no /v1/generate request; onPartial once', async () => {
  serve(url => url === `${CACHE_URL}/cache/two-sum.json` ? Response.json(FILE) : assert.fail(`unexpected ${url}`));
  const partials = [];
  const h = await ai.generateHints(problem, { language: 'python3', onPartial: p => partials.push(p) });
  assert.equal(h.source, 'static');
  assert.equal(h.translations.python3, 'class Solution: pass');
  assert.equal(partials.length, 1);
  assert.deepEqual(calls.map(c => c.url), [`${CACHE_URL}/cache/two-sum.json`]);
});

test('no file (404) → the Worker, exactly as before, with the install header', async () => {
  serve(url => url.startsWith(CACHE_URL) ? new Response('', { status: 404 }) : new Response(sse(REPLY)));
  const h = await ai.generateHints(problem);
  assert.equal(h.hint1, 'a');
  assert.equal(calls[1].url, `${BACKEND_URL}/v1/generate`);
  const id = calls[1].init.headers['X-LeetHint-Install'];
  assert.match(id, /^[0-9a-f-]{36}$/);
  assert.equal(store.installId, id);                    // created once, kept
  await ai.generateHints(problem);
  assert.equal(calls[1].init.headers['X-LeetHint-Install'], id);
});

test('signature fix sends reason: "signature"', async () => {
  const p = { ...problem, slug: 'sig', cppSnippet: 'class Solution { public: int twoSum(int a) {} };' };
  const fixed = REPLY.replace('class Solution {};', 'class Solution { public: int twoSum(int a) { return a; } };');
  serve((url, init) => url.startsWith(CACHE_URL) ? new Response('', { status: 404 })
    : new Response(sse(JSON.parse(init.body).action === 'fix' ? fixed : REPLY)));
  const h = await ai.generateHints(p);
  const fix = calls.map(c => c.init.body && JSON.parse(c.init.body)).find(b => b?.action === 'fix');
  assert.equal(fix.reason, 'signature');
  assert.match(h.hint5, /twoSum/);
});

test('busy → waits retryAfter, then 10, 20, 40, 60 s; gives up after 3 minutes', async () => {
  let clock = 0;
  const slept = [];
  Object.assign(ai.WAIT, { now: () => clock, sleep: async ms => { slept.push(ms); clock += ms; } });
  serve(() => Response.json({ error: 'busy', retryAfter: 20, position: 3 }, { status: 429, headers: { 'Retry-After': '20' } }));
  await assert.rejects(ai.validateSolutionCode('', problem).catch(e => { throw e; }), e => e.code === 'busy');
  slept.length = 0; clock = 0;
  const err = await ai.translateSolution('class Solution {};', problem, 'java').catch(e => e);
  assert.equal(err.code, 'busy');
  assert.deepEqual(slept, [20000, 10000, 20000, 40000, 60000]);   // 150 s; one more 60 s would pass 3 min
  slept.length = 0; clock = 0;
  serve(() => Response.json({ error: 'busy', retryAfter: 5, position: 2 }, { status: 429 }));
  let n = 0;
  const realServe = globalThis.fetch;
  globalThis.fetch = async (u, i) => (++n < 3 ? realServe(u, i) : new Response(sse('---CODE---\n```java\nclass A {}\n```')));
  const code = await ai.translateSolution('class Solution {};', problem, 'java');
  assert.equal(code, 'class A {}');
  assert.deepEqual(slept, [5000, 10000]);
  Object.assign(ai.WAIT, { now: () => Date.now(), sleep: ms => new Promise(r => setTimeout(r, ms)) });
});

test('server messages: rate_limited, trial_used, blocked — no retry', async () => {
  const msg = (status, body) => ai.serverError(status, body);
  assert.equal(msg(429, { error: 'rate_limited', retryAfter: 60 }).message, 'Too many requests — try again in a minute.');
  const t = msg(403, { error: 'trial_used', action: 'fix', resetsAt: '2026-11-24T00:00:00Z' });
  assert.equal(t.code, 'trial_used');
  assert.match(t.message, /^Free trials are used up for today\. Add a free key in 2 minutes, or come back at /);
  assert.match(msg(403, { error: 'trial_used', action: 'interview', resetsAt: '2026-11-30T00:00:00Z' }).message, /free mock interview is used up/);
  assert.equal(msg(403, { error: 'blocked' }).code, 'blocked');
  assert.equal(msg(500, { error: 'The AI service could not answer — please retry.' }).message, 'The AI service could not answer — please retry.');
  serve(() => Response.json({ error: 'trial_used', action: 'fix', resetsAt: '2026-11-24T00:00:00Z' }, { status: 403 }));
  await assert.rejects(ai.validateSolutionCode('class Solution {};', problem), e => e.code === 'trial_used');
  assert.equal(calls.length, 1);
});

test('own key set → straight to the provider, never to the Worker; the key never reaches the Worker', async () => {
  store.ownKey = { provider: 'groq', key: 'gsk_test' };
  serve(url => url.startsWith(CACHE_URL) ? new Response('', { status: 404 })
    : url.startsWith('https://api.groq.com/') ? new Response(sse(REPLY)) : assert.fail(`unexpected ${url}`));
  const h = await ai.generateHints({ ...problem, slug: 'own-key' });
  assert.equal(h.hint1, 'a');
  assert.match(h.hint5, /^```cpp\nclass Solution \{\};\n```/);
  const groq = calls.find(c => c.url.startsWith('https://api.groq.com/'));
  assert.equal(groq.init.headers.Authorization, 'Bearer gsk_test');
  assert.equal(JSON.parse(groq.init.body).model, 'openai/gpt-oss-120b');
  assert.ok(!calls.some(c => c.url.startsWith(BACKEND_URL)));
  delete store.ownKey;
});

test('own key: Gemini uses streamGenerateContent with x-goog-api-key', async () => {
  store.ownKey = { provider: 'gemini', key: 'AIza_test' };
  const gem = `data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text: '---CODE---\n```python\nx = 1\n```' }] }, finishReason: 'STOP' }] })}\n\n`;
  serve(url => url.includes('generativelanguage.googleapis.com') ? new Response(gem) : assert.fail(url));
  assert.equal(await ai.translateSolution('class Solution {};', problem, 'python3'), 'x = 1');
  assert.match(calls[0].url, /models\/gemini-flash-latest:streamGenerateContent\?alt=sse$/);
  assert.equal(calls[0].init.headers['x-goog-api-key'], 'AIza_test');
  delete store.ownKey;
});
