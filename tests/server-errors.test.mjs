// Tests for the server's busy / rate_limited / trial_used / blocked replies
// (api/server-errors.js, contract items 5 and 6) — run with: npm test
// The clock and the timers are fake: no test waits for real time.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyServerResponse, messageFor, busyDelay, runWithBusyRetry, formatResetTime,
         RATE_LIMITED_MSG, BLOCKED_MSG } from '../api/server-errors.js';

// ── A fake clock with timers ──
function fakeTimers() {
  let t = 0, nextId = 1;
  const timers = new Map();
  const api = {
    now: () => t,
    setTimeout: (fn, ms) => { const id = nextId++; timers.set(id, { at: t + ms, fn }); return id; },
    clearTimeout: id => { timers.delete(id); },
    pending: () => timers.size,
    // Run timers in time order until none are left (or a limit), letting promises settle in between
    async runAll(limit = 10000) {
      for (let i = 0; i < limit; i++) {
        await new Promise(r => setImmediate(r));
        if (!timers.size) return;
        const [id, next] = [...timers.entries()].sort((a, b) => a[1].at - b[1].at)[0];
        timers.delete(id);
        t = next.at;
        next.fn();
      }
    }
  };
  return api;
}
const res = (status, headers = {}) => ({ ok: status >= 200 && status < 300, status, headers: new Headers(headers) });
const busy = (retryAfter, position) => Object.assign(new Error('busy'), { kind: 'busy', retryAfter, position });

// ── Classification ──
test('classification: one response per case', () => {
  assert.deepEqual(classifyServerResponse(res(200), null), { kind: 'ok' });
  assert.deepEqual(classifyServerResponse(res(429, { 'Retry-After': '20' }), { error: 'busy', retryAfter: 20, position: 3 }),
    { kind: 'busy', retryAfter: 20, position: 3 });
  assert.deepEqual(classifyServerResponse(res(429), { error: 'rate_limited', retryAfter: 60 }), { kind: 'rate_limited' });
  assert.deepEqual(classifyServerResponse(res(403), { error: 'trial_used', action: 'fix', resetsAt: '2026-11-24T00:00:00Z' }),
    { kind: 'trial_used', resetsAt: '2026-11-24T00:00:00Z', action: 'fix' });
  assert.deepEqual(classifyServerResponse(res(403), { error: 'blocked' }), { kind: 'blocked' });
  // Malformed JSON (body could not be parsed) and unknown statuses → error, never a crash
  assert.equal(classifyServerResponse(res(500), null).kind, 'error');
  assert.equal(classifyServerResponse(res(418), 'not an object').kind, 'error');
  assert.equal(classifyServerResponse(res(403), { error: 'Origin not allowed' }).kind, 'error');
  assert.equal(classifyServerResponse(undefined, undefined).kind, 'error');
});

test('today\'s server: its plain 429 is rate_limited; its errors keep their own text', () => {
  assert.equal(classifyServerResponse(res(429), { error: 'Too many requests — wait a minute and try again.' }).kind, 'rate_limited');
  assert.equal(messageFor(classifyServerResponse(res(400), { error: 'Unknown action.' })), 'Unknown action.');
  assert.equal(messageFor(classifyServerResponse(res(502), null)), 'LeetHint server error (502)');
});

test('busy retryAfter: clamped to 1–60 s, header used when the body has none, default 10', () => {
  assert.equal(classifyServerResponse(res(429), { error: 'busy', retryAfter: 500 }).retryAfter, 60);
  assert.equal(classifyServerResponse(res(429), { error: 'busy', retryAfter: 0.2 }).retryAfter, 1);
  assert.equal(classifyServerResponse(res(429, { 'Retry-After': '7' }), { error: 'busy' }).retryAfter, 7);
  assert.equal(classifyServerResponse(res(429), { error: 'busy', retryAfter: 'soon' }).retryAfter, 10);
  assert.equal(classifyServerResponse(res(429), { error: 'busy', position: -2 }).position, undefined);
});

// ── Messages ──
test('messages for rate_limited, blocked and busy', () => {
  assert.equal(messageFor({ kind: 'rate_limited' }), RATE_LIMITED_MSG);
  assert.equal(RATE_LIMITED_MSG, 'Too many requests — try again in a minute.');
  assert.equal(messageFor({ kind: 'blocked' }), 'Hints are unavailable right now.');
  assert.equal(BLOCKED_MSG, 'Hints are unavailable right now.');
  assert.equal(messageFor({ kind: 'busy', retryAfter: 20 }), "High demand — you're in line (~20 s)");
  assert.equal(messageFor({ kind: 'ok' }), '');
});

