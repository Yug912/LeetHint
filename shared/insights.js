// shared/insights.js
// Local-only learning features (plans 4.2, 4.3, 4.5, 4.6) — pure logic, no
// chrome.*, so each can be unit-tested. Everything here works on data kept in
// chrome.storage.local; nothing is sent anywhere.

import { localDate, daysBetween } from './revision.js';
import { normalizePattern, chipsIn } from './patterns.js';

const DIFFS = ['easy', 'medium', 'hard'];
const diffOf = d => (DIFFS.includes(String(d || '').toLowerCase()) ? String(d).toLowerCase() : 'unknown');


// ─────────────────────────────────────────────
// 1. CONFIDENCE CHECK (plan 4.2)
//    confidenceLog: [{ slug, answer: 'yes'|'maybe'|'no', difficulty, date, solo }]
//    solo: true = solved with no hints (score 100), false = needed hints,
//    null = not solved yet (not counted)
// ─────────────────────────────────────────────
export const CONFIDENCE_MIN_ENTRIES = 10;

const rate = (rows) => (rows.length ? rows.filter(r => r.solo).length / rows.length : null);

// One difficulty's (or all) verdict from the solo rates per answer
function verdict(rows) {
  const yes = rate(rows.filter(r => r.answer === 'yes'));
  const no = rate(rows.filter(r => r.answer === 'no'));
  if (yes !== null && yes < 0.5) return 'overconfident';
  if (no !== null && no >= 0.5) return 'underconfident';
  return 'well-calibrated';
}

// → null until there are 10 answered-and-solved entries, else
//   { total, yesSoloPct, headline, verdict, byDifficulty: [{ difficulty, total, yesSoloPct, verdict }] }
export function confidenceSummary(log = [], { minEntries = CONFIDENCE_MIN_ENTRIES } = {}) {
  const done = (log || []).filter(e => e && ['yes', 'maybe', 'no'].includes(e.answer) && typeof e.solo === 'boolean');
  if (done.length < minEntries) return null;
  const pct = v => (v === null ? null : Math.round(v * 100));
  const yesSoloPct = pct(rate(done.filter(r => r.answer === 'yes')));
  const byDifficulty = DIFFS.map(d => {
    const rows = done.filter(r => diffOf(r.difficulty) === d);
    return rows.length ? { difficulty: d, total: rows.length, yesSoloPct: pct(rate(rows.filter(r => r.answer === 'yes'))), verdict: verdict(rows) } : null;
  }).filter(Boolean);
  return {
    total: done.length,
    yesSoloPct,
    headline: yesSoloPct === null
      ? 'You haven\'t said "Yes" yet — try trusting yourself on an Easy one.'
      : `When you say Yes, you solve it alone ${yesSoloPct}% of the time`,
    verdict: verdict(done),
    byDifficulty
  };
}

// The problem was solved: fill in solo for this problem's open answer
export function resolveConfidence(log = [], slug, score) {
  let changed = false;
  const out = (log || []).map(e => {
    if (e?.slug !== slug || typeof e.solo === 'boolean') return e;
    changed = true;
    return { ...e, solo: score === 100 };
  });
  return { log: out, changed };
}


// ─────────────────────────────────────────────
// 2. TILT DETECTOR (plan 4.3)
//    3 failed submissions within 10 minutes, or 25 / 40 / 60 minutes with
//    no progress (no code change, no hint, no solve) on Easy / Medium / Hard.
// ─────────────────────────────────────────────
export const TILT_FAILS = 3;
export const TILT_FAIL_WINDOW_MS = 10 * 60 * 1000;
export const TILT_IDLE_MIN = { easy: 25, medium: 40, hard: 60, unknown: 40 };

