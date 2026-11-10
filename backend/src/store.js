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

// Only a reply whose model finished normally and actually wrote an answer is
// cached — a cut-off reply would otherwise be served forever. (One regex pass
// over the finished text, never per-chunk work.)
// Solutions and hints are cached only when a LARGE model wrote them: one
// wrong answer from a small fallback model would otherwise be served to every
// later user (and exported to the static site). Translations of verified code
// are fine from any model. label: "Groq (openai/gpt-oss-120b)" etc.
export const LARGE_MODEL = /gpt-oss-120b|kimi-k2|deepseek-r1|qwen-3-235b|qwen-3-coder|nemotron-3-ultra|gemini-3\.8-flash|gemini-flash-latest/i;
export function cacheableFrom(key, label) {
  const action = String(key).split(':')[1] || '';
  if (!/^(hints|solve|fix)(-|$)/.test(action)) return true;
  return LARGE_MODEL.test(String(label || ''));
}

// The answer text of a finished SSE reply: one native regex pass over the
// string fields (OpenAI-style "content", Workers AI "response", Gemini "text").
// Escapes are left as they are — only the ---TAG--- delimiters are looked at.
export function replyText(raw) {
  let text = '';
  for (const m of String(raw).matchAll(/"(?:content|response|text)"\s*:\s*"((?:[^"\\]|\\.)*)"/g)) text += m[1];
  return text;
}

// A finished reply can still be unusable: a model that leaks its raw
// reasoning or chat-format tokens ("analysis: …", "<|return|>") and mangles
// the delimiters ("--- H hint1"). The extension then fails to parse it, and a
// cached copy would fail for every later user. Hints need all four hint
// sections, solve/fix a CODE section. Other actions aren't checked.
export function hasRequiredSections(raw, key) {
  const action = String(key).split(':')[1] || '';
  if (!/^(hints|solve|fix)(-|$)/.test(action)) return true;
  const text = replyText(raw);
  if (/<\|(?:return|channel|message|end|start)\|>/.test(text)) return false;
  const tags = action.startsWith('hints') ? ['HINT1', 'HINT2', 'HINT3', 'HINT4'] : ['CODE'];
  return tags.every(t => new RegExp(`---\\s*${t}\\s*---`, 'i').test(text));
}

export function isCompleteReply(raw, kind) {
  const cut = /"finish_reason"\s*:\s*"length"|"finishReason"\s*:\s*"MAX_TOKENS"/.test(raw);
  const finished = !cut && (kind === 'gemini' ? /"finishReason"\s*:\s*"STOP"/.test(raw)
                 : kind === 'workersai' ? raw.includes('[DONE]')
                 : /"finish_reason"\s*:\s*"stop"/.test(raw));
  const answered = kind === 'gemini' ? /"text"\s*:\s*"[^"]/.test(raw)
                 : /"(content|response)"\s*:\s*"[^"]/.test(raw);
  return finished && answered;
}

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
  if (env.HINTS_CACHE && kvFallbackOpen(env, now)) {
    try {
      const { value, metadata } = await env.HINTS_CACHE.getWithMetadata(key);
      if (value) return { raw: value, kind: metadata?.kind || 'openai', layer: 'kv' };
    } catch (e) {
      console.warn('KV cache read failed:', e.message);
    }
  }
  return null;
}

// With D1 in place, KV is read only until KV_FALLBACK_UNTIL (YYYY-MM-DD, UTC,
// a month after the D1 switch); after that day it is skipped, and the
// HINTS_CACHE binding can be deleted from wrangler.toml. Empty → no end date.
export function kvFallbackOpen(env, now = Date.now()) {
  if (!env.DB) return true;   // KV is still the only store
  const until = Date.parse(`${env.KV_FALLBACK_UNTIL || ''}T23:59:59Z`);
  return Number.isNaN(until) || now <= until;
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