test('trial_used: reset time today, tomorrow, later this week, and missing', () => {
  const opts = { now: new Date('2026-11-23T15:00:00Z'), locale: 'en-US', timeZone: 'UTC' };
  const base = 'Free trials are used up for today. Add a free key in 2 minutes';
  assert.equal(messageFor({ kind: 'trial_used', resetsAt: '2026-11-23T20:00:00Z' }, opts), `${base}, or come back at 8:00 PM.`);
  assert.equal(messageFor({ kind: 'trial_used', resetsAt: '2026-11-24T05:30:00Z' }, opts), `${base}, or come back tomorrow 5:30 AM.`);
  assert.equal(messageFor({ kind: 'trial_used', resetsAt: '2026-11-26T00:00:00Z' }, opts), `${base}, or come back Thursday 12:00 AM.`);
  assert.equal(messageFor({ kind: 'trial_used', resetsAt: '' }, opts), `${base}.`);
  assert.equal(messageFor({ kind: 'trial_used' }, opts), `${base}.`);
  // The user's own time zone decides "today": 20:00 UTC is already tomorrow in Tokyo
  const tokyo = { now: new Date('2026-11-23T14:00:00Z'), locale: 'en-US', timeZone: 'Asia/Tokyo' };   // 11 PM on the 23rd there
  assert.equal(formatResetTime('2026-11-23T20:00:00Z', tokyo), 'tomorrow 5:00 AM');
  assert.equal(formatResetTime('2026-11-23T20:00:00Z', opts), 'at 8:00 PM');
});

// ── Waiting line ──
test('busy schedule: retryAfter, 10, 20, 40, 60 — then the 3-minute budget runs out → onFallback once', async () => {
  const clock = fakeTimers();
  const calls = [];
  let fallbacks = 0;
  const p = runWithBusyRetry({
    request: async () => { calls.push(clock.now()); throw busy(5); },
    now: clock.now, setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout,
    onFallback: async () => { fallbacks++; return 'built-in AI hints'; }
  });
  await clock.runAll();
  assert.equal(await p, 'built-in AI hints');
  const waits = calls.slice(1).map((t, i) => (t - calls[i]) / 1000);
  assert.deepEqual(waits, [5, 10, 20, 40, 60]);           // 135 s; another 60 s would pass 180 s
  assert.equal(fallbacks, 1);
  assert.equal(clock.pending(), 0);
});

test('busy schedule keeps 60 s once it gets there (longer budget)', async () => {
  const clock = fakeTimers();
  const calls = [];
  const p = runWithBusyRetry({
    request: async () => { calls.push(clock.now()); throw busy(10); },
    now: clock.now, setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout, budgetMs: 10 * 60 * 1000
  });
  const rejected = assert.rejects(p, e => e.kind === 'busy');   // no onFallback → the busy error
  await clock.runAll();
  await rejected;
  const waits = calls.slice(1).map((t, i) => (t - calls[i]) / 1000);
  assert.deepEqual(waits.slice(0, 7), [10, 10, 20, 40, 60, 60, 60]);
  assert.deepEqual([0, 1, 2, 3, 4, 5].map(a => busyDelay(a, 10)), [10, 10, 20, 40, 60, 60]);
});

test('busy, busy, then success → the hints, no fallback, timers cleared', async () => {
  const clock = fakeTimers();
  let n = 0, fallbacks = 0;
  const p = runWithBusyRetry({
    request: async () => { if (++n < 3) throw busy(3); return 'hints'; },
    now: clock.now, setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout,
    onFallback: () => { fallbacks++; }
  });
  await clock.runAll();
  assert.equal(await p, 'hints');
  assert.equal(n, 3);
  assert.equal(fallbacks, 0);
  assert.equal(clock.pending(), 0);
});

test('a later busy reply with a longer retryAfter wins over the schedule', async () => {
  const clock = fakeTimers();
  const calls = [];
  const after = [5, 45];   // 1st reply: 5 s; 2nd reply: 45 s (schedule says 10)
  let n = 0;
  const p = runWithBusyRetry({
    request: async () => { calls.push(clock.now()); if (n < 2) throw busy(after[n++]); return 'ok'; },
    now: clock.now, setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout
  });
  await clock.runAll();
  assert.equal(await p, 'ok');
  assert.deepEqual(calls.slice(1).map((t, i) => (t - calls[i]) / 1000), [5, 45]);
});

