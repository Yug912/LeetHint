// shared/insights.js — the small local features: confidence calibration,
// the tilt detector, déjà-vu links between problems, streaks and CSV export.
// Pure functions only (no DOM, no chrome.*); everything they read is local data.

import { canonicalPattern } from './patterns.js';
import { daysBetween, localDate } from './revision.js';


// ─────────────────────────────────────────────
// 1. CONFIDENCE — "Will you solve this without hints?" vs what happened
//    confidenceLog: [{ slug, answer: 'yes'|'maybe'|'no', difficulty, date, solo: true|false|null }]
// ─────────────────────────────────────────────
export const CONFIDENCE_MIN = 10;
const EXPECTED = { yes: 0.8, maybe: 0.5, no: 0.2 };   // what each answer predicts

function judge(entries) {
  const done = entries.filter(e => typeof e.solo === 'boolean' && EXPECTED[e.answer] !== undefined);
  if (!done.length) return null;
  const predicted = done.reduce((s, e) => s + EXPECTED[e.answer], 0) / done.length;
  const actual = done.filter(e => e.solo).length / done.length;
  const verdict = predicted - actual > 0.15 ? 'overconfident' : actual - predicted > 0.15 ? 'underconfident' : 'well-calibrated';
  return { count: done.length, predicted, actual, verdict };
}

// → null until CONFIDENCE_MIN answered entries, else
//   { count, yesSoloPct, yesCount, verdict, byDifficulty: { easy: {...}, ... } }
export function calibration(log = []) {
  const done = log.filter(e => typeof e.solo === 'boolean');
  if (done.length < CONFIDENCE_MIN) return null;
  const yes = done.filter(e => e.answer === 'yes');
  const byDifficulty = {};
  for (const d of ['easy', 'medium', 'hard']) {
    const j = judge(done.filter(e => String(e.difficulty || '').toLowerCase() === d));
    if (j) byDifficulty[d] = j;
  }
  return {
    count: done.length,
    yesCount: yes.length,
    yesSoloPct: yes.length ? Math.round(100 * yes.filter(e => e.solo).length / yes.length) : null,
    verdict: judge(done).verdict,
    byDifficulty
  };
}


// The line shown when a problem is solved: your guess vs what happened.
// → { right: bool, text } for an answer of 'yes'|'maybe'|'no', or null
const OUTCOME = {
  yes:   { true:  [true,  'You said Yes and solved it without hints. Spot on!'],
           false: [false, 'You said Yes but needed hints. A bit overconfident this time.'] },
  maybe: { true:  [true,  'You said Maybe and solved it without hints. Trust yourself more!'],
           false: [true,  'You said Maybe and needed hints. Fair call.'] },
  no:    { true:  [false, 'You said No but solved it without hints. Better than you thought!'],
           false: [true,  'You said No and needed hints. Honest read.'] }
};
export function confidenceOutcome(answer, solo) {
  const o = OUTCOME[answer]?.[solo === true];
  return o ? { right: o[0], text: o[1] } : null;
}

// "3/10 more until your confidence report" or the overall verdict once it exists
export function confidenceProgress(log = []) {
  const cal = calibration(log);
  if (cal) return `Overall you are ${cal.verdict}. See Stats for details.`;
  const done = log.filter(e => typeof e.solo === 'boolean').length;
  return `${done}/${CONFIDENCE_MIN} solved: your confidence report unlocks in Stats at ${CONFIDENCE_MIN}.`;
}


// ─────────────────────────────────────────────
// 2. TILT — gentle help when a problem is going badly
//    3 failed submissions within 10 minutes, or 25 / 40 / 60 minutes (Easy /
//    Medium / Hard) without a meaningful code change. At most once per problem.
// ─────────────────────────────────────────────
export const STUCK_MINUTES = { easy: 25, medium: 40, hard: 60 };

// t: { failures: [ms], openedAt, lastChangeAt, difficulty, solved, shown }
// → null, or { reason: 'failures' | 'stuck', minutes }
export function tiltCheck(t, now = Date.now()) {
  if (!t || t.shown || t.solved) return null;
  const recent = (t.failures || []).filter(at => now - at <= 10 * 60e3);
  if (recent.length >= 3) return { reason: 'failures', minutes: Math.round((now - recent[0]) / 60e3) };
  const limit = STUCK_MINUTES[String(t.difficulty || '').toLowerCase()] || STUCK_MINUTES.medium;
  const since = now - (t.lastChangeAt || t.openedAt || now);
  if (t.openedAt && since >= limit * 60e3) return { reason: 'stuck', minutes: Math.round(since / 60e3) };
  return null;
}

// An easier problem on the same pattern: one you solved before (from Stats),
// else one from the company list you haven't done. → { slug, title } or null
const DIFF_RANK = { easy: 0, medium: 1, hard: 2 };
export function easierProblem({ slug, pattern, difficulty }, history = {}) {
  const want = canonicalPattern(pattern);
  const rank = DIFF_RANK[String(difficulty || '').toLowerCase()] ?? 1;
  if (!want || rank === 0) return null;
  const candidates = Object.entries(history)
    .filter(([s, p]) => s !== slug && canonicalPattern(p.pattern) === want && (DIFF_RANK[p.difficulty] ?? 1) < rank)
    .sort((a, b) => (DIFF_RANK[a[1].difficulty] ?? 1) - (DIFF_RANK[b[1].difficulty] ?? 1));
  return candidates.length ? { slug: candidates[0][0], title: candidates[0][1].title || candidates[0][0] } : null;
}


