// api/server-errors.js
// What the LeetHint server's refusals mean, how to word them, and how to wait
// in line. Contract items 5 and 6:
//   429 { error: 'busy', retryAfter, position } + Retry-After header → wait, then retry
//   429 { error: 'rate_limited', retryAfter }                         → no automatic retry
//   403 { error: 'trial_used', action, resetsAt }                     → offer an own key
//   403 { error: 'blocked' }                                          → short generic error
// Today's server sends none of these; its replies classify as 'ok' (or
// 'error' for its own failures), so nothing changes until it does.
// Pure logic — no chrome.*, clock and timers injectable — for unit tests.

export const BUSY_BUDGET_MS = 3 * 60 * 1000;   // from the FIRST busy reply
export const RATE_LIMITED_MSG = 'Too many requests — try again in a minute.';
export const BLOCKED_MSG = 'Hints are unavailable right now.';

const clampSec = (v, min, max) => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.min(max, Math.max(min, Math.ceil(n))) : 0;
};


// ─────────────────────────────────────────────
// 1. CLASSIFY — one place for every response
// ─────────────────────────────────────────────
// response: a fetch Response (or { ok, status, headers }); body: its parsed
// JSON or null. → { kind: 'ok' | 'busy' | 'rate_limited' | 'trial_used' | 'blocked' | 'error', ... }
export function classifyServerResponse(response, body = null) {
  const status = Number(response?.status) || 0;
  if (response?.ok || (status >= 200 && status < 300)) return { kind: 'ok' };
  const b = body && typeof body === 'object' && !Array.isArray(body) ? body : {};
  if (status === 429 && b.error === 'busy') {
    const retryAfter = clampSec(b.retryAfter, 1, 60) || clampSec(response.headers?.get?.('Retry-After'), 1, 60) || 10;
    const position = Number.isInteger(b.position) && b.position > 0 ? b.position : undefined;
    return { kind: 'busy', retryAfter, ...(position ? { position } : {}) };
  }
  // An older Worker answers a plain 429 ("Too many requests — wait a minute") — same meaning
  if (status === 429) return { kind: 'rate_limited' };
  if (status === 403 && b.error === 'trial_used') {
    const t = typeof b.resetsAt === 'string' ? new Date(b.resetsAt) : null;
    return { kind: 'trial_used', resetsAt: t && !Number.isNaN(t.getTime()) ? b.resetsAt : '',
             action: b.action === 'interview' || b.action === 'fix' ? b.action : undefined };
  }
  if (status === 403 && b.error === 'blocked') return { kind: 'blocked' };
  // Anything else: the server's own message when it gave one (as today)
  return { kind: 'error', status, ...(typeof b.error === 'string' && b.error ? { serverMessage: b.error } : {}) };
}


// ─────────────────────────────────────────────
// 2. MESSAGES
// ─────────────────────────────────────────────
export const busyMessage = sec => `High demand — you're in line (~${Math.max(1, Math.round(sec))} s)`;

// "5:30 AM" today, "tomorrow 5:30 AM", "Monday 5:30 AM" — in the user's locale/time zone
export function formatResetTime(resetsAt, { now = new Date(), locale, timeZone } = {}) {
  const when = resetsAt ? new Date(resetsAt) : null;
  if (!when || Number.isNaN(when.getTime())) return '';
  const time = when.toLocaleTimeString(locale, { hour: 'numeric', minute: '2-digit', timeZone });
  // Calendar day in that time zone, as YYYY-MM-DD, to count days apart
  const day = d => d.toLocaleDateString('en-CA', { timeZone });
  const days = Math.round((Date.parse(day(when)) - Date.parse(day(now))) / 86400000);
  if (days <= 0) return `at ${time}`;
  if (days === 1) return `tomorrow ${time}`;
  return `${when.toLocaleDateString(locale, { weekday: 'long', timeZone })} ${time}`;
}

// classification → the text shown to the user ('' for ok)
export function messageFor(c, opts = {}) {
  switch (c?.kind) {
    case 'ok': return '';
    case 'busy': return busyMessage(c.retryAfter || 10);
    case 'rate_limited': return RATE_LIMITED_MSG;
    case 'trial_used': {
      const back = formatResetTime(c.resetsAt, opts);
      return 'Free trials are used up for today. Add a free key in 2 minutes' + (back ? `, or come back ${back}.` : '.');
    }
    case 'blocked': return BLOCKED_MSG;
    default: return c?.serverMessage || `LeetHint server error (${c?.status || '?'})`;
  }
}


// ─────────────────────────────────────────────
// 3. WAITING LINE
// ─────────────────────────────────────────────
// Seconds to wait before retry number `attempt` (0 = the first retry):
// the server's retryAfter, then 10, 20, 40, and 60 s from then on. A later
// busy reply's own retryAfter wins when it is longer than the schedule.
export function busyDelay(attempt, retryAfterSec) {
  const ra = clampSec(retryAfterSec, 1, 60);
  if (attempt === 0) return ra || 10;
  return Math.max(Math.min(60, 10 * 2 ** (attempt - 1)), ra);
}

const abortError = () => Object.assign(new Error('Cancelled'), { name: 'AbortError' });

// Runs request(); while it fails with a busy error (err.kind === 'busy'),
// waits and tries again. 3 minutes after the first busy reply, onFallback(err)
// decides what happens (its value is returned; without it, the busy error is
// thrown). Any other error is thrown at once. signal cancels the wait: no
// further request, no further callback, rejects with an AbortError.
// onWaiting(secondsLeft, position) is called when a wait starts and every second.
export function runWithBusyRetry({
  request, now = () => Date.now(), setTimeout: setT = globalThis.setTimeout, clearTimeout: clearT = globalThis.clearTimeout,
  onWaiting, onFallback, signal, budgetMs = BUSY_BUDGET_MS
}) {
  return new Promise((resolve, reject) => {
    let firstBusyAt = null, attempt = 0, timer = null, done = false;
    const finish = (fn, v) => { if (done) return; done = true; clearT(timer); signal?.removeEventListener?.('abort', onAbort); fn(v); };
    const onAbort = () => finish(reject, abortError());
    if (signal?.aborted) return onAbort();
    signal?.addEventListener?.('abort', onAbort);

    const tick = (left, position) => {
      if (done) return;
      onWaiting?.(left, position);
      if (done) return;   // cancelled from inside onWaiting
      if (left <= 1) { timer = setT(tryOnce, 1000); return; }
      timer = setT(() => tick(left - 1, position), 1000);
    };

    async function tryOnce() {
      if (done) return;
      let result;
      try {
        result = await request();
      } catch (e) {
        if (done) return;
        if (e?.kind !== 'busy') return finish(reject, e);
        if (firstBusyAt === null) firstBusyAt = now();
        const wait = busyDelay(attempt++, e.retryAfter);
        if (now() - firstBusyAt + wait * 1000 > budgetMs) {
          if (!onFallback) return finish(reject, e);
          try { return finish(resolve, await onFallback(e)); } catch (f) { return finish(reject, f); }
        }
        return tick(wait, e.position);
      }
      finish(resolve, result);
    }
    tryOnce();
  });
}
