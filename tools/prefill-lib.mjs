// tools/prefill-lib.mjs — the pure parts of tools/prefill.mjs (no network, no
// files): run window, token budgets, problem order, what to do next, state
// bookkeeping and the summary. Tested in tests/prefill-plan.test.mjs.

// ── time ──
export const hm = s => {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(s || '').trim());
  if (!m || +m[1] > 23 || +m[2] > 59) throw new Error(`Not a HH:MM time: "${s}"`);
  return +m[1] * 60 + +m[2];
};

// Seconds since midnight in timeZone, and that zone's date (YYYY-MM-DD)
export function clock(now, timeZone) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit'
  }).formatToParts(now).map(p => [p.type, p.value]));
  return { seconds: +parts.hour * 3600 + +parts.minute * 60 + +parts.second, date: `${parts.year}-${parts.month}-${parts.day}` };
}

export const utcDay = now => new Date(now).toISOString().slice(0, 10);

// → { inside, msLeft, phase } for the run window [start, end) in timeZone.
// phase: 'before' the quota reset (05:30 IST = 00:00 UTC) or 'after' it.
export function windowStatus(now, { timeZone, start, end, quotaReset }) {
  const { seconds } = clock(now, timeZone);
  const s = hm(start) * 60, e = hm(end) * 60;
  if (e <= s) throw new Error(`The end time ${end} must be after the start time ${start} (same day)`);
  return {
    inside: seconds >= s && seconds < e,
    msLeft: Math.max(0, (e - seconds) * 1000),
    msToReset: Math.max(0, (hm(quotaReset) * 60 - seconds) * 1000),
    phase: seconds < hm(quotaReset) * 60 ? 'before' : 'after'
  };
}

// ── tokens ──
// state.tokens = { "<UTC day>": { before, after } }: estimated tokens used.
// Before 05:30 IST it is still the PREVIOUS UTC day — its leftover quota.
export function tokensLeft(state, now, phase, tokens) {
  const used = state.tokens?.[utcDay(now)]?.[phase] || 0;
  return (phase === 'before' ? tokens.beforeReset : tokens.afterReset) - used;
}

export function spendTokens(state, now, phase, n) {
  const day = utcDay(now);
  state.tokens ||= {};
  state.tokens[day] ||= { before: 0, after: 0 };
  state.tokens[day][phase] += n;
  // keep the last few days only
  for (const d of Object.keys(state.tokens).sort().slice(0, -4)) delete state.tokens[d];
}

// What a task will roughly cost before it starts
export const estimateTokens = (task, tokens) =>
  (task.kind === 'translate' ? 0 : tokens.hints) + task.langs.length * tokens.translation;

// ── order ──
// companyDoc: data/company-problems.json (times reported per company);
// tags: data/companies.json (slug → companies) for problems not in it
export function companyFrequency(companyDoc, tags = {}) {
  const score = new Map();
  for (const rows of Object.values(companyDoc?.companies || {})) {
    for (const [slug, , times] of rows) score.set(slug, (score.get(slug) || 0) + (Number(times) || 0));
  }
  for (const [slug, cos] of Object.entries(tags)) if (!score.has(slug)) score.set(slug, Array.isArray(cos) ? cos.length * 0.5 : 0.5);
  return score;
}

// free: [{ titleSlug, likes }] (free problems only) → slugs in pre-fill order:
// Blind 75 → NeetCode 150 → company problems (most reported first) → the
// rest (most liked first). Every free problem exactly once.
export function orderProblems(free, { blind75 = [], neetcode150 = [] } = {}, frequency = new Map()) {
  const isFree = new Set(free.map(q => q.titleSlug));
  const out = [], seen = new Set();
  const add = s => { if (isFree.has(s) && !seen.has(s)) { seen.add(s); out.push(s); } };
  blind75.forEach(add);
  neetcode150.forEach(add);
  [...frequency.entries()].filter(([s]) => isFree.has(s)).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).forEach(([s]) => add(s));
  [...free].sort((a, b) => (b.likes || 0) - (a.likes || 0) || a.titleSlug.localeCompare(b.titleSlug)).forEach(q => add(q.titleSlug));
  return out;
}