// t: { failures: [timestamps], openedAt, lastProgressAt, difficulty, shown, solved }
// → 'failures' | 'stuck' | null
export function tiltReason(t, now = Date.now()) {
  if (!t || t.shown || t.solved) return null;
  const recent = (t.failures || []).filter(at => now - at <= TILT_FAIL_WINDOW_MS);
  if (recent.length >= TILT_FAILS) return 'failures';
  const since = Math.max(t.openedAt || 0, t.lastProgressAt || 0);
  if (since && now - since >= TILT_IDLE_MIN[diffOf(t.difficulty)] * 60 * 1000) return 'stuck';
  return null;
}

const DIFF_RANK = { easy: 0, medium: 1, hard: 2, unknown: 3 };

// An easier problem on the same pattern: from your own history first, then
// the company list's problems. history: stats.problems ({ slug: { pattern, difficulty, title, ... } })
export function easierProblem({ slug, pattern, difficulty }, history = {}, companySlugs = []) {
  const chip = chipsIn(pattern)[0] || normalizePattern(pattern);
  const rank = DIFF_RANK[diffOf(difficulty)];
  const candidates = Object.entries(history || {})
    .filter(([s, p]) => s !== slug && p && DIFF_RANK[diffOf(p.difficulty)] < rank &&
                        chip && chipsIn(p.pattern || '').includes(chip))
    .sort(([, a], [, b]) => (b.solvedAt || 0) - (a.solvedAt || 0));
  if (candidates.length) {
    const [s, p] = candidates[0];
    return { slug: s, title: p.title || titleFromSlug(s), from: 'history' };
  }
  const other = (companySlugs || []).find(s => s && s !== slug && !history?.[s]);
  return other ? { slug: other, title: titleFromSlug(other), from: 'companies' } : null;
}

export const titleFromSlug = slug => String(slug || '').split('-').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');


// ─────────────────────────────────────────────
// 3. DÉJÀ VU (plan 4.5)
//    Same pattern = 3 points, each shared topic tag = 1. The best match with
//    3+ points that wasn't solved in the last 2 days.
// ─────────────────────────────────────────────
const LEVEL_WORDS = { 1: 'no hints', 2: 'Hint 2', 3: 'Hint 3', 4: 'Hint 4', solution: 'the solution' };

export function dejaVuScore(current, past) {
  let score = 0;
  const a = new Set(chipsIn(current.pattern || ''));
  const b = chipsIn(past.pattern || '');
  if (b.some(c => a.has(c))) score += 3;
  const tags = new Set((current.topicTags || []).map(t => String(t).toLowerCase()));
  for (const t of past.topicTags || []) if (tags.has(String(t).toLowerCase())) score++;
  return score;
}

// history: stats.problems; today: 'YYYY-MM-DD' → null or
// { slug, title, number, score, level, ago, message }
export function findDejaVu(current, history = {}, today = localDate()) {
  let best = null;
  for (const [slug, p] of Object.entries(history || {})) {
    if (!p || slug === current.slug || p.solved === false || !p.solvedDate) continue;
    if (daysBetween(p.solvedDate, today) < 2) continue;
    const score = dejaVuScore(current, p);
    if (score < 3) continue;
    if (!best || score > best.score || (score === best.score && p.solvedDate > best.p.solvedDate)) best = { slug, p, score };
  }
  if (!best) return null;
  const { slug, p, score } = best;
  const title = p.title || titleFromSlug(slug);
  const ago = agoText(daysBetween(p.solvedDate, today));
  const how = LEVEL_WORDS[p.level] || 'no hints';
  const name = p.number ? `#${p.number} ${title}` : title;
  return {
    slug, title, number: p.number || '', score, level: p.level, ago,
    message: `This looks like ${name}, which you solved ${ago} with ${how}`
  };
}

function agoText(days) {
  if (days < 7) return `${days} days ago`;
  if (days < 30) { const w = Math.round(days / 7); return `${w} week${w === 1 ? '' : 's'} ago`; }
  if (days < 365) { const m = Math.round(days / 30); return `${m} month${m === 1 ? '' : 's'} ago`; }
  const y = Math.round(days / 365);
  return `${y} year${y === 1 ? '' : 's'} ago`;
}


