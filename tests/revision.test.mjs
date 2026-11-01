// Tests for shared/revision.js — run with: node --test tests/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  STEPS, localDate, addDays, daysBetween, outcomeForScore, outcomeForInterview, interviewHintScore,
  newQueueItem, applyReview, markMastered, lastScore, migrateQueue, planQueue, reviewsOn, isDueToday
} from '../shared/revision.js';

const TODAY = '2026-11-01';
const problem = slug => ({ title: slug, problemNumber: '1', difficulty: 'Easy', slug });
const item = (step, nextDue, extra = {}) => ({ ...newQueueItem(problem('x'), 40, TODAY), step, nextDue, ...extra });

// Review an item `days` after TODAY with a given score
const review = (it, score, day = TODAY) => applyReview(it, { score, outcome: outcomeForScore(score), today: day });


test('local dates: calendar days, month/year and DST boundaries', () => {
  assert.equal(addDays('2026-01-31', 1), '2026-02-01');
  assert.equal(addDays('2026-12-31', 1), '2027-01-01');
  assert.equal(addDays('2026-03-07', 60), '2026-05-06');
  assert.equal(daysBetween('2026-03-07', '2026-03-09'), 2);   // US DST starts 2026-03-08
  assert.equal(daysBetween('2026-11-01', '2026-10-30'), -2);
  assert.match(localDate(new Date(2026, 0, 5, 23, 59)), /^2026-01-05$/);   // late evening stays the same day
});

test('score → outcome: SOLO up, SHARP/GOOD repeat, GUIDE/READ reset', () => {
  assert.equal(outcomeForScore(100), 'up');
  assert.equal(outcomeForScore(80), 'repeat');
  assert.equal(outcomeForScore(60), 'repeat');
  assert.equal(outcomeForScore(40), 'reset');
  assert.equal(outcomeForScore(20), 'reset');
});

test('new item: step 1 (1 day), due tomorrow', () => {
  const it = newQueueItem(problem('two-sum'), 40, TODAY);
  assert.equal(it.step, 0);
  assert.equal(it.nextDue, '2026-11-02');
  assert.deepEqual(it.history, []);
  assert.equal(it.mastered, false);
});

test('moving up a step: 1 → 3 → 7 → 21 → 60 days', () => {
  let it = item(0, TODAY);
  const expectNext = [3, 7, 21, 60];
  let day = TODAY;
  for (const days of expectNext) {
    it = review(it, 100, day);
    assert.equal(STEPS[it.step], days);
    assert.equal(it.nextDue, addDays(day, days));
    assert.deepEqual(it.history.at(-1), { date: day, score: 100, via: 'solve', interval: days });
    day = it.nextDue;
  }
  assert.equal(it.history.length, 4);
});

test('repeating: SHARP or GOOD keeps the step', () => {
  const it = review(item(2, TODAY), 80);
  assert.equal(it.step, 2);
  assert.equal(it.nextDue, addDays(TODAY, 7));
  assert.equal(review(item(2, TODAY), 60).step, 2);
});

test('resetting: GUIDE or READ goes back to 1 day', () => {
  for (const score of [40, 20]) {
    const it = review(item(3, TODAY), score);
    assert.equal(it.step, 0);
    assert.equal(it.nextDue, addDays(TODAY, 1));
    assert.equal(it.history.at(-1).interval, 1);
  }
});

test('mastering: SOLO at the 60-day step → Mastered, leaves the active queue', () => {
  const it = review(item(4, TODAY), 100);
  assert.equal(it.mastered, true);
  assert.equal(it.masteredOn, TODAY);
  assert.equal(it.nextDue, null);
  assert.equal(it.history.at(-1).interval, null);
  const plan = planQueue({ x: it }, { today: TODAY });
  assert.equal(plan.dueToday.length, 0);
  assert.equal(plan.upcoming.length, 0);
  assert.equal(plan.mastered.length, 1);
});

