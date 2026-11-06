// Tests for the local learning features (shared/insights.js): confidence
// check, tilt rules, déjà vu, streaks and CSV — run with: node --test tests/*.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { confidenceSummary, resolveConfidence, tiltReason, easierProblem, findDejaVu,
         streaks, activityDays, buildCsv, csvCell } from '../shared/insights.js';

// ── Confidence ──
const entry = (answer, solo, difficulty = 'medium') => ({ slug: `p-${Math.random()}`, answer, difficulty, date: '2026-11-01', solo });

test('confidence card: nothing before 10 entries', () => {
  assert.equal(confidenceSummary(Array.from({ length: 9 }, () => entry('yes', true))), null);
  // Unsolved answers don't count
  assert.equal(confidenceSummary([...Array.from({ length: 9 }, () => entry('yes', true)), entry('no', null)]), null);
});

test('confidence card: the right numbers for a hand-made log', () => {
  const log = [
    // Easy: said Yes 4 times, solved alone 3 → 75%
    entry('yes', true, 'easy'), entry('yes', true, 'easy'), entry('yes', true, 'easy'), entry('yes', false, 'easy'),
    // Medium: said Yes 5 times, alone 1 → 20% → overconfident
    entry('yes', true), entry('yes', false), entry('yes', false), entry('yes', false), entry('yes', false),
    // Hard: said No twice, alone both times → underconfident
    entry('no', true, 'hard'), entry('no', true, 'hard'), entry('maybe', false, 'hard')
  ];
  const s = confidenceSummary(log);
  assert.equal(s.total, 12);
  assert.equal(s.yesSoloPct, 44);                     // 4 of 9 Yes answers
  assert.equal(s.headline, 'When you say Yes, you solve it alone 44% of the time');
  assert.equal(s.verdict, 'overconfident');
  const by = Object.fromEntries(s.byDifficulty.map(d => [d.difficulty, d]));
  assert.deepEqual([by.easy.yesSoloPct, by.easy.verdict], [75, 'well-calibrated']);
  assert.deepEqual([by.medium.yesSoloPct, by.medium.verdict], [20, 'overconfident']);
  assert.deepEqual([by.hard.total, by.hard.verdict], [3, 'underconfident']);
});

test('a solve resolves the open answer: SOLO = no hints', () => {
  const log = [{ slug: 'two-sum', answer: 'yes', solo: null }, { slug: 'lru-cache', answer: 'no', solo: null }];
  const r = resolveConfidence(log, 'two-sum', 100);
  assert.equal(r.changed, true);
  assert.deepEqual(r.log.map(e => e.solo), [true, null]);
  assert.equal(resolveConfidence(r.log, 'two-sum', 60).changed, false);   // already resolved
  assert.equal(resolveConfidence(log, 'lru-cache', 60).log[1].solo, false);
});

// ── Tilt ──
const MIN = 60 * 1000;
test('tilt: 3 failures within 10 minutes', () => {
  const now = 100 * MIN;
  assert.equal(tiltReason({ failures: [now - 9 * MIN, now - 5 * MIN, now], openedAt: now - 12 * MIN, difficulty: 'Easy' }, now), 'failures');
  assert.equal(tiltReason({ failures: [now - 11 * MIN, now - 5 * MIN, now], openedAt: now - 12 * MIN, difficulty: 'Easy' }, now), null);
  // Shown once per problem; never after a solve
  assert.equal(tiltReason({ failures: [now, now, now], shown: true }, now), null);
  assert.equal(tiltReason({ failures: [now, now, now], solved: true }, now), null);
});

test('tilt: 25 / 40 / 60 minutes with no progress on Easy / Medium / Hard', () => {
  const now = 200 * MIN;
  const t = (difficulty, idleMin) => tiltReason({ failures: [], openedAt: now - 100 * MIN, lastProgressAt: now - idleMin * MIN, difficulty }, now);
  assert.equal(t('Easy', 24), null);
  assert.equal(t('Easy', 25), 'stuck');
  assert.equal(t('Medium', 39), null);
  assert.equal(t('Medium', 40), 'stuck');
  assert.equal(t('Hard', 59), null);
  assert.equal(t('Hard', 60), 'stuck');
});

test('tilt: an easier problem on the same pattern, from history first', () => {
  const history = {
    'two-sum': { pattern: 'Hash Map', difficulty: 'easy', title: 'Two Sum', solvedAt: 5 },
    'contains-duplicate': { pattern: 'Hash Set', difficulty: 'easy', title: 'Contains Duplicate', solvedAt: 9 },
    'group-anagrams': { pattern: 'Hash Map', difficulty: 'medium', title: 'Group Anagrams' }
  };
  const pick = easierProblem({ slug: 'subarray-sum-equals-k', pattern: 'Prefix sum + Hash Map', difficulty: 'Medium' }, history, ['lru-cache']);
  assert.deepEqual(pick, { slug: 'contains-duplicate', title: 'Contains Duplicate', from: 'history' });
  // Nothing easier in history → a company-list problem not done yet
  assert.deepEqual(easierProblem({ slug: 'x', pattern: 'Trie', difficulty: 'Hard' }, history, ['two-sum', 'lru-cache']),
    { slug: 'lru-cache', title: 'Lru Cache', from: 'companies' });
});

