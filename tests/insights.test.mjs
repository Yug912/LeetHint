// Confidence (B11), tilt (B12), déjà vu (B14), streaks + CSV (B15) — run with: node --test tests/*.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { calibration, confidenceOutcome, confidenceProgress, tiltCheck, easierProblem, dejaVu, agoText, streaks, activityDays, buildCsv, csvCell } from '../shared/insights.js';

test('confidence card: right numbers for a hand-made log', () => {
  const e = (answer, solo, difficulty = 'medium') => ({ slug: 's', answer, solo, difficulty, date: '2026-11-01' });
  const log = [e('yes', true), e('yes', false), e('yes', false), e('yes', false), e('yes', true),
               e('yes', false, 'easy'), e('yes', false, 'easy'), e('yes', true, 'easy'), e('yes', false, 'hard'), e('yes', false, 'hard'),
               e('maybe', null)];   // not finished — doesn't count
  const c = calibration(log);
  assert.equal(c.count, 10);
  assert.equal(c.yesSoloPct, 30);              // "When you say Yes, you solve it alone 30% of the time"
  assert.equal(c.verdict, 'overconfident');    // 80% predicted vs 30%
  assert.equal(c.byDifficulty.easy.count, 3);
  assert.equal(c.byDifficulty.hard.actual, 0);
  assert.equal(calibration(log.slice(0, 9)), null);   // fewer than 10 → no card yet
  const humble = Array.from({ length: 10 }, () => e('no', true));
  assert.equal(calibration(humble).verdict, 'underconfident');
  const calibrated = [...Array(8).fill(0).map(() => e('yes', true)), e('yes', false), e('no', false)];
  assert.equal(calibration(calibrated).verdict, 'well-calibrated');
});

test('tilt: 3 failures in 10 minutes, or stuck 25/40/60 minutes; once per problem', () => {
  const now = Date.UTC(2026, 10, 20, 12);
  const min = m => now - m * 60e3;
  assert.equal(tiltCheck({ failures: [min(9), min(5), min(1)], openedAt: min(12), lastChangeAt: min(1) }, now).reason, 'failures');
  assert.equal(tiltCheck({ failures: [min(15), min(5), min(1)], openedAt: min(20), lastChangeAt: min(1) }, now), null);
  assert.equal(tiltCheck({ failures: [], openedAt: min(30), lastChangeAt: min(26), difficulty: 'Easy' }, now).reason, 'stuck');
  assert.equal(tiltCheck({ failures: [], openedAt: min(30), lastChangeAt: min(26), difficulty: 'Medium' }, now), null);
  assert.equal(tiltCheck({ failures: [], openedAt: min(70), lastChangeAt: min(61), difficulty: 'Hard' }, now).minutes, 61);
  assert.equal(tiltCheck({ failures: [min(3), min(2), min(1)], openedAt: min(5), shown: true }, now), null);
  assert.equal(tiltCheck({ failures: [min(3), min(2), min(1)], openedAt: min(5), solved: true }, now), null);
});

test('an easier problem on the same pattern from your history', () => {
  const history = { 'two-sum': { title: 'Two Sum', pattern: 'Hash Map', difficulty: 'easy' },
                    'group-anagrams': { title: 'Group Anagrams', pattern: 'Hash Table', difficulty: 'medium' } };
  assert.deepEqual(easierProblem({ slug: 'x', pattern: 'hashing', difficulty: 'Hard' }, history), { slug: 'two-sum', title: 'Two Sum' });
  assert.equal(easierProblem({ slug: 'x', pattern: 'Hash Map', difficulty: 'Easy' }, history), null);
});

test('déjà vu picks the best match with 3+ points, not solved in the last 2 days', () => {
  const history = {
    'lru-cache': { title: 'LRU Cache', problemNumber: '146', pattern: 'Hash Map + Doubly Linked List', topicTags: ['Hash Table', 'Linked List', 'Design'], solvedOn: '2026-10-30', level: 3, solved: true },
    'two-sum':   { title: 'Two Sum', problemNumber: '1', pattern: 'Hash Map', topicTags: ['Array', 'Hash Table'], solvedOn: '2026-11-19', level: 1, solved: true },
    'design-x':  { title: 'Design X', problemNumber: '9', pattern: 'Simulation', topicTags: ['Design'], solvedOn: '2026-10-01', level: 1, solved: true }
  };
  const current = { slug: 'lfu-cache', pattern: 'Hash Map', topicTags: ['Hash Table', 'Linked List', 'Design'] };
  const d = dejaVu(current, history, '2026-11-20');
  assert.equal(d.slug, 'lru-cache');                         // 3 + 3 tags = 6; Two Sum was yesterday
  assert.equal(d.message, 'This looks like #146 LRU Cache, which you solved 3 weeks ago with Hint 3.');
  assert.equal(dejaVu({ slug: 'z', pattern: 'Trie', topicTags: ['Trie'] }, history, '2026-11-20'), null);
  assert.equal(agoText(1), 'yesterday');
  assert.equal(agoText(90), '3 months ago');
});