test('the countdown: onWaiting every second, with the queue position', async () => {
  const clock = fakeTimers();
  const seen = [];
  let n = 0;
  const p = runWithBusyRetry({
    request: async () => { if (n++ === 0) throw busy(3, 7); return 'ok'; },
    now: clock.now, setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout,
    onWaiting: (left, pos) => seen.push([left, pos])
  });
  await clock.runAll();
  await p;
  assert.deepEqual(seen, [[3, 7], [2, 7], [1, 7]]);
});

test('cancel during the wait → no more requests, no more callbacks, AbortError', async () => {
  const clock = fakeTimers();
  const ctl = new AbortController();
  let requests = 0, waiting = 0, fallbacks = 0;
  const p = runWithBusyRetry({
    request: async () => { requests++; throw busy(10); },
    now: clock.now, setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout, signal: ctl.signal,
    onWaiting: () => { waiting++; if (waiting === 3) ctl.abort(); },
    onFallback: () => { fallbacks++; }
  });
  const rejected = assert.rejects(p, e => e.name === 'AbortError');
  await clock.runAll();
  await rejected;
  assert.equal(requests, 1);
  assert.equal(waiting, 3);
  assert.equal(fallbacks, 0);
  assert.equal(clock.pending(), 0);
  // Already cancelled → not even one request
  let any = 0;
  await assert.rejects(runWithBusyRetry({ request: async () => { any++; }, signal: ctl.signal }), e => e.name === 'AbortError');
  assert.equal(any, 0);
});

test('rate_limited, trial_used and blocked: zero retries', async () => {
  for (const kind of ['rate_limited', 'trial_used', 'blocked', 'error']) {
    const clock = fakeTimers();
    let n = 0;
    await assert.rejects(runWithBusyRetry({
      request: async () => { n++; throw Object.assign(new Error(messageFor({ kind })), { kind }); },
      now: clock.now, setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout
    }), e => e.kind === kind);
    assert.equal(n, 1, kind);
    assert.equal(clock.pending(), 0);
  }
});

// ── Through generateHints() (fetch simulated) ──
test('hints: busy then OK → the hints; rate_limited → its message, no fallback; cancel → AbortError', async () => {
  const store = new Map();
  globalThis.chrome = { storage: { local: {
    get: async k => Object.fromEntries([].concat(k).filter(x => store.has(x)).map(x => [x, store.get(x)])),
    set: async o => { for (const [k, v] of Object.entries(o)) store.set(k, v); }, remove: async () => {}
  } } };
  const { generateHints, onServerNotice } = await import('../api/ai.js');
  const reply = `data: ${JSON.stringify({ choices: [{ delta: { content: '---TC---\nO(n)\n---SC---\nO(1)\n---PATTERN---\nX\n---HINT1---\nh1\n---HINT2---\nh2\n---HINT3---\nh3\n---HINT4---\nh4\n---CODE---\n```cpp\nclass Solution {};\n```' } }] })}\n\ndata: [DONE]\n\n`;
  const problem = slug => ({ slug, title: 'P', description: 'statement', difficulty: 'Easy' });
  const notices = [];
  onServerNotice(n => notices.push(n.type));

  let gen = 0;
  globalThis.fetch = async url => {
    if (String(url).includes('/cache/')) return new Response('', { status: 404 });
    if (gen++ === 0) return Response.json({ error: 'busy', retryAfter: 1 }, { status: 429 });
    return new Response(reply);
  };
  const h = await generateHints(problem('p-busy'));
  assert.equal(h.hint1, 'h1');
  assert.ok(notices.includes('wait') && notices.at(-1) === 'clear');

  globalThis.fetch = async url => String(url).includes('/cache/') ? new Response('', { status: 404 })
    : Response.json({ error: 'rate_limited', retryAfter: 60 }, { status: 429 });
  await assert.rejects(generateHints(problem('p-limited')), e => e.kind === 'rate_limited' && e.message === RATE_LIMITED_MSG);

  globalThis.fetch = async url => String(url).includes('/cache/') ? new Response('', { status: 404 })
    : Response.json({ error: 'busy', retryAfter: 30 }, { status: 429 });
  const ctl = new AbortController();
  const pending = generateHints(problem('p-cancel'), { signal: ctl.signal });
  setTimeout(() => ctl.abort(), 50);
  await assert.rejects(pending, e => e.name === 'AbortError');
});
