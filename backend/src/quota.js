// backend/src/quota.js — QuotaKeeper, ONE Durable Object for the whole Worker
//
// Each Worker copy used to track the providers' tokens-per-minute in its own
// memory, so under load the copies couldn't see each other and all hit a
// provider at once. Every copy now asks this single object before calling a
// provider, so the free per-minute budgets are shared fairly.
//
// It also protects the hints: personal AI features (Fix, mock interviews) may
// use only TRIAL_DAILY_TOKENS a day (default 25% of DAILY_TOKENS), and at most
// MAX_TRIAL_INTERVIEWS run at once, each with its whole budget reserved up
// front so none dies halfway. Hints and translations always keep the rest.
//
// State is kept in memory: if Cloudflare restarts the object, the counters
// start again from zero — at worst one minute's budget is used twice.

const MINUTE_MS = 60_000;
const DAY_MS = 86_400_000;
const INTERVIEW_TTL_MS = 40 * 60_000;     // an admitted interview's slot is freed after this

export class QuotaKeeper {
  constructor(state, env) {
    this.env = env;
    this.minute = new Map();       // "Provider/model" → { start, used }
    this.paused = new Map();       // "Provider/model" or "Provider" → until (ms)
    this.trial = { day: '', used: 0 };
    this.interviews = new Map();   // interviewId → expires (ms)
  }

  async fetch(request) {
    const { op, ...args } = await request.json();
    const now = args.now ?? Date.now();
    if (op === 'reserve') return Response.json(this.reserve(args, now));
    if (op === 'pause') { this.paused.set(args.key, args.until); return Response.json({ ok: true }); }
    if (op === 'paused') return Response.json({ paused: [...this.paused].filter(([, until]) => until > now).map(([k]) => k) });
    if (op === 'admitInterview') return Response.json(this.admitInterview(args, now));
    return Response.json({ error: 'unknown op' }, { status: 400 });
  }

  // { key, tokens, perMinute, trial } → { ok } | { ok: false, waitMs } | { ok: false, trialFull: true }
  reserve({ key, tokens, perMinute, trial }, now) {
    if (trial && !this.useTrialTokens(tokens, now)) return { ok: false, trialFull: true };
    if (!perMinute) return { ok: true };                   // no per-minute cap known (e.g. Workers AI)
    let w = this.minute.get(key);
    if (!w || now - w.start >= MINUTE_MS) w = { start: now, used: 0 };
    if (w.used + tokens > perMinute) {
      if (trial) this.trial.used -= tokens;                // not spent after all
      return { ok: false, waitMs: w.start + MINUTE_MS - now };
    }
    w.used += tokens;
    this.minute.set(key, w);
    return { ok: true };
  }

  trialBudget() {
    const daily = Number(this.env.DAILY_TOKENS) || 1_500_000;
    return Number(this.env.TRIAL_DAILY_TOKENS) || Math.floor(daily * 0.25);
  }

  useTrialTokens(tokens, now) {
    const day = new Date(now).toISOString().slice(0, 10);
    if (this.trial.day !== day) this.trial = { day, used: 0 };
    if (this.trial.used + tokens > this.trialBudget()) return false;
    this.trial.used += tokens;
    return true;
  }

  // A new trial interview: a free slot (at most MAX_TRIAL_INTERVIEWS at once)
  // and its whole token budget, reserved now → { ok } | { ok: false, reason }
  admitInterview({ interviewId, tokens }, now) {
    for (const [id, expires] of this.interviews) if (expires <= now) this.interviews.delete(id);
    if (this.interviews.has(interviewId)) return { ok: true };
    const max = Number(this.env.MAX_TRIAL_INTERVIEWS) || 3;
    if (this.interviews.size >= max) return { ok: false, reason: 'busy' };
    if (!this.useTrialTokens(tokens, now)) return { ok: false, reason: 'trialFull' };
    this.interviews.set(interviewId, now + INTERVIEW_TTL_MS);
    return { ok: true };
  }
}

// ─────────────────────────────────────────────
// Worker side — a tiny client. Without the QUOTA binding every call answers
// "allowed", so the Worker behaves exactly as before.
// ─────────────────────────────────────────────
export function quotaClient(env) {
  if (!env.QUOTA) return null;
  const keeper = env.QUOTA.get(env.QUOTA.idFromName('global'));
  const ask = async body => (await keeper.fetch('https://quota/', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
  })).json();
  return {
    reserve: (key, tokens, perMinute, trial = false) => ask({ op: 'reserve', key, tokens, perMinute, trial }),
    pause: (key, until) => ask({ op: 'pause', key, until }),
    paused: async () => new Set((await ask({ op: 'paused' })).paused),
    admitInterview: (interviewId, tokens) => ask({ op: 'admitInterview', interviewId, tokens })
  };
}

export { MINUTE_MS, DAY_MS };