test('streaks across a month boundary', () => {
  const days = ['2026-10-29', '2026-10-30', '2026-10-31', '2026-11-01', '2026-11-02', '2026-11-05', '2026-11-05'];
  assert.deepEqual(streaks(days, '2026-11-02'), { current: 5, best: 5 });
  assert.deepEqual(streaks(days, '2026-11-03'), { current: 5, best: 5 });   // today not done yet
  assert.deepEqual(streaks(days, '2026-11-06'), { current: 1, best: 5 });
  assert.deepEqual(streaks(days, '2026-11-08'), { current: 0, best: 5 });
  assert.deepEqual(streaks(['2026-12-31', '2027-01-01'], '2027-01-01'), { current: 2, best: 2 });
  assert.deepEqual(streaks([], '2026-11-01'), { current: 0, best: 0 });
  const all = activityDays({ stats: { problems: { a: { solvedOn: '2026-11-01' } } },
                             revisionQueue: { b: { history: [{ date: '2026-11-02', via: 'solve' }, { date: '2026-11-03', via: 'done' }] } },
                             activityLog: ['2026-10-31'] });
  assert.deepEqual(all.sort(), ['2026-10-31', '2026-11-01', '2026-11-02']);
});

test('CSV: one header, escaped cells, every kind of row', () => {
  assert.equal(csvCell('a,b'), '"a,b"');
  assert.equal(csvCell('say "hi"'), '"say ""hi"""');
  assert.equal(csvCell('=SUM(A1)'), `"'=SUM(A1)"`);           // never a spreadsheet formula
  const csv = buildCsv({
    stats: { problems: { 'two-sum': { title: 'Two Sum, again', difficulty: 'easy', score: 80, level: 2, solved: true, solvedOn: '2026-11-01' } } },
    revisionQueue: { 'lru-cache': { title: 'LRU Cache', difficulty: 'Medium', addedAt: Date.UTC(2026, 10, 2, 12), score: 40, step: 1, nextDue: '2026-11-06', history: [{ date: '2026-11-03', score: 60, via: 'solve' }] } },
    interviewHistory: [{ slug: 'two-sum', title: 'Two Sum', difficulty: 'Easy', date: Date.UTC(2026, 10, 4, 12), durationSec: 1500, hintsUsed: 1, stageReached: 'feedback', scorecard: { signal: 'Hire' } }]
  });
  const lines = csv.trim().split('\r\n');
  assert.equal(lines[0], 'type,slug,title,difficulty,date,score,detail');
  assert.equal(lines.length, 5);
  assert.equal(lines[1], 'problem,two-sum,"Two Sum, again",easy,2026-11-01,80,solved; level 2');
  assert.match(lines[2], /^revision,lru-cache,LRU Cache,Medium,2026-11-02,40,step 2; next 2026-11-06$/);
  assert.match(lines[3], /^review,lru-cache,LRU Cache,Medium,2026-11-03,60,solve$/);
  assert.match(lines[4], /^interview,two-sum,Two Sum,Easy,2026-11-04,Hire,25 min; 1 hints; reached feedback$/);
  // a problem without a saved level: no "level undefined"
  assert.match(buildCsv({ stats: { problems: { x: { title: 'X', difficulty: 'Hard', score: 0, solved: false } } } }), /,not solved\r\n$/);
});

test('confidence result: your guess vs what happened, and progress to the report', () => {
  assert.deepEqual(confidenceOutcome('yes', true).right, true);
  assert.equal(confidenceOutcome('yes', false).right, false);
  assert.equal(confidenceOutcome('no', true).right, false);
  assert.equal(confidenceOutcome('maybe', false).right, true);
  assert.match(confidenceOutcome('no', true).text, /without hints/);
  assert.equal(confidenceOutcome('skip', true), null);
  assert.equal(confidenceOutcome(undefined, false), null);
  const e = (answer, solo) => ({ slug: 's', answer, solo, difficulty: 'easy', date: '2026-11-01' });
  assert.match(confidenceProgress([e('yes', true), e('no', null)]), /^1\/10 solved/);
  assert.match(confidenceProgress(Array.from({ length: 10 }, () => e('yes', true))), /^Overall you are underconfident/);
});
