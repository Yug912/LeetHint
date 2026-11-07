// backend/src/quota.js — ONE global view of the AI providers' free-tier limits.
//
// Every Worker copy used to keep its own token buckets and "daily limit hit"
// pauses in memory, so 50 copies each believed they had Groq's whole
// per-minute budget. QuotaKeeper (a single Durable Object) now holds them for
// all copies:
//   • per-model tokens/minute buckets, as the providers' refusals and
//     rate-limit headers report them — every copy orders its models by them
//     (models with room first). A success doesn't lower the bucket: Groq
//     counts max_tokens up front and refunds the unused part later, so
//     subtracting it made the best model look busy for ~35 s after every
//     request and sent hints to weaker models
//   • before each attempt a request reserves estimateTokens(prompt) +
//     maxTokens from the day's budget; refused → the caller tries its next model
//   • daily pauses for models/providers whose daily allowance is used up
//   • the day's token budget, split 70% hints/translations (cache misses),
//     25% trials (Fix, mock interviews), 5% reserve (overflow for hints only)
//   • admission of free trial interviews (≈60k tokens each, ≤3 at once)
//
// Without the QUOTA binding (local tests, or before the first deploy with it)
// the same book runs in this Worker copy's memory — exactly the old behaviour.

export const SHARES = { hints: 0.70, trial: 0.25, reserve: 0.05 };
const DEFAULT_DAILY_TOKENS = 3_000_000;   // all free providers together; QUOTA_DAILY_TOKENS overrides
export const INTERVIEW_TOKENS = 60_000;   // what one trial interview costs, roughly
export const MAX_TRIAL_INTERVIEWS = 3;    // running at the same time
const INTERVIEW_IDLE_MS = 40 * 60 * 1000; // an interview silent this long is over

const utcDay = now => new Date(now).toISOString().slice(0, 10);

// The bookkeeping itself — pure, so it can be tested and run anywhere
export class QuotaBook {
  constructor(saved = {}, dailyTokens = DEFAULT_DAILY_TOKENS) {
    this.dailyTokens = dailyTokens;
    this.buckets = new Map();                                   // "Provider/model" → { remaining, limit, at }
    this.paused = new Map(Object.entries(saved.paused || {}));  // "Provider/model" or "Provider" → until (ms)
    this.day = saved.day || '';
    this.used = { hints: 0, trial: 0, reserve: 0, ...saved.used };
    this.byProvider = { ...saved.byProvider };                  // today's reserved tokens per provider
    this.interviews = new Map(Object.entries(saved.interviews || {}));   // interviewId → lastSeen
  }

  rollDay(now) {
    const d = utcDay(now);
    if (d === this.day) return;
    this.day = d;
    this.used = { hints: 0, trial: 0, reserve: 0 };
    this.byProvider = {};
  }

  shareLeft(share, now) {
    this.rollDay(now);
    const own = this.dailyTokens * SHARES[share] - this.used[share];
    const reserve = share === 'hints' ? this.dailyTokens * SHARES.reserve - this.used.reserve : 0;
    return Math.max(0, own) + Math.max(0, reserve);
  }

  // → { ok: true } or { ok: false, reason: 'daily_share' | 'paused' }
  reserve({ key, provider, tokens, share = 'hints' }, now = Date.now()) {
    this.rollDay(now);
    if (this.paused.get(key) > now || this.paused.get(provider) > now) return { ok: false, reason: 'paused' };
    // The day's share: hints may borrow the reserve once their own 70% is gone
    const ownLeft = this.dailyTokens * SHARES[share] - this.used[share];
    let from = share;
    if (ownLeft < tokens) {
      if (share === 'hints' && this.dailyTokens * SHARES.reserve - this.used.reserve >= tokens) from = 'reserve';
      else return { ok: false, reason: 'daily_share' };
    }
    this.used[from] += tokens;
    if (provider) this.byProvider[provider] = (this.byProvider[provider] || 0) + tokens;
    return { ok: true };
  }

  // What a provider's reply headers / 429 message said about a bucket
  record({ key, remaining, limit }, now = Date.now()) {
    if (!Number.isFinite(remaining)) return;
    const prev = this.buckets.get(key);
    this.buckets.set(key, { remaining, limit: Number.isFinite(limit) ? limit : prev?.limit, at: now });
  }

