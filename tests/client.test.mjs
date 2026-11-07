// Tests for the extension's server client: static files, install ID, server
// errors and the waiting line, /config, the own-key mode and routing.
// Run with: node --test tests/*.test.mjs — fetch and chrome.storage are faked.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

const store = {};
globalThis.chrome = { storage: { local: {
  get: async k => (typeof k === 'string' ? { [k]: store[k] } : Object.fromEntries((k || []).map(x => [x, store[x]]))),
  set: async o => { Object.assign(store, o); },
  remove: async k => { for (const x of [].concat(k)) delete store[x]; }
} } };

let calls = [];
let handler = () => new Response('not found', { status: 404 });
globalThis.fetch = async (url, init = {}) => { calls.push({ url: String(url), init }); return handler(String(url), init); };

const { mapStaticFile, fetchStaticHints } = await import('../api/static.js');
const { serverError, withWaitingLine, waitMs, messageFor } = await import('../api/errors.js');
const { getRemoteConfig, normalizeConfig } = await import('../api/remote.js');
const { getInstallId, _forgetInstallId } = await import('../api/install.js');
const { buildDirectRequest, testOwnKey, OWN_KEY_PROVIDERS } = await import('../api/direct.js');
const ai = await import('../api/ai.js');

const FILE = {
  slug: 'two-sum', title: 'Two Sum', difficulty: 'Easy', promptVersion: 'p7', pattern: 'Hash Table Lookup',
  tc: 'O(n)', sc: 'O(n)', spaceBreakdown: '- map: O(n)', approach: 'One pass with a hash map.',
  hints: ['h1', 'h2', 'h3', 'h4'], followUps: [{ q: 'Sorted?', a: 'Two pointers.' }, { q: '', a: 'dropped' }],
  code: { cpp: 'class Solution { public: vector<int> twoSum(vector<int>& n, int t) { return {}; } };', python3: 'class Solution:\n    pass', java: 'class Solution {}' },
  verified: { compiled: true }
};
const problem = { slug: 'two-sum', title: 'Two Sum', difficulty: 'Easy', description: 'd', cppSnippet: 'class Solution {\npublic:\n    vector<int> twoSum(vector<int>& nums, int target) {\n    }\n};' };
const sse = text => new Response(`data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\ndata: [DONE]\n\n`);
const REPLY = '---APPROACH---\nOne pass.\n---TC---\nO(n)\n---SC---\nO(n)\n---SC_BREAKDOWN---\n- map\n---PATTERN---\nHash map\n---HINT1---\na\n---HINT2---\nb\n---HINT3---\nc\n---HINT4---\nd\n---FOLLOWUPS---\nQ: What if sorted?\nA: Two pointers.\nQ: Streaming?\nA: Keep the map.\nQ: Many queries?\nA: Precompute.\n---CODE---\n```cpp\nclass Solution {\npublic:\n    vector<int> twoSum(vector<int>& nums, int target) { return {}; }\n};\n```';

beforeEach(() => {
  calls = [];
  handler = () => new Response('not found', { status: 404 });
  for (const k of Object.keys(store)) delete store[k];
  _forgetInstallId();
});