// ─────────────────────────────────────────────
// 3. DÉJÀ VU — "This looks like #146 LRU Cache, which you solved 3 weeks ago"
//    Score every solved problem: same pattern = 3 points, each shared topic
//    tag = 1. Best at 3+ points, not solved in the last 2 days.
// ─────────────────────────────────────────────

// history: stats.problems — { [slug]: { title, problemNumber, pattern, topicTags, solvedOn, level, solved } }
export function dejaVu(current, history = {}, today = localDate()) {
  const want = canonicalPattern(current.pattern);
  const tags = new Set((current.topicTags || []).map(t => t.toLowerCase()));
  let best = null;
  for (const [slug, p] of Object.entries(history)) {
    if (slug === current.slug || p.solved === false || !p.solvedOn) continue;
    const ago = daysBetween(p.solvedOn, today);
    if (!(ago >= 2)) continue;
    let score = want && canonicalPattern(p.pattern) === want ? 3 : 0;
    for (const t of p.topicTags || []) if (tags.has(t.toLowerCase())) score++;
    if (score >= 3 && (!best || score > best.score || (score === best.score && ago < best.ago))) best = { slug, score, ago, problem: p };
  }
  if (!best) return null;
  const p = best.problem;
  const name = `${p.problemNumber ? '#' + p.problemNumber + ' ' : ''}${p.title || best.slug}`;
  return { slug: best.slug, score: best.score, message: `This looks like ${name}, which you solved ${agoText(best.ago)} ${howText(p.level)}.` };
}

export function agoText(days) {
  if (days <= 0) return 'today';
  if (days === 1) return 'yesterday';
  if (days < 14) return `${days} days ago`;
  if (days < 60) return `${Math.round(days / 7)} weeks ago`;
  const months = Math.round(days / 30);
  return months < 24 ? `${months} months ago` : `${Math.round(days / 365)} years ago`;
}

const howText = level => level === 1 || level === '1' ? 'without hints'
  : level === 'solution' ? 'after reading the solution' : level ? `with Hint ${level}` : '';


// ─────────────────────────────────────────────
// 4. STREAKS — local calendar days with a solve or a revision
// ─────────────────────────────────────────────

// days: 'YYYY-MM-DD' strings (any order, duplicates fine) → { current, best }.
// Today not done yet keeps yesterday's streak alive.
export function streaks(days = [], today = localDate()) {
  const sorted = [...new Set(days.filter(d => /^\d{4}-\d\d-\d\d$/.test(d)))].sort();
  const runEndingOn = new Map();   // day → streak length ending that day
  let best = 0, run = 0, prev = null;
  for (const d of sorted) {
    run = prev && daysBetween(prev, d) === 1 ? run + 1 : 1;
    runEndingOn.set(d, run);
    best = Math.max(best, run);
    prev = d;
  }
  const yesterday = sorted.find(d => daysBetween(d, today) === 1);
  return { current: runEndingOn.get(today) || (yesterday && runEndingOn.get(yesterday)) || 0, best };
}

// Every day with activity, from the stats, the revision queue and the log
export function activityDays({ stats = {}, revisionQueue = {}, activityLog = [] } = {}) {
  const days = [...activityLog];
  for (const p of Object.values(stats.problems || {})) if (p.solvedOn) days.push(p.solvedOn);
  for (const item of Object.values(revisionQueue)) {
    for (const h of item.history || []) if (h.date && h.via !== 'done') days.push(h.date);
  }
  return days;
}


// ─────────────────────────────────────────────
// 5. CSV EXPORT — stats, revision queue and interview history in one file
// ─────────────────────────────────────────────
export function csvCell(v) {
  const s = v === null || v === undefined ? '' : String(v);
  return /[",\n\r]/.test(s) || /^[=+\-@]/.test(s) ? `"${(/^[=+\-@]/.test(s) ? "'" : '') + s.replace(/"/g, '""')}"` : s;
}

export const CSV_COLUMNS = ['type', 'slug', 'title', 'difficulty', 'date', 'score', 'detail'];

export function buildCsv({ stats = {}, revisionQueue = {}, interviewHistory = [] } = {}) {
  const rows = [];
  for (const [slug, p] of Object.entries(stats.problems || {})) {
    rows.push({ type: 'problem', slug, title: p.title || '', difficulty: p.difficulty || '', date: p.solvedOn || '',
                score: p.score, detail: [p.solved === false ? 'not solved' : 'solved', p.level != null && `level ${p.level}`, p.pattern].filter(Boolean).join('; ') });
  }
  for (const [slug, item] of Object.entries(revisionQueue)) {
    rows.push({ type: 'revision', slug, title: item.title || '', difficulty: item.difficulty || '',
                date: item.addedAt ? localDate(new Date(item.addedAt)) : '', score: item.score ?? '', detail: item.mastered ? `mastered ${item.masteredOn || ''}` : `step ${item.step + 1}; next ${item.nextDue || ''}` });
    for (const h of item.history || []) {
      rows.push({ type: 'review', slug, title: item.title || '', difficulty: item.difficulty || '', date: h.date,
                  score: h.score ?? '', detail: [h.via, h.signal].filter(Boolean).join('; ') });
    }
  }
  for (const iv of interviewHistory) {
    rows.push({ type: 'interview', slug: iv.slug, title: iv.title || '', difficulty: iv.difficulty || '',
                date: iv.date ? localDate(new Date(iv.date)) : '', score: iv.scorecard?.signal || '',
                detail: `${Math.round((iv.durationSec || 0) / 60)} min; ${iv.hintsUsed || 0} hints; reached ${iv.stageReached || ''}` });
  }
  return [CSV_COLUMNS.join(','), ...rows.map(r => CSV_COLUMNS.map(c => csvCell(r[c])).join(','))].join('\r\n') + '\r\n';
}
