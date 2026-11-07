// backend/src/store.js — the shared reply cache.
// D1 (binding DB) is the main store; the old KV namespace (HINTS_CACHE) is
// still READ as a fallback for a month after the switch, then removed.
// Every function works with either binding missing (then nothing is shared).

const CACHE_TTL_MS = 30 * 24 * 3600 * 1000;   // replies older than 30 days are regenerated
const KV_TTL_SECONDS = 30 * 24 * 3600;
// D1 rows hold up to 2 MB; a reply is ~5-50 KB. Anything bigger isn't cached
// (R2 would need a payment method on the account — never add one)
const MAX_BODY_BYTES = 1_900_000;

export const hasCache = env => !!(env.DB || env.HINTS_CACHE);

// → { raw, kind, layer } or null
export async function readCache(env, key, now = Date.now()) {
  if (env.DB) {
    try {
      const row = await env.DB.prepare('SELECT kind, body, created FROM cache WHERE key = ?').bind(key).first();
      if (row && now - row.created < CACHE_TTL_MS) return { raw: row.body, kind: row.kind, layer: 'd1' };
    } catch (e) {
      console.warn('D1 cache read failed:', e.message);
    }
  }
  if (env.HINTS_CACHE) {
    const { value, metadata } = await env.HINTS_CACHE.getWithMetadata(key);
    if (value) return { raw: value, kind: metadata?.kind || 'openai', layer: 'kv' };
  }
  return null;
}

export async function writeCache(env, key, raw, kind, now = Date.now()) {
  if (env.DB) {
    if (new TextEncoder().encode(raw).length > MAX_BODY_BYTES) return console.warn('reply too large to cache:', key.slice(0, 80));
    await env.DB.prepare('INSERT OR REPLACE INTO cache (key, kind, body, created) VALUES (?, ?, ?, ?)')
      .bind(key, kind, raw, now).run();
    return;
  }
  if (env.HINTS_CACHE) await env.HINTS_CACHE.put(key, raw, { expirationTtl: KV_TTL_SECONDS, metadata: { kind } });
}


// ─────────────────────────────────────────────
// REPORTS — "Report wrong hint" (one per install, problem and UTC day)
// ─────────────────────────────────────────────
export const utcDay = (now = Date.now()) => new Date(now).toISOString().slice(0, 10);

// → true if stored, false if a duplicate (ignored)
export async function saveReport(env, installId, r, now = Date.now()) {
  const day = utcDay(now);
  if (env.DB) {
    const res = await env.DB.prepare(`INSERT OR IGNORE INTO reports (install_id, slug, day, prompt_version, reason, note, created)
                                      VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .bind(installId, r.slug, day, r.promptVersion, r.reason, r.note, now).run();
    return res.meta.changes > 0;
  }
  if (env.HINTS_CACHE) {   // before D1 exists: one KV key per report
    const key = `report:${day}:${r.slug}:${installId}`;
    if ((await env.HINTS_CACHE.getWithMetadata(key)).value) return false;
    await env.HINTS_CACHE.put(key, JSON.stringify({ ...r, created: now }), { expirationTtl: 90 * 24 * 3600 });
    return true;
  }
  return false;
}


// ─────────────────────────────────────────────
// FREE TRIALS — counted per install ID
//   fix: N per UTC day · interview: N per ISO week, once per interviewId
// ─────────────────────────────────────────────

// ISO-8601 week: "2026-W47" (weeks start Monday; week 1 holds the first Thursday)
export function isoWeek(now = Date.now()) {
  const d = new Date(now);
  const day = (d.getUTCDay() + 6) % 7;                         // Monday = 0
  const thursday = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - day + 3));
  const year = thursday.getUTCFullYear();
  const week = Math.ceil(((thursday - Date.UTC(year, 0, 1)) / 864e5 + 1) / 7);
  return `${year}-W${String(week).padStart(2, '0')}`;
}

export function nextUtcMidnightIso(now = Date.now()) {
  const d = new Date(now); d.setUTCHours(24, 0, 0, 0); return d.toISOString().replace('.000Z', 'Z');
}
export function nextMondayIso(now = Date.now()) {
  const d = new Date(now); d.setUTCHours(0, 0, 0, 0);
  d.setUTCDate(d.getUTCDate() + (7 - (d.getUTCDay() + 6) % 7));
  return d.toISOString().replace('.000Z', 'Z');
}

// Takes one trial if any is left → true; already at `limit` → false.
// One atomic statement, so parallel requests can't both take the last one.
export async function takeTrial(env, installId, action, period, limit) {
  if (limit <= 0) return false;
  const row = await env.DB.prepare(`INSERT INTO usage (install_id, period, action, count) VALUES (?, ?, ?, 1)
                                    ON CONFLICT (install_id, period, action) DO UPDATE SET count = count + 1 WHERE count < ?
                                    RETURNING count`)
    .bind(installId, period, action, limit).first();
  return !!row;
}

// Gives a trial back (the request failed before anything was generated)
export async function refundTrial(env, installId, action, period) {
  await env.DB.prepare('UPDATE usage SET count = count - 1 WHERE install_id = ? AND period = ? AND action = ? AND count > 0')
    .bind(installId, period, action).run();
}

// An interview counts once, when its start event arrives. → 'admitted' (new,
// counted), 'known' (already admitted earlier) or 'refused'
export async function admitInterview(env, installId, interviewId, limit, now = Date.now()) {
  const known = await env.DB.prepare('SELECT install_id FROM trial_interviews WHERE interview_id = ?').bind(interviewId).first();
  if (known) return known.install_id === installId ? 'known' : 'refused';
  if (!(await takeTrial(env, installId, 'interview', isoWeek(now), limit))) return 'refused';
  await env.DB.prepare('INSERT OR IGNORE INTO trial_interviews (interview_id, install_id, created) VALUES (?, ?, ?)')
    .bind(interviewId, installId, now).run();
  return 'admitted';
}


// ─────────────────────────────────────────────
// ABUSE — blocked installs
// ─────────────────────────────────────────────
export async function isBlocked(env, installId) {
  if (!env.DB || !installId) return false;
  try {
    return !!(await env.DB.prepare('SELECT 1 AS b FROM blocked WHERE install_id = ?').bind(installId).first());
  } catch (e) {
    console.warn('blocklist check failed:', e.message);
    return false;
  }
}