test('static file → the hints object the panel uses', () => {
  const h = mapStaticFile(FILE);
  assert.equal(h.hint1, 'h1');
  assert.equal(h.hint4, 'h4');
  assert.match(h.hint5, /^```cpp\nclass Solution/);
  assert.match(h.hint5, /Approach: One pass with a hash map\. · TC O\(n\) · SC O\(n\)$/);
  assert.equal(h.optimal_tc, 'O(n)');
  assert.equal(h.sc_breakdown, '- map: O(n)');
  assert.deepEqual(Object.keys(h.translations).sort(), ['java', 'python3']);
  assert.deepEqual(h.followUps, [{ q: 'Sorted?', a: 'Two pointers.' }]);
  assert.equal(h.source, 'static');
  assert.equal(mapStaticFile({ ...FILE, hints: ['only one'] }), null);
  assert.equal(mapStaticFile({ ...FILE, code: {} }), null);
});

test('static fetch: any failure means null (the server path runs)', async () => {
  assert.equal(await fetchStaticHints('two-sum'), null);   // 404
  handler = () => { throw new Error('offline'); };
  assert.equal(await fetchStaticHints('two-sum'), null);
  handler = () => new Response('{bad json');
  assert.equal(await fetchStaticHints('two-sum'), null);
  assert.equal(await fetchStaticHints('../etc'), null);
  handler = () => Response.json(FILE);
  assert.equal((await fetchStaticHints('Two-Sum')).hint1, 'h1');
  assert.match(calls.at(-1).url, /\/cache\/two-sum\.json$/);
});

test('install ID: created once, kept, sent on every server request', async () => {
  const a = await getInstallId();
  assert.match(a, /^[0-9a-f-]{36}$/);
  _forgetInstallId();
  assert.equal(await getInstallId(), a);   // read back from storage
  handler = url => url.endsWith('/health') ? Response.json({ ok: true }) : new Response('', { status: 404 });
  await ai.checkBackend();
  assert.equal(calls.at(-1).init.headers['X-LeetHint-Install'], a);
});

test('server errors: codes, messages and the older-server shape', () => {
  const busy = serverError(429, { error: 'busy', retryAfter: 20, position: 3, message: 'x' });
  assert.deepEqual([busy.code, busy.retryAfter, busy.position], ['busy', 20, 3]);
  assert.equal(serverError(429, { error: 'rate_limited', retryAfter: 60 }).message, 'Too many requests — try again in a minute.');
  const trial = serverError(403, { error: 'trial_used', action: 'fix', resetsAt: '2026-11-08T00:00:00Z' });
  assert.equal(trial.action, 'fix');
  assert.match(trial.message, /^Free fixes are used up for today\. Add a free key in 2 minutes, or come back .+\.$/);
  assert.match(messageFor('trial_used', { action: 'interview' }), /free mock interview for this week/);
  assert.equal(serverError(403, { error: 'blocked' }).code, 'blocked');
  const old = serverError(429, { error: 'The AI providers are busy right now — try again in a minute.' });
  assert.equal(old.code, '');
  assert.match(old.message, /busy right now/);
});

test('waiting line: retryAfter, then 10, 20, 40, 60 s — up to 3 minutes', async () => {
  assert.deepEqual([0, 1, 2, 3, 4, 5].map(n => waitMs(n, 20) / 1000), [20, 10, 20, 40, 60, 60]);
  assert.deepEqual([0, 1, 2, 3].map(n => waitMs(n) / 1000), [10, 20, 40, 60]);
  const slept = [], shown = [];
  let tries = 0;
  const result = await withWaitingLine(async () => {
    if (++tries < 3) throw Object.assign(new Error('busy'), { code: 'busy', retryAfter: 5, position: 4 });
    return 'ok';
  }, { sleep: async ms => slept.push(ms), onWait: w => shown.push(w) });
  assert.equal(result, 'ok');
  assert.deepEqual(slept, [5000, 10000]);
  assert.deepEqual(shown[0], { seconds: 5, position: 4 });
  // gives up once the next wait would pass 3 minutes
  slept.length = 0;
  await assert.rejects(withWaitingLine(async () => { throw Object.assign(new Error('busy'), { code: 'busy' }); },
    { sleep: async ms => slept.push(ms) }), /busy/);
  assert.equal(slept.reduce((a, b) => a + b, 0), 130000);   // 10+20+40+60 → next 60 would exceed 180
  // other errors are not retried
  let n = 0;
  await assert.rejects(withWaitingLine(async () => { n++; throw Object.assign(new Error('x'), { code: 'rate_limited' }); },
    { sleep: async () => {} }), /x/);
  assert.equal(n, 1);
});

test('/config: defaults when missing, cached for an hour', async () => {
  assert.deepEqual(normalizeConfig({ interview: false, trialInterviewMinutes: 15, message: ' hi ' }),
    { interview: false, fix: true, trialInterviewsPerWeek: 0, trialInterviewMinutes: 15, trialFixesPerDay: 0, message: 'hi' });
  const now = Date.UTC(2026, 10, 7);
  let cfg = await getRemoteConfig({ now });                 // 404 → everything on
  assert.equal(cfg.interview, true);
  handler = () => Response.json({ interview: false, fix: true, trialInterviewMinutes: 15, message: 'Maintenance tonight' });
  cfg = await getRemoteConfig({ now });
  assert.equal(cfg.interview, false);
  assert.equal(calls.at(-1).init.headers['X-LeetHint-Install'].length, 36);
  handler = () => Response.json({ interview: true });
  assert.equal((await getRemoteConfig({ now: now + 30 * 60_000 })).interview, false);   // still cached
  assert.equal((await getRemoteConfig({ now: now + 61 * 60_000 })).interview, true);    // refreshed
  handler = () => { throw new Error('offline'); };
  assert.equal((await getRemoteConfig({ now: now + 3 * 3600_000 })).interview, true);   // last good answer
});

test('hints: a static file means no /v1/generate call at all', async () => {
  handler = url => url.includes('/cache/two-sum.json') ? Response.json(FILE) : new Response('', { status: 500 });
  let partial = null;
  const h = await ai.generateHints(problem, { onPartial: p => { partial = p; } });
  assert.equal(h.source, 'static');
  assert.equal(partial.hint1, 'h1');
  assert.ok(!calls.some(c => c.url.includes('/v1/generate')));
});

test('hints from the server: install header, follow-ups parsed, busy waits in line', async () => {
  let generate = 0;
  handler = (url, init) => {
    if (url.includes('/cache/')) return new Response('', { status: 404 });
    if (url.endsWith('/v1/generate')) {
      if (++generate === 1) return Response.json({ error: 'busy', retryAfter: 1, position: 2 }, { status: 429, headers: { 'Retry-After': '1' } });
      return sse(REPLY);
    }
    return new Response('', { status: 404 });
  };
  const waits = [];
  const h = await ai.generateHints(problem, { onWait: w => waits.push(w) });
  assert.deepEqual(waits, [{ seconds: 1, position: 2 }]);
  assert.equal(h.hint1, 'a');
  assert.equal(h.source, 'server');
  assert.deepEqual(h.followUps.map(f => f.q), ['What if sorted?', 'Streaming?', 'Many queries?']);
  const gen = calls.find(c => c.url.endsWith('/v1/generate'));
  assert.match(gen.init.headers['X-LeetHint-Install'], /^[0-9a-f-]{36}$/);
});

test('the automatic signature fix sends reason "signature"; a user fix never does', async () => {
  const wrongName = REPLY.replace('twoSum(vector', 'solve(vector');
  const bodies = [];
  handler = (url, init) => {
    if (url.includes('/cache/')) return new Response('', { status: 404 });
    if (url.endsWith('/v1/generate')) { const b = JSON.parse(init.body); bodies.push(b); return sse(b.action === 'fix' ? REPLY : wrongName); }
    return new Response('', { status: 404 });
  };
  await ai.generateHints(problem);
  const fix = bodies.find(b => b.action === 'fix');
  assert.equal(fix.reason, 'signature');
  bodies.length = 0;
  await ai.validateSolutionCode('class Solution {};', problem, 'Wrong Answer');
  assert.equal(bodies[0].action, 'fix');
  assert.equal(bodies[0].reason, undefined);
});

test('own key: requests go straight to the provider; the key never reaches the Worker', async () => {
  store.ownKey = { provider: 'groq', key: 'gsk_secret123' };
  handler = (url) => {
    if (url.includes('/cache/')) return new Response('', { status: 404 });
    if (url.startsWith('https://api.groq.com/')) return sse(REPLY);
    return new Response('', { status: 500 });
  };
  const h = await ai.generateHints(problem);
  assert.equal(h.source, 'own');
  assert.equal(h.hint2, 'b');
  const groq = calls.find(c => c.url.startsWith('https://api.groq.com/'));
  assert.equal(groq.init.headers.Authorization, 'Bearer gsk_secret123');
  const body = JSON.parse(groq.init.body);
  assert.equal(body.model, OWN_KEY_PROVIDERS.groq.model);
  assert.ok(body.max_tokens + body.messages[0].content.length / 3.5 <= 8000);   // fits Groq's per-minute cap
  for (const c of calls.filter(c => !c.url.startsWith('https://api.groq.com/'))) {
    assert.ok(!JSON.stringify(c).includes('gsk_secret123'), `key leaked to ${c.url}`);
  }
  assert.ok(!calls.some(c => c.url.includes('/v1/generate')));
});

test('own key: Gemini request shape and "Test key" errors', async () => {
  const g = buildDirectRequest('gemini', 'AIza-test', 'hello', { effort: 'medium', maxTokens: 4500 });
  assert.match(g.url, /generativelanguage\.googleapis\.com\/v1beta\/models\/.+:streamGenerateContent\?alt=sse$/);
  assert.equal(g.init.headers['x-goog-api-key'], 'AIza-test');
  const o = buildDirectRequest('openrouter', 'sk-or', 'hello', { effort: 'medium', maxTokens: 4500 });
  assert.deepEqual(JSON.parse(o.init.body).reasoning, { effort: 'medium' });
  handler = () => Response.json({ error: { message: 'Invalid API Key' } }, { status: 401 });
  const bad = await testOwnKey('groq', 'nope');
  assert.equal(bad.ok, false);
  assert.match(bad.message, /Groq: Invalid API Key — check that the key is correct/);
  handler = () => sse('OK');
  assert.deepEqual(await testOwnKey('groq', 'good'), { ok: true });
  assert.equal((await testOwnKey('groq', '')).ok, false);
});

test('report: body follows the contract; an older server is ignored quietly', async () => {
  handler = () => new Response(null, { status: 204 });
  assert.equal(await ai.reportWrongHint({ slug: 'two-sum', promptVersion: 'p7', reason: 'wrong_hint', note: 'x'.repeat(600) }), true);
  const body = JSON.parse(calls.at(-1).init.body);
  assert.deepEqual(Object.keys(body).sort(), ['note', 'promptVersion', 'reason', 'slug']);
  assert.equal(body.note.length, 500);
  handler = () => new Response('', { status: 404 });
  assert.equal(await ai.reportWrongHint({ slug: 'two-sum', reason: 'other' }), false);
  assert.equal(await ai.reportWrongHint({ slug: 'two-sum', reason: 'bogus' }), false);
});
