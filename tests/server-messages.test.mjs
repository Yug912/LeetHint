// Tests for /config (api/remote.js) and the server's busy / limit / trial
// replies (api/server-errors.js) — run with: node --test tests/*.test.mjs
// fetch, storage and timers are simulated.
import { test } from 'node:test';
import assert from 'node:assert/strict';

const store = new Map();
const storage = {
  get: async key => (store.has(key) ? { [key]: store.get(key) } : {}),
  set: async obj => { for (const [k, v] of Object.entries(obj)) store.set(k, v); }
};
globalThis.chrome = { storage: { local: storage } };

const { getRemoteConfig, normalizeConfig, REMOTE_DEFAULTS, CONFIG_MAX_AGE_MS } = await import('../api/remote.js');
const { classifyServerError, busyDelay, withBusyRetry, trialUsedMessage, RATE_LIMITED_MSG, BLOCKED_MSG } =
  await import('../api/server-errors.js');

// ── /config ──
test('/config: missing endpoint, server off or junk → everything on, no message', async () => {
  store.clear();
  const base = { storage, baseUrl: 'https://w.test' };
  for (const fetchImpl of [
    async () => new Response('Not found', { status: 404 }),
    async () => { throw new TypeError('offline'); },
    async () => new Response('<html>', { status: 200 })
  ]) {
    assert.deepEqual(await getRemoteConfig({ ...base, fetchImpl }), { ...REMOTE_DEFAULTS });
  }
  assert.equal(store.has('remoteConfig'), false);   // a failure is not remembered
});

test('/config: fetched at most once an hour', async () => {
  store.clear();
  let calls = 0;
  const fetchImpl = async () => { calls++; return Response.json({ interview: false, message: 'Maintenance tonight' }); };
  const t0 = 1_000_000;
  const a = await getRemoteConfig({ storage, fetchImpl, now: t0, baseUrl: 'https://w.test' });
  assert.equal(a.interview, false);
  assert.equal(a.fix, true);
  assert.equal(a.message, 'Maintenance tonight');
  await getRemoteConfig({ storage, fetchImpl, now: t0 + CONFIG_MAX_AGE_MS - 1, baseUrl: 'https://w.test' });
  assert.equal(calls, 1);
  await getRemoteConfig({ storage, fetchImpl, now: t0 + CONFIG_MAX_AGE_MS, baseUrl: 'https://w.test' });
  assert.equal(calls, 2);
  assert.deepEqual(Object.keys(store.get('remoteConfig')).sort(), ['at', 'value']);
});

test('/config: only well-typed fields count', () => {
  const c = normalizeConfig({ interview: 'no', fix: false, trialInterviewMinutes: 15, trialFixesPerDay: -1, message: 42, extra: 1 });
  assert.equal(c.interview, true);           // not a boolean → default
  assert.equal(c.fix, false);
  assert.equal(c.trialInterviewMinutes, 15);
  assert.equal(c.trialFixesPerDay, null);
  assert.equal(c.message, '');
  assert.equal('extra' in c, false);
});

// ── classifying refusals ──
const headers = h => new Headers(h);

test('busy 429 → wait, with the server\'s retryAfter and position', () => {
  const e = classifyServerError(429, { error: 'busy', retryAfter: 20, position: 3 }, headers({ 'Retry-After': '20' }));
  assert.equal(e.code, 'busy');
  assert.equal(e.retryAfter, 20);
  assert.equal(e.position, 3);
  assert.equal(e.message, "High demand — you're in line (~20 s)");
  // Header only
  assert.equal(classifyServerError(429, { error: 'busy' }, headers({ 'Retry-After': '7' })).retryAfter, 7);
});

test('rate_limited 429 and an older Worker\'s plain 429 → no retry message', () => {
  assert.equal(classifyServerError(429, { error: 'rate_limited', retryAfter: 60 }).message, RATE_LIMITED_MSG);
  const old = classifyServerError(429, { error: 'Too many requests — wait a minute and try again.' });
  assert.equal(old.code, 'rate_limited');
});

test('trial_used 403 → own-key message with the local reset time', () => {
  const e = classifyServerError(403, { error: 'trial_used', action: 'interview', resetsAt: '2026-11-24T00:00:00Z' });
  assert.equal(e.code, 'trial_used');
  assert.equal(e.action, 'interview');
  assert.match(e.message, /^Free trials are used up for today\. Add a free key in 2 minutes, or come back .+\.$/);
  // Day words relative to "now", in local time
  const now = new Date(2026, 10, 23, 15, 0);
  assert.match(trialUsedMessage(new Date(2026, 10, 24, 5, 30).toISOString(), now), /come back tomorrow at /);
  assert.match(trialUsedMessage(new Date(2026, 10, 23, 20, 0).toISOString(), now), /come back today at /);
  assert.match(trialUsedMessage('', now), /come back later\./);
});

test('blocked 403 → short generic error; anything else keeps the server text', () => {
  assert.equal(classifyServerError(403, { error: 'blocked' }).message, BLOCKED_MSG);
  assert.equal(classifyServerError(500, { error: 'All AI providers are busy' }).message, 'All AI providers are busy');
  assert.equal(classifyServerError(502, null).message, 'LeetHint server error (502)');
});

// ── waiting in line ──
test('retry delays: retryAfter, then 10, 20, 40, 60, 60 s', () => {
  assert.deepEqual([0, 1, 2, 3, 4, 5].map(a => busyDelay(a, 20)), [20, 10, 20, 40, 60, 60]);
  assert.equal(busyDelay(0, 0), 10);
});

function fakeClock() {
  let t = 0;
  const waits = [];
  return { now: () => t, sleep: async ms => { waits.push(ms / 1000); t += ms; }, waits };
}
const busyError = (retryAfter = 20) => Object.assign(new Error('busy'), { code: 'busy', retryAfter, position: 2 });

test('busy twice, then an answer → retried after 20 s and 10 s', async () => {
  const clock = fakeClock();
  let calls = 0;
  const told = [];
  const out = await withBusyRetry(async () => { if (++calls < 3) throw busyError(); return 'answer'; },
    { ...clock, onWait: (s, pos) => told.push([s, pos]) });
  assert.equal(out, 'answer');
  assert.deepEqual(clock.waits, [20, 10]);
  assert.deepEqual(told, [[20, 2], [10, 2]]);
});

test('still busy after 3 minutes → gives up (caller falls back to built-in AI)', async () => {
  const clock = fakeClock();
  await assert.rejects(withBusyRetry(async () => { throw busyError(); }, clock), e => e.code === 'busy');
  const total = clock.waits.reduce((a, b) => a + b, 0);
  assert.ok(total <= 180, `waited ${total} s`);
  assert.deepEqual(clock.waits, [20, 10, 20, 40, 60]);
});

test('rate_limited and trial_used are never retried', async () => {
  for (const code of ['rate_limited', 'trial_used', 'blocked']) {
    const clock = fakeClock();
    let calls = 0;
    await assert.rejects(withBusyRetry(async () => { calls++; throw Object.assign(new Error(code), { code }); }, clock));
    assert.equal(calls, 1);
    assert.deepEqual(clock.waits, []);
  }
});