// ─────────────────────────────────────────────
// 4. STREAKS (plan 4.6) — local calendar days with a solve or a revision
// ─────────────────────────────────────────────
export function streaks(days = [], today = localDate()) {
  const set = [...new Set((days || []).filter(d => /^\d{4}-\d{2}-\d{2}$/.test(d)))].sort();
  let best = 0, run = 0, prev = null;
  for (const d of set) {
    run = prev && daysBetween(prev, d) === 1 ? run + 1 : 1;
    best = Math.max(best, run);
    prev = d;
  }
  // Current: ends today, or yesterday (today isn't over yet)
  let current = 0;
  const last = set.at(-1);
  if (last && daysBetween(last, today) <= 1 && daysBetween(last, today) >= 0) {
    current = 1;
    for (let i = set.length - 1; i > 0 && daysBetween(set[i - 1], set[i]) === 1; i--) current++;
  }
  return { current, best };
}

// Every day with a solve or a revision, from what's already stored
export function activityDays({ stats = {}, revisionQueue = {}, activityLog = [] } = {}) {
  const days = [...(activityLog || [])];
  for (const p of Object.values(stats.problems || {})) if (p?.solvedDate) days.push(p.solvedDate);
  for (const item of Object.values(revisionQueue || {})) {
    for (const h of item?.history || []) if (h?.date && h.via !== 'done') days.push(h.date);
  }
  return [...new Set(days)].sort();
}


// ─────────────────────────────────────────────
// 5. CSV EXPORT (plan 4.6)
// ─────────────────────────────────────────────
const CSV_COLUMNS = ['section', 'slug', 'title', 'difficulty', 'score', 'level', 'solved', 'date', 'detail'];

export function csvCell(v) {
  const s = v === null || v === undefined ? '' : String(v);
  // Quote when needed; a leading = + - @ is neutralised so spreadsheets don't run it as a formula
  const safe = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
  return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

export function buildCsv({ stats = {}, revisionQueue = {}, interviewHistory = [] } = {}) {
  const rows = [CSV_COLUMNS];
  for (const [slug, p] of Object.entries(stats.problems || {})) {
    rows.push(['problem', slug, p.title || titleFromSlug(slug), p.difficulty || '', p.score ?? '', p.level ?? '',
               p.solved === false ? 'no' : 'yes', p.solvedDate || '', p.pattern || '']);
  }
  for (const [slug, item] of Object.entries(revisionQueue || {})) {
    const history = item?.history || [];
    if (!history.length) {
      rows.push(['revision', slug, item?.title || titleFromSlug(slug), item?.difficulty || '', '', `step ${item?.step ?? ''}`, '', item?.nextDue || '', item?.mastered ? 'mastered' : 'queued']);
    }
    for (const h of history) {
      rows.push(['revision', slug, item?.title || titleFromSlug(slug), item?.difficulty || '', h.score ?? '', `step ${item?.step ?? ''}`, '',
                 h.date || '', [h.via, h.signal, h.interval ? `next in ${h.interval} days` : ''].filter(Boolean).join(' · ')]);
    }
  }
  for (const iv of interviewHistory || []) {
    const when = typeof iv.date === 'number' ? localDate(new Date(iv.date)) : (iv.date || '');
    rows.push(['interview', iv.slug || '', iv.title || titleFromSlug(iv.slug), iv.difficulty || '', iv.scorecard?.signal || '',
               `${iv.hintsUsed ?? 0} hints`, '', when,
               [iv.durationSec ? `${Math.round(iv.durationSec / 60)} min` : '', iv.endReason || ''].filter(Boolean).join(' · ')]);
  }
  return rows.map(r => r.map(csvCell).join(',')).join('\r\n') + '\r\n';
}