  pause({ key, until }) { this.paused.set(key, until); }

  // Free trial interviews: a new one only while fewer than 3 run and the
  // trial share still holds a whole interview. → { ok, reason? }
  admitInterview({ id }, now = Date.now()) {
    for (const [k, seen] of this.interviews) if (now - seen > INTERVIEW_IDLE_MS) this.interviews.delete(k);
    if (this.interviews.has(id)) { this.interviews.set(id, now); return { ok: true }; }
    if (this.interviews.size >= MAX_TRIAL_INTERVIEWS) return { ok: false, reason: 'busy' };
    if (this.shareLeft('trial', now) < INTERVIEW_TOKENS) return { ok: false, reason: 'daily_share' };
    this.interviews.set(id, now);
    return { ok: true };
  }
  touchInterview({ id }, now = Date.now()) { if (this.interviews.has(id)) this.interviews.set(id, now); }
  endInterview({ id }) { this.interviews.delete(id); }

  snapshot(_args = {}, now = Date.now()) {
    this.rollDay(now);
    return {
      buckets: Object.fromEntries(this.buckets),
      paused: Object.fromEntries([...this.paused].filter(([, until]) => until > now)),
      day: this.day, used: { ...this.used }, byProvider: { ...this.byProvider },
      dailyTokens: this.dailyTokens,
      left: Object.fromEntries(Object.keys(SHARES).map(s => [s, Math.max(0, this.dailyTokens * SHARES[s] - this.used[s])])),
      interviewsRunning: this.interviews.size
    };
  }

  // What survives the Durable Object being evicted (buckets refill within a minute anyway)
  saved() {
    return { day: this.day, used: this.used, byProvider: this.byProvider,
             paused: Object.fromEntries(this.paused), interviews: Object.fromEntries(this.interviews) };
  }
}

const OPS = ['reserve', 'record', 'pause', 'admitInterview', 'touchInterview', 'endInterview', 'snapshot'];

// The Durable Object — one instance (idFromName('global')) for the whole Worker.
// It only does map lookups: well inside the free plan's limits.
export class QuotaKeeper {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.book = null;
    this.dailyTokens = Number(env.QUOTA_DAILY_TOKENS) || DEFAULT_DAILY_TOKENS;
  }

  async fetch(request) {
    if (!this.book) this.book = new QuotaBook(await this.ctx.storage.get('book') || {}, this.dailyTokens);
    const op = new URL(request.url).pathname.slice(1);
    if (!OPS.includes(op)) return new Response('unknown op', { status: 404 });
    const args = request.method === 'POST' ? await request.json() : {};
    const out = this.book[op](args, Date.now()) ?? { ok: true };
    if (op !== 'snapshot' && op !== 'record') await this.ctx.storage.put('book', this.book.saved());
    return Response.json(out);
  }
}

// The client every Worker copy uses: the Durable Object when bound, else a
// book in this copy's memory. Never throws — a quota hiccup must not take
// hint generation down with it (it then behaves like the old per-copy limits).
const localBooks = new WeakMap();
export function quotaClient(env) {
  if (!env.QUOTA) {
    let book = localBooks.get(env);
    if (!book) localBooks.set(env, book = new QuotaBook({}, Number(env.QUOTA_DAILY_TOKENS) || DEFAULT_DAILY_TOKENS));
    return Object.fromEntries(OPS.map(op => [op, async args => book[op](args || {}, Date.now()) ?? { ok: true }]));
  }
  const stub = env.QUOTA.get(env.QUOTA.idFromName('global'));
  const call = async (op, args) => {
    try {
      const res = await stub.fetch(`https://quota/${op}`, { method: 'POST', body: JSON.stringify(args || {}) });
      return await res.json();
    } catch (e) {
      console.warn(`quota ${op} failed:`, e.message);
      return op === 'snapshot' ? { buckets: {}, paused: {} } : { ok: true };
    }
  };
  return Object.fromEntries(OPS.map(op => [op, args => call(op, args)]));
}
