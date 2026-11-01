// shared/revision.js — Spaced repetition for the Revision Queue
// Pure logic, no DOM and no storage: used by the side panel (queue, reviews)
// and the service worker (icon badge). All dates are LOCAL calendar dates
// ("YYYY-MM-DD"), so a problem is due from local midnight, not at the exact
// time of day it was last reviewed.
//
// Queue item (revisionQueue[slug]):
//   { title, problemNumber, difficulty, addedAt, score,   ← score when it joined
//     step, nextDue, mastered, masteredOn,
//     history: [{ date, score, interval, via, signal? }] }
//   step = index into STEPS: the wait (in days) before the next review

export const STEPS = [1, 3, 7, 21, 60];
export const DEFAULT_DAILY_LIMIT = 3;
export const MAX_DAILY_LIMIT = 20;
export const QUEUE_SCORE_MAX = 60;     // solved with GOOD (60) or lower → queue

export const SCORE_NAMES = { 100: 'SOLO', 80: 'SHARP', 60: 'GOOD', 40: 'GUIDE', 20: 'READ' };


// ─────────────────────────────────────────────
// 1. LOCAL DATES
// ─────────────────────────────────────────────
const pad = n => String(n).padStart(2, '0');

export function localDate(d = new Date()) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

// "YYYY-MM-DD" → local midnight of that day
export function parseLocalDate(s) {
  const [y, m, d] = String(s).split('-').map(Number);
  return new Date(y, m - 1, d);
}

export function addDays(dateStr, days) {
  const d = parseLocalDate(dateStr);
  d.setDate(d.getDate() + days);    // calendar days — DST-safe
  return localDate(d);
}

// Whole calendar days from a to b (b later → positive)
export function daysBetween(a, b) {
  return Math.round((parseLocalDate(b) - parseLocalDate(a)) / 86400000);
}

export function clampLimit(n) {
  const v = Math.floor(Number(n));
  return v >= 1 ? Math.min(MAX_DAILY_LIMIT, v) : DEFAULT_DAILY_LIMIT;
}


// ─────────────────────────────────────────────
// 2. REVIEW OUTCOMES
//    'up' = next step · 'repeat' = same step · 'reset' = back to 1 day
// ─────────────────────────────────────────────
const SEVERITY = { reset: 0, repeat: 1, up: 2 };

export function outcomeForScore(score) {
  if (score >= 100) return 'up';
  if (score >= 60) return 'repeat';
  return 'reset';
}

// Hints the interviewer gave count like the hint ladder: none = SOLO,
// 1 = SHARP, 2 = GOOD, 3 = GUIDE, 4 or more = READ
export function interviewHintScore(hintsUsed) {
  return [100, 80, 60, 40][Math.max(0, Math.floor(hintsUsed) || 0)] ?? 20;
}

// Strong Hire → up, Hire → repeat, No Hire → reset — but never better than
// the hints used allow (Strong Hire after 3 hints is still a reset)
export function outcomeForInterview(signal, hintsUsed) {
  const bySignal = signal === 'Strong Hire' ? 'up' : signal === 'Hire' ? 'repeat' : 'reset';
  const byHints = outcomeForScore(interviewHintScore(hintsUsed));
  return SEVERITY[bySignal] <= SEVERITY[byHints] ? bySignal : byHints;
}


// ─────────────────────────────────────────────
// 3. QUEUE ITEMS
// ─────────────────────────────────────────────
export function newQueueItem(problem, score, today = localDate()) {
  return {
    title: problem.title, problemNumber: problem.problemNumber, difficulty: problem.difficulty,
    addedAt: Date.now(), score,
    step: 0, nextDue: addDays(today, STEPS[0]),
    mastered: false, history: []
  };
}

// Before its first review, an item's score follows that first attempt down:
// opening the solution after Hint 4 makes it READ, not GUIDE. Once reviews
// exist (or it's mastered) the score it joined with is history — unchanged.
export function lowerJoinScore(item, score) {
  if (!item || item.mastered || (item.history || []).length || typeof score !== 'number') return item;
  if (typeof item.score === 'number' && score >= item.score) return item;
  return { ...item, score };
}

// The same for the whole queue, from each problem's saved first-attempt
// score (scores: { [slug]: score }) — repairs items saved before this rule
export function syncJoinScores(queue = {}, scores = {}) {
  let changed = false;
  const next = { ...queue };
  for (const [slug, item] of Object.entries(queue)) {
    const lowered = lowerJoinScore(item, scores[slug]);
    if (lowered !== item) { next[slug] = lowered; changed = true; }
  }
  return { queue: changed ? next : queue, changed };
}