test('not mastered: GOOD at the 60-day step repeats 60 days', () => {
  const it = review(item(4, TODAY), 60);
  assert.equal(it.mastered, false);
  assert.equal(it.nextDue, addDays(TODAY, 60));
});

test('"✓ Done" marks Mastered and does not use up a daily slot', () => {
  const it = markMastered(item(1, TODAY), TODAY);
  assert.equal(it.mastered, true);
  assert.equal(it.history.at(-1).via, 'done');
  assert.equal(reviewsOn({ x: it }, TODAY), 0);
});

test('lastScore: last review, else the score it joined with', () => {
  const it = item(0, TODAY);
  assert.equal(lastScore(it), 40);
  assert.equal(lastScore(review(it, 80)), 80);
  assert.equal(lastScore(markMastered(review(it, 100), TODAY)), 100);   // "done" has no score
});

test('daily limit: only N due today, the rest roll over day by day', () => {
  const queue = {};
  for (let i = 0; i < 7; i++) queue[`p${i}`] = item(0, addDays(TODAY, -(7 - i)), { addedAt: i });   // p0 most overdue
  const plan = planQueue(queue, { limit: 3, today: TODAY });
  assert.deepEqual(plan.dueToday.map(e => e.slug), ['p0', 'p1', 'p2']);
  assert.deepEqual(plan.dueToday.map(e => e.overdueDays), [7, 6, 5]);
  assert.deepEqual(plan.upcoming.map(e => [e.slug, e.date]), [
    ['p3', '2026-11-02'], ['p4', '2026-11-02'], ['p5', '2026-11-02'], ['p6', '2026-11-03']
  ]);
  assert.equal(isDueToday(queue, 'p2', { limit: 3, today: TODAY }), true);
  assert.equal(isDueToday(queue, 'p3', { limit: 3, today: TODAY }), false);
});

test('daily limit: rolled-over items share later days with items due then', () => {
  const queue = {
    a: item(0, '2026-10-30', { addedAt: 1 }), b: item(0, '2026-10-31', { addedAt: 2 }),
    c: item(0, '2026-11-02', { addedAt: 3 }), d: item(0, '2026-11-02', { addedAt: 4 })
  };
  const plan = planQueue(queue, { limit: 1, today: TODAY });
  assert.deepEqual(plan.dueToday.map(e => e.slug), ['a']);
  // b (overdue) goes first tomorrow, then c and d one per day
  assert.deepEqual(plan.upcoming.map(e => [e.slug, e.date]), [['b', '2026-11-02'], ['c', '2026-11-03'], ['d', '2026-11-04']]);
});

test('daily limit: reviews done today use up today\'s slots', () => {
  const done = review(item(0, TODAY), 100);           // reviewed today → next in 3 days
  const queue = { done, b: item(0, TODAY, { addedAt: 1 }), c: item(0, TODAY, { addedAt: 2 }) };
  const plan = planQueue(queue, { limit: 2, today: TODAY });
  assert.deepEqual(plan.dueToday.map(e => e.slug), ['b']);
  assert.deepEqual(plan.upcoming.map(e => [e.slug, e.date]), [['c', '2026-11-02'], ['done', '2026-11-04']]);
});

test('upcoming items keep their own dates when there is room', () => {
  const queue = { a: item(1, '2026-11-04'), b: item(2, '2026-11-09') };
  const plan = planQueue(queue, { limit: 3, today: TODAY });
  assert.deepEqual(plan.upcoming.map(e => e.date), ['2026-11-04', '2026-11-09']);
});