// ── what to do ──
// fileInfo(slug) → { promptVersion, langs } of cache-site/cache/<slug>.json, or null
// → { mode, tasks: [{ slug, kind: 'full'|'translate', langs, priority }], remaining, priorityRemaining, exhausted, cachedNow: [slugs] }
export function planTasks({ ordered, ids = {}, state, cfg, mode = 'auto', promptVersion, fileInfo = () => null, only = [] }) {
  const priority = new Set(ordered.slice(0, cfg.priority.count));
  const langsFor = slug => (priority.has(slug) ? cfg.priority.languages : cfg.languages);
  const cachedNow = [];
  const isDone = slug => {
    if (state.done?.[slug]?.promptVersion === promptVersion) return true;
    const f = fileInfo(slug);
    if (f && f.promptVersion === promptVersion) { cachedNow.push(slug); return true; }
    return false;
  };
  const exhausted = slug => (state.failed?.[slug]?.attempts || 0) >= cfg.maxAttempts;
  const full = slug => ({ slug, kind: 'full', langs: langsFor(slug), priority: priority.has(slug) });

  if (only.length) return { mode: 'only', tasks: only.map(full), remaining: 0, priorityRemaining: 0, exhausted: [], cachedNow };

  const open = ordered.filter(s => !isDone(s) && !state.skipped?.[s]);
  // New = released after the first listing (higher frontend id); the backlog is the rest
  const maxId = Number(state.backlogMaxId) || 0;
  const isNew = s => maxId > 0 && Number(ids[s]) > maxId;
  const todo = open.filter(s => !exhausted(s));
  const backlog = todo.filter(s => !isNew(s));
  const newOnes = todo.filter(isNew);
  const priorityRemaining = backlog.filter(s => priority.has(s)).length;
  // Done problems that are missing some of the configured languages
  const backfill = cfg.backfillPriorityLanguages
    ? ordered.filter(s => state.done?.[s]?.promptVersion === promptVersion)
        .map(s => ({ s, missing: cfg.languages.filter(l => !(state.done[s].langs || []).includes(l)) }))
        .filter(x => x.missing.length)
        .map(x => ({ slug: x.s, kind: 'translate', langs: x.missing, priority: priority.has(x.s) }))
    : [];

  let chosen = mode;
  if (mode === 'auto') chosen = backlog.length ? 'backlog' : 'new';
  const tasks = chosen === 'backlog' ? backlog.map(full)
              : chosen === 'new' ? [...newOnes.map(full), ...(mode === 'auto' ? backfill : [])]
              : chosen === 'backfill' ? backfill
              : (() => { throw new Error(`Unknown --mode ${mode} (backlog | new | backfill)`); })();
  return { mode: chosen, tasks, remaining: backlog.length, newLeft: newOnes.length, priorityRemaining, exhausted: open.filter(exhausted), cachedNow, backfillLeft: backfill.length };
}

// ── state ──
export function emptyState() {
  return { version: 1, backlogMaxId: 0, done: {}, failed: {}, skipped: {}, tokens: {}, runs: [], totals: { newCached: 0, alreadyCached: 0, failed: 0 }, lastRun: null };
}

export function recordDone(state, slug, { promptVersion, langs, at }) {
  const before = state.done[slug];
  const same = before?.promptVersion === promptVersion;
  state.done[slug] = { at, promptVersion, langs: [...new Set([...(same ? before.langs || [] : []), ...langs])], published: false };
  delete state.failed[slug];
}

// countsAsAttempt: false for the AI being at its limit (not the problem's fault)
export function recordFailure(state, slug, message, { at, countsAsAttempt = true } = {}) {
  const f = state.failed[slug] || { attempts: 0 };
  state.failed[slug] = { attempts: f.attempts + (countsAsAttempt ? 1 : 0), lastError: String(message).replace(/\s+/g, ' ').slice(0, 300), at };
}

// The AI side is out of capacity or the network/Worker failed — not the problem
export const isTransient = e =>
  e?.status === 429 || e?.status >= 500 || e?.code === 'busy' || e?.code === 'rate_limited' || !!e?.offline ||
  /fetch failed|ECONNREFUSED|ECONNRESET|ETIMEDOUT|network|aborted|timed? ?out/i.test(String(e?.message || ''));

// ── summary ──
// Average new problems per day over the last 7 scheduled runs (fallback when none)
export function perDay(state, fallback) {
  const runs = (state.runs || []).filter(r => r.mode === 'backlog' && !r.manual).slice(-7);
  const avg = runs.length ? runs.reduce((n, r) => n + r.newCached, 0) / runs.length : 0;
  return avg > 0 ? avg : fallback;
}

export function daysLeft(remaining, rate) {
  return remaining <= 0 ? 0 : Math.ceil(remaining / Math.max(1, rate));
}

// → a warning string when the priority problems won't be done before `hackathon`
export function hackathonWarning({ priorityRemaining, rate, hackathon, today, count }) {
  if (!hackathon || priorityRemaining <= 0) return '';
  const daysUntil = Math.round((Date.parse(hackathon) - Date.parse(today)) / 86400000);
  if (daysUntil < 0) return '';
  const need = daysLeft(priorityRemaining, rate);
  if (need <= daysUntil) return '';
  const perRunNeeded = Math.ceil(priorityRemaining / Math.max(1, daysUntil));
  return `⚠ The first ${count} won't be done before the hackathon (${hackathon}): ${priorityRemaining} left at ~${Math.round(rate)}/day ` +
         `= ${need} day(s), but only ${daysUntil} morning(s) remain. Need ~${perRunNeeded}/day — do a one-off longer run, e.g. ` +
         `node tools/prefill.mjs --until 09:00 (or bash tools/prefill-nightly.sh --until 09:00).`;
}