// The item after one review. Moving up from the last step (60 days) = Mastered.
export function applyReview(item, { score, outcome, via = 'solve', signal, today = localDate() }) {
  const last = STEPS.length - 1;
  const entry = { date: today, score, via, ...(signal ? { signal } : {}) };
  if (outcome === 'up' && item.step >= last) {
    return { ...item, mastered: true, masteredOn: today, nextDue: null,
             history: [...(item.history || []), { ...entry, interval: null }] };
  }
  const step = outcome === 'up' ? item.step + 1 : outcome === 'repeat' ? item.step : 0;
  return { ...item, step, nextDue: addDays(today, STEPS[step]),
           history: [...(item.history || []), { ...entry, interval: STEPS[step] }] };
}

// "✓ Done" — the user says they've got it
export function markMastered(item, today = localDate()) {
  return { ...item, mastered: true, masteredOn: today, nextDue: null,
           history: [...(item.history || []), { date: today, score: null, interval: null, via: 'done' }] };
}

// The last review's score, or the score it joined the queue with
export function lastScore(item) {
  const reviews = (item.history || []).filter(h => typeof h.score === 'number');
  return reviews.length ? reviews.at(-1).score : item.score;
}


// ─────────────────────────────────────────────
// 4. MIGRATION — items from the old queue have no step yet
//    They start at step 1, spread oldest first across the coming days by
//    the daily limit (never all due today). Items that already have a step
//    are left alone, so running this again changes nothing.
// ─────────────────────────────────────────────
const OLD_LEVEL_SCORES = { 1: 100, 2: 80, 3: 60, 4: 40, solution: 20 };

export function migrateQueue(queue = {}, limit = DEFAULT_DAILY_LIMIT, today = localDate()) {
  const old = Object.entries(queue)
    .filter(([, item]) => typeof item?.step !== 'number')
    .sort(([, a], [, b]) => (a.addedAt || 0) - (b.addedAt || 0));
  if (!old.length) return { queue, changed: false };

  const per = clampLimit(limit);
  const next = { ...queue };
  old.forEach(([slug, item], i) => {
    next[slug] = {
      ...item,
      score: item.score ?? OLD_LEVEL_SCORES[item.level] ?? 40,
      step: 0, nextDue: addDays(today, 1 + Math.floor(i / per)),
      mastered: false, history: []
    };
  });
  return { queue: next, changed: true };
}


// ─────────────────────────────────────────────
// 5. TODAY'S PLAN — Due today / Upcoming / Mastered
//    Stored due dates never change; the daily limit is applied here, so
//    changing it re-spreads the backlog at once. Reviews already done today
//    use up today's slots. Items beyond a day's limit roll to the next day.
// ─────────────────────────────────────────────
const byDueThenAdded = (a, b) =>
  a.item.nextDue.localeCompare(b.item.nextDue) || (a.item.addedAt || 0) - (b.item.addedAt || 0);

export function reviewsOn(queue, day) {
  return Object.values(queue).reduce((n, item) =>
    n + (item.history || []).filter(h => h.date === day && h.via !== 'done').length, 0);
}

export function planQueue(queue = {}, { limit = DEFAULT_DAILY_LIMIT, today = localDate() } = {}) {
  const per = clampLimit(limit);
  const all = Object.entries(queue).map(([slug, item]) => ({ slug, item }));
  const mastered = all.filter(e => e.item.mastered)
    .sort((a, b) => String(b.item.masteredOn || '').localeCompare(String(a.item.masteredOn || '')));
  const active = all.filter(e => !e.item.mastered && e.item.nextDue).sort(byDueThenAdded);

  const dueToday = [], upcoming = [];
  let backlog = active.filter(e => e.item.nextDue <= today);
  let rest = active.filter(e => e.item.nextDue > today);
  let day = today;
  let slots = Math.max(0, per - reviewsOn(queue, today));

  while (backlog.length || rest.length) {
    // Jump straight to the next date that has work, when nothing is waiting
    if (!backlog.length && rest[0].item.nextDue > day) { day = rest[0].item.nextDue; slots = per; }
    while (rest.length && rest[0].item.nextDue <= day) backlog.push(rest.shift());
    backlog.sort(byDueThenAdded);
    for (const e of backlog.splice(0, slots)) {
      if (day === today) dueToday.push({ ...e, overdueDays: daysBetween(e.item.nextDue, today) });
      else upcoming.push({ ...e, date: day });
    }
    day = addDays(day, 1);
    slots = per;
  }
  return { dueToday, upcoming, mastered };
}

export const dueTodayCount = (queue, opts) => planQueue(queue, opts).dueToday.length;
export const isDueToday = (queue, slug, opts) => planQueue(queue, opts).dueToday.some(e => e.slug === slug);
