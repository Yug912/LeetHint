// Tests for the optional own API key (api/direct.js) and the router in
// api/ai.js — run with: node --test tests/*.test.mjs
// Providers and the Worker are simulated; no real key is used.
import { test } from 'node:test';
import assert from 'node:assert/strict';

const store = new Map([['installId', 'test-install']]);
globalThis.chrome = { storage: { local: {
  get: async k => (store.has(k) ? { [k]: store.get(k) } : {}),
  set: async o => { for (const [k, v] of Object.entries(o)) store.set(k, v); },
  remove: async k => { store.delete(k); }
} } };

const { buildDirectRequest, testOwnKey, saveOwnKey, removeOwnKey, getOwnKey } = await import('../api/direct.js');
const { generateHints, validateSolutionCode } = await import('../api/ai.js');

const KEY = 'test-key-123';
const sse = chunks => new Response(chunks.map(c => `data: ${JSON.stringify(c)}\n\n`).join('') + 'data: [DONE]\n\n');
const openaiText = text => sse([{ choices: [{ delta: { content: text } }] }, { choices: [{ delta: {}, finish_reason: 'stop' }] }]);
const geminiText = text => sse([{ candidates: [{ content: { parts: [{ text }] }, finishReason: 'STOP' }] }]);

const REPLY = `---APPROACH---
Hash map of seen values.
---TC---
O(n)
---SC---
O(n)
---SC_BREAKDOWN---
map: n entries
---PATTERN---
Hash Map
---HINT1---
Which value completes the pair?
---HINT2---
Look it up in O(1).
---HINT3---
Map value to index.
---HINT4---
Check before inserting.
---FOLLOWUPS---
Q: Sorted input?
A: Two pointers.
Q: All pairs?
A: Keep counts.
Q: Huge input?
A: External sort.
---CODE---
\`\`\`cpp
class Solution {
public:
    vector<int> twoSum(vector<int>& nums, int target) { return {}; }
};
\`\`\``;

const problem = {
  slug: 'two-sum', title: 'Two Sum', difficulty: 'Easy', description: 'Find two numbers that add up to target.',
  cppSnippet: 'class Solution {\npublic:\n    vector<int> twoSum(vector<int>& nums, int target) {\n    }\n};',
  topicTags: ['Array', 'Hash Table']
};

test('Groq / OpenRouter: OpenAI-style streaming chat with a Bearer key', () => {
  for (const p of ['groq', 'openrouter']) {
    const { url, init } = buildDirectRequest(p, KEY, 'prompt', { effort: 'medium', maxTokens: 4500 });
    assert.match(url, p === 'groq' ? /^https:\/\/api\.groq\.com\// : /^https:\/\/openrouter\.ai\//);
    assert.equal(init.headers.Authorization, `Bearer ${KEY}`);
    const body = JSON.parse(init.body);
    assert.equal(body.stream, true);
    assert.equal(body.messages[0].content, 'prompt');
    assert.ok(body.model);
  }
  // Groq's free 8k tokens/minute: a Hard request is capped below it
  const hard = JSON.parse(buildDirectRequest('groq', KEY, 'x'.repeat(10000), { effort: 'high', maxTokens: 8000 }).init.body);
  assert.ok(hard.max_tokens < 8000 - 2800);
  assert.equal(hard.reasoning_effort, 'medium');
});

test('Gemini: streamGenerateContent?alt=sse with x-goog-api-key', () => {
  const { url, init } = buildDirectRequest('gemini', KEY, 'prompt', { maxTokens: 4500 });
  assert.match(url, /^https:\/\/generativelanguage\.googleapis\.com\/v1beta\/models\/[\w.-]+:streamGenerateContent\?alt=sse$/);
  assert.equal(init.headers['x-goog-api-key'], KEY);
  assert.equal(url.includes(KEY), false);   // never in the URL (it would end up in logs)
});

test('Test key: a good key works; a bad one shows the provider\'s error', async () => {
  assert.deepEqual(await testOwnKey('groq', KEY, { fetchImpl: async () => openaiText('OK') }), { ok: true });
  assert.deepEqual(await testOwnKey('gemini', KEY, { fetchImpl: async () => geminiText('OK') }), { ok: true });
  const bad = await testOwnKey('groq', 'nope', {
    fetchImpl: async () => Response.json({ error: { message: 'Invalid API Key' } }, { status: 401 })
  });
  assert.equal(bad.ok, false);
  assert.equal(bad.message, 'Groq: Invalid API Key');
  const geminiBad = await testOwnKey('gemini', 'nope', {
    fetchImpl: async () => Response.json({ error: { message: 'API key not valid. Please pass a valid API key.' } }, { status: 400 })
  });
  assert.match(geminiBad.message, /^Gemini: API key not valid/);
});

test('own key set → hints come from the provider, nothing goes to the Worker', async () => {
  await saveOwnKey('groq', KEY);
  const seen = [];
  globalThis.fetch = async (url, init) => {
    seen.push({ url: String(url), init });
    if (String(url).includes('leethint-cache')) return new Response('Not found', { status: 404 });
    if (String(url).includes('api.groq.com')) return openaiText(REPLY);
    throw new Error('unexpected request to ' + url);
  };
  const hints = await generateHints(problem, {});
  assert.equal(hints.hint1, 'Which value completes the pair?');
  assert.equal(hints.optimal_tc, 'O(n)');
  assert.match(hints.hint5, /^```cpp\nclass Solution \{/);
  assert.equal(hints.followUps.length, 3);
  assert.equal(seen.some(r => r.url.includes('workers.dev')), false, 'no /v1/generate call');
  // The key goes only to Groq
  for (const r of seen.filter(r => !r.url.includes('api.groq.com'))) {
    assert.equal(JSON.stringify(r.init || {}).includes(KEY), false);
  }
});

test('own key fails on Fix → error shown, the code is NOT sent to the Worker', async () => {
  await saveOwnKey('groq', KEY);
  let workerCalls = 0;
  globalThis.fetch = async url => {
    if (String(url).includes('workers.dev')) { workerCalls++; return openaiText(REPLY); }
    return Response.json({ error: { message: 'Rate limit reached' } }, { status: 429 });
  };
  await assert.rejects(validateSolutionCode('class Solution {};', problem), /Groq: Rate limit reached/);
  assert.equal(workerCalls, 0);
});

test('no own key → the Worker, with the install header and without any key', async () => {
  await removeOwnKey();
  assert.equal(await getOwnKey(), null);
  const seen = [];
  globalThis.fetch = async (url, init) => {
    seen.push({ url: String(url), init });
    if (String(url).includes('leethint-cache')) return new Response('Not found', { status: 404 });
    return openaiText(REPLY);
  };
  const hints = await generateHints(problem, {});
  assert.equal(hints.pattern, 'Hash Map');
  const worker = seen.find(r => r.url.endsWith('/v1/generate'));
  assert.ok(worker);
  assert.equal(worker.init.headers['X-LeetHint-Install'], 'test-install');
  assert.equal(JSON.stringify(worker.init).includes(KEY), false);
});