// ── Déjà vu ──
test('déjà vu: same pattern = 3 points, each shared tag = 1; not solved in the last 2 days', () => {
  const history = {
    'lru-cache': { title: 'LRU Cache', number: '146', pattern: 'Hash Map + Doubly Linked List', topicTags: ['Hash Table', 'Linked List', 'Design'], level: 3, solved: true, solvedDate: '2026-10-16' },
    'two-sum': { title: 'Two Sum', number: '1', pattern: 'Hash Map', topicTags: ['Array', 'Hash Table'], level: 1, solved: true, solvedDate: '2026-11-05' },
    'climbing-stairs': { title: 'Climbing Stairs', pattern: 'DP', topicTags: ['Math', 'Dynamic Programming'], level: 1, solved: true, solvedDate: '2026-09-01' }
  };
  const current = { slug: 'lfu-cache', pattern: 'Hash Map + Linked List', topicTags: ['Hash Table', 'Linked List', 'Design', 'Doubly-Linked List'] };
  const m = findDejaVu(current, history, '2026-11-06');
  assert.equal(m.slug, 'lru-cache');                  // 3 + 3 tags = 6; Two Sum is too recent (1 day)
  assert.equal(m.score, 6);
  assert.equal(m.message, 'This looks like #146 LRU Cache, which you solved 3 weeks ago with Hint 3');
  // Below 3 points → nothing
  assert.equal(findDejaVu({ slug: 'x', pattern: 'Greedy', topicTags: ['Design'] }, history, '2026-11-06'), null);
});

// ── Streaks ──
test('streaks across a month boundary', () => {
  const days = ['2026-10-29', '2026-10-30', '2026-10-31', '2026-11-01', '2026-11-02', '2026-11-05', '2026-11-06'];
  assert.deepEqual(streaks(days, '2026-11-06'), { current: 2, best: 5 });
  assert.deepEqual(streaks(days, '2026-11-07'), { current: 2, best: 5 });    // today not over yet
  assert.deepEqual(streaks(days, '2026-11-08'), { current: 0, best: 5 });
  assert.deepEqual(streaks(['2026-02-28', '2026-03-01'], '2026-03-01'), { current: 2, best: 2 });   // Feb → Mar
  assert.deepEqual(streaks(['2026-12-31', '2027-01-01'], '2027-01-01'), { current: 2, best: 2 });   // year boundary
  assert.deepEqual(streaks([], '2026-11-06'), { current: 0, best: 0 });
});

test('activity days come from solves, reviews and the activity log', () => {
  const days = activityDays({
    stats: { problems: { a: { solvedDate: '2026-11-01' }, b: { solved: false } } },
    revisionQueue: { a: { history: [{ date: '2026-11-03', via: 'solve' }, { date: '2026-11-04', via: 'done' }] } },
    activityLog: ['2026-11-02', '2026-11-01']
  });
  assert.deepEqual(days, ['2026-11-01', '2026-11-02', '2026-11-03']);
});

// ── CSV ──
test('CSV: quoted cells, formulas neutralised, one row per record', () => {
  assert.equal(csvCell('a,b'), '"a,b"');
  assert.equal(csvCell('say "hi"'), '"say ""hi"""');
  assert.equal(csvCell('=SUM(A1)'), "'=SUM(A1)");
  const csv = buildCsv({
    stats: { problems: { 'two-sum': { title: 'Two Sum', difficulty: 'easy', score: 100, level: 1, solved: true, solvedDate: '2026-11-01', pattern: 'Hash Map' } } },
    revisionQueue: { 'lru-cache': { title: 'LRU Cache', difficulty: 'Medium', step: 1, nextDue: '2026-11-09', history: [{ date: '2026-11-06', score: 80, via: 'solve', interval: 3 }] } },
    interviewHistory: [{ slug: 'two-sum', title: 'Two Sum', difficulty: 'Easy', date: new Date(2026, 10, 2, 10).getTime(), durationSec: 1500, hintsUsed: 1, endReason: 'feedback', scorecard: { signal: 'Hire' } }]
  });
  const lines = csv.trim().split('\r\n');
  assert.equal(lines.length, 4);
  assert.equal(lines[0], 'section,slug,title,difficulty,score,level,solved,date,detail');
  assert.equal(lines[1], 'problem,two-sum,Two Sum,easy,100,1,yes,2026-11-01,Hash Map');
  assert.equal(lines[2], 'revision,lru-cache,LRU Cache,Medium,80,step 1,,2026-11-06,solve · next in 3 days');
  assert.equal(lines[3], 'interview,two-sum,Two Sum,Easy,Hire,1 hints,,2026-11-02,25 min · feedback');
});
