// api/server-errors.js
// What the LeetHint server's refusals mean, and how to wait in line.
// Contract items 5 and 6:
//   429 { error: 'busy', retryAfter, position }  + Retry-After header → wait, then retry
//   429 { error: 'rate_limited', retryAfter }                          → no automatic retry
//   403 { error: 'trial_used', action, resetsAt }                      → offer an own key
//   403 { error: 'blocked' }                                           → short generic error
// An older Worker answers 429 with a plain message — treated as rate_limited.
// Pure logic (no chrome.*, timers injectable) so it can be unit-tested.

export const BUSY_MAX_WAIT_MS = 3 * 60 * 1000;

export const RATE_LIMITED_MSG = 'Too many requests — try again in a minute.';
export const BLOCKED_MSG = 'LeetHint can\'t serve this request right now.';

const seconds = v => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.min(Math.ceil(n), 600) : 0;
};

// → { code, retryAfter, position, action, resetsAt, message }
export function classifyServerError(status, body = {}, headers = null) {
  const b = body && typeof body === 'object' ? body : {};
  const headerWait = seconds(headers?.get?.('Retry-After'));
  const retryAfter = seconds(b.retryAfter) || headerWait;
  if (status === 429 && b.error === 'busy') {
    return { code: 'busy', retryAfter: retryAfter || 10, position: Number(b.position) || 0, message: busyMessage(retryAfter || 10) };
  }
  if (status === 429) {
    return { code: 'rate_limited', retryAfter: retryAfter || 60, message: RATE_LIMITED_MSG };
  }
  if (status === 403 && b.error === 'trial_used') {
    return { code: 'trial_used', action: b.action === 'interview' ? 'interview' : 'fix', resetsAt: b.resetsAt || '', message: trialUsedMessage(b.resetsAt) };
  }
  if (status === 403 && b.error === 'blocked') {
    return { code: 'blocked', message: BLOCKED_MSG };
  }
  return { code: 'other', message: (typeof b.error === 'string' && b.error) || `LeetHint server error (${status})` };
}

export const busyMessage = sec => `High demand — you're in line (~${Math.max(1, Math.round(sec))} s)`;

// "come back tomorrow at 5:30 AM" — the reset time in the user's own time zone
export function trialUsedMessage(resetsAt, now = new Date()) {
  const when = resetsAt ? new Date(resetsAt) : null;
  let back = 'later';
  if (when && !Number.isNaN(when.getTime())) {
    const time = when.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    const day = new Date(now); day.setHours(0, 0, 0, 0);
    const target = new Date(when); target.setHours(0, 0, 0, 0);
    const days = Math.round((target - day) / 86400000);
    back = days <= 0 ? `today at ${time}` : days === 1 ? `tomorrow at ${time}`
         : `on ${when.toLocaleDateString([], { weekday: 'long' })} at ${time}`;
  }
  return `Free trials are used up for today. Add a free key in 2 minutes, or come back ${back}.`;
}

// Seconds to wait before try number `attempt` (0 = first retry):
// the server's retryAfter first, then 10 s, 20 s, 40 s, and 60 s from then on
export function busyDelay(attempt, retryAfterSec = 0) {
  if (attempt === 0) return seconds(retryAfterSec) || 10;
  return Math.min(60, 10 * 2 ** (attempt - 1));
}

// Runs call(); while it fails with a 'busy' error, waits and tries again,
// for up to maxWaitMs in total. onWait(seconds, position) is told about each
// wait. Any other error — or still busy after the limit — is thrown.
export async function withBusyRetry(call, {
  onWait, sleep = ms => new Promise(r => setTimeout(r, ms)), now = () => Date.now(), maxWaitMs = BUSY_MAX_WAIT_MS
} = {}) {
  const start = now();
  for (let attempt = 0; ; attempt++) {
    try {
      return await call();
    } catch (e) {
      if (e?.code !== 'busy') throw e;
      const waitSec = busyDelay(attempt, e.retryAfter);
      if (now() - start + waitSec * 1000 > maxWaitMs) {
        e.message = 'LeetHint is very busy right now — please try again in a few minutes.';
        throw e;
      }
      onWait?.(waitSec, e.position || 0);
      await sleep(waitSec * 1000);
    }
  }
}