test('migration: old items start at step 1, spread oldest first by the limit', () => {
  const old = {};
  ['e', 'a', 'c', 'b', 'd'].forEach(slug => {           // addedAt order: a b c d e
    old[slug] = { title: slug, difficulty: 'Medium', level: 'solution', addedAt: slug.charCodeAt(0) };
  });
  old.new = item(2, '2026-11-05');                        // already migrated → untouched
  const { queue, changed } = migrateQueue(old, 2, TODAY);
  assert.equal(changed, true);
  assert.deepEqual(['a', 'b', 'c', 'd', 'e'].map(s => queue[s].nextDue),
    ['2026-11-02', '2026-11-02', '2026-11-03', '2026-11-03', '2026-11-04']);
  for (const s of 'abcde') {
    assert.equal(queue[s].step, 0);
    assert.equal(queue[s].score, 20);                     // level 'solution' = READ
    assert.deepEqual(queue[s].history, []);
  }
  assert.deepEqual(queue.new, old.new);
  assert.equal(planQueue(queue, { limit: 2, today: TODAY }).dueToday.length, 0);   // none due today
  assert.equal(migrateQueue(queue, 2, TODAY).changed, false);                      // runs once
});

test('interview: hints used count like hint levels', () => {
  assert.deepEqual([0, 1, 2, 3, 4, 7].map(interviewHintScore), [100, 80, 60, 40, 20, 20]);
});

test('interview: Strong Hire up, Hire repeat, No Hire reset — capped by hints used', () => {
  assert.equal(outcomeForInterview('Strong Hire', 0), 'up');
  assert.equal(outcomeForInterview('Hire', 0), 'repeat');
  assert.equal(outcomeForInterview('No Hire', 0), 'reset');
  assert.equal(outcomeForInterview('Strong Hire', 1), 'repeat');   // 1 hint = SHARP
  assert.equal(outcomeForInterview('Strong Hire', 3), 'reset');    // 3 hints = GUIDE
  assert.equal(outcomeForInterview('Hire', 2), 'repeat');
  assert.equal(outcomeForInterview('Hire', 4), 'reset');
});

test('interview path: Strong Hire without hints at the 60-day step masters it', () => {
  const at60 = item(4, TODAY);
  const it = applyReview(at60, { score: interviewHintScore(0), outcome: outcomeForInterview('Strong Hire', 0),
                                 via: 'interview', signal: 'Strong Hire', today: TODAY });
  assert.equal(it.mastered, true);
  assert.equal(it.history.at(-1).signal, 'Strong Hire');
  const notYet = applyReview(at60, { score: interviewHintScore(1), outcome: outcomeForInterview('Strong Hire', 1),
                                     via: 'interview', signal: 'Strong Hire', today: TODAY });
  assert.equal(notYet.mastered, false);
  assert.equal(notYet.step, 4);
});

test('join score: Hint 4 then the solution on the first attempt → READ', async () => {
  const { lowerJoinScore, syncJoinScores, SCORE_NAMES } = await import('../shared/revision.js');
  const joined = newQueueItem(problem('two-sum'), 40, TODAY);            // Hint 4 → GUIDE
  const read = lowerJoinScore(joined, 20);                               // solution opened
  assert.equal(SCORE_NAMES[lastScore(read)], 'READ');
  assert.equal(read.step, joined.step);
  assert.equal(read.nextDue, joined.nextDue);                            // schedule unchanged
  assert.equal(lowerJoinScore(read, 40), read);                          // never goes back up
  assert.equal(lowerJoinScore(read, undefined), read);
  // Persists: survives a storage round trip (JSON, like chrome.storage)
  assert.equal(lastScore(JSON.parse(JSON.stringify(read))), 20);

  // Reviewed or mastered items keep their history and joining score
  const reviewed = applyReview(joined, { score: 80, outcome: 'repeat', today: '2026-11-02' });
  assert.equal(lowerJoinScore(reviewed, 20), reviewed);
  const mastered = markMastered(joined, TODAY);
  assert.equal(lowerJoinScore(mastered, 20), mastered);

  // Repair of items saved before the fix; others untouched
  const queue = { a: joined, b: reviewed, c: mastered };
  const { queue: fixed, changed } = syncJoinScores(queue, { a: 20, b: 20, c: 20 });
  assert.equal(changed, true);
  assert.equal(fixed.a.score, 20);
  assert.equal(fixed.b, reviewed);
  assert.equal(fixed.c, mastered);
  assert.equal(syncJoinScores(fixed, { a: 20 }).changed, false);
});
