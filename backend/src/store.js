// backend/src/store.js — everything the Worker keeps between requests
//
// D1 (binding DB) is the store: ~100,000 row writes a day on the free plan,
// where KV allows ~1,000. Until the DB binding exists — and for one month
// after, while old replies age out — KV (binding HINTS_CACHE) still works as
// before, so nothing breaks during the move.
//
// Schema: backend/migrations/0001_init.sql

const KV_TTL_SECONDS = 60 * 60 * 24 * 30;          // KV fallback only
const MAX_BODY_CHARS = 1_500_000;                   // well inside D1's row size limit
const now = () => Math.floor(Date.now() / 1000);


// ─────────────────────────────────────────────
// 1. SHARED REPLY CACHE
// ─────────────────────────────────────────────

// → { raw, kind, layer } or null
export async function getCached(env, key) {
  if (env.DB) {
    const row = await env.DB.prepare('SELECT kind, body FROM cache WHERE key = ?').bind(key).first();
    if (row) return { raw: row.body, kind: row.kind || 'openai', layer: 'd1' };
  }
  if (env.HINTS_CACHE) {
    const { value, metadata } = await env.HINTS_CACHE.getWithMetadata(key);
    if (value) return { raw: value, kind: metadata?.kind || 'openai', layer: 'kv' };
  }
  return null;
}

export async function putCached(env, key, raw, kind) {
  if (raw.length > MAX_BODY_CHARS) return;   // far beyond any real reply — not worth storing
  if (env.DB) {
    await env.DB.prepare('INSERT OR REPLACE INTO cache (key, kind, body, created) VALUES (?, ?, ?, ?)')
      .bind(key, kind, raw, now()).run();
  } else if (env.HINTS_CACHE) {
    await env.HINTS_CACHE.put(key, raw, { expirationTtl: KV_TTL_SECONDS, metadata: { kind } });
  }
}

export const hasCache = env => Boolean(env.DB || env.HINTS_CACHE);

// A reply worth keeping: the model finished normally and wrote an answer.
// A cut-off reply would otherwise be served to everyone, forever.
export function isCompleteReply(raw, kind) {
  const cut = /"finish_reason"\s*:\s*"length"|"finishReason"\s*:\s*"MAX_TOKENS"/.test(raw);
  const finished = !cut && (kind === 'gemini' ? /"finishReason"\s*:\s*"STOP"/.test(raw)
                 : kind === 'workersai' ? raw.includes('[DONE]')
                 : /"finish_reason"\s*:\s*"stop"/.test(raw));
  const answered = kind === 'gemini' ? /"text"\s*:\s*"[^"]/.test(raw)
                 : /"(content|response)"\s*:\s*"[^"]/.test(raw);
  return finished && answered;
}


// ─────────────────────────────────────────────
// 2. REPORTS — one per problem, reporter and day (a repeat is ignored)
// ─────────────────────────────────────────────
export async function saveReport(env, { slug, day, reporter, promptVersion, reason, note }) {
  if (env.DB) {
    await env.DB.prepare(`INSERT OR IGNORE INTO reports (slug, day, reporter, prompt_version, reason, note, created)
                          VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .bind(slug, day, reporter, promptVersion, reason, note, now()).run();
  } else if (env.HINTS_CACHE) {
    await env.HINTS_CACHE.put(`report:${slug}:${day}:${reporter}`,
      JSON.stringify({ slug, day, promptVersion, reason, note }), { expirationTtl: 60 * 60 * 24 * 90 });
  }
}


// ─────────────────────────────────────────────
// 3. FREE TRIALS — counted per install ID (needs D1; without it, no limit)
// ─────────────────────────────────────────────

// UTC day "2026-11-07" and ISO week "2026-W45"
export function dayPeriod(date = new Date()) {
  return date.toISOString().slice(0, 10);
}
export function weekPeriod(date = new Date()) {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const weekday = d.getUTCDay() || 7;              // Monday = 1 … Sunday = 7
  d.setUTCDate(d.getUTCDate() + 4 - weekday);      // the Thursday of this week decides its year
  const yearStart = Date.UTC(d.getUTCFullYear(), 0, 1);
  const week = Math.ceil(((d - yearStart) / 86400000 + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

// When the current period ends (the trial resets) — ISO string
export function periodResetsAt(kind, date = new Date()) {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() + 1));
  if (kind === 'week') {
    const weekday = date.getUTCDay() || 7;
    d.setUTCDate(date.getUTCDate() + (8 - weekday));   // next Monday 00:00 UTC
  }
  return d.toISOString().replace('.000', '');
}

// Uses one trial of `action` in `period` if fewer than `limit` were used.
// → true (granted) | false (used up). Atomic: one statement, no race.
export async function useTrial(env, installId, period, action, limit) {
  if (!env.DB) return true;
  if (limit <= 0) return false;
  const row = await env.DB.prepare(`
    INSERT INTO usage (install_id, period, action, count) VALUES (?, ?, ?, 1)
    ON CONFLICT (install_id, period, action) DO UPDATE SET count = count + 1 WHERE count < ?
    RETURNING count`).bind(installId, period, action, limit).first();
  return Boolean(row);
}

// An interview already admitted: its later turns are free
export async function isAdmittedInterview(env, interviewId) {
  if (!env.DB) return true;
  return Boolean(await env.DB.prepare('SELECT 1 AS a FROM interviews WHERE interview_id = ?').bind(interviewId).first());
}

// Recorded only AFTER its trial was granted, so a refused interview stays refused
export async function admitInterview(env, interviewId, installId) {
  if (!env.DB) return;
  await env.DB.prepare('INSERT OR IGNORE INTO interviews (interview_id, install_id, created) VALUES (?, ?, ?)')
    .bind(interviewId, installId, now()).run();
}


// ─────────────────────────────────────────────
// 4. BLOCKLIST
// ─────────────────────────────────────────────
export async function isBlocked(env, installId) {
  if (!env.DB || !installId) return false;
  return Boolean(await env.DB.prepare('SELECT 1 AS b FROM blocked WHERE install_id = ?').bind(installId).first());
}


// ─────────────────────────────────────────────
// 5. DAILY COUNTERS — for GET /stats (one row per counter per day)
// ─────────────────────────────────────────────
export async function bumpCounters(env, names, day = dayPeriod()) {
  if (!env.DB || !names.length) return;
  const stmt = 'INSERT INTO stats (day, name, count) VALUES (?, ?, 1) ON CONFLICT (day, name) DO UPDATE SET count = count + 1';
  for (const name of names) await env.DB.prepare(stmt).bind(day, name).run();
}

// Today's counters and trial use, for the private /stats page
export async function todaysStats(env, date = new Date()) {
  if (!env.DB) return null;
  const day = dayPeriod(date);
  const counters = Object.fromEntries((await env.DB.prepare('SELECT name, count FROM stats WHERE day = ? ORDER BY name')
    .bind(day).all()).results.map(r => [r.name, r.count]));
  const trials = (await env.DB.prepare(`SELECT action, COUNT(*) AS installs, SUM(count) AS used FROM usage
                                         WHERE period IN (?, ?) GROUP BY action`).bind(day, weekPeriod(date)).all()).results;
  return { day, counters, trials: Object.fromEntries(trials.map(t => [t.action, { installs: t.installs, used: t.used }])) };
}
