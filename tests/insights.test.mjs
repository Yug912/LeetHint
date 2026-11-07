// Tests for confidence, déjà vu, streaks, CSV and the tilt rules — run with: node --test tests/*.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { recordConfidence, resolveConfidence, calibration, similarSolved, agoText, streaks, addActivityDay, historyCsv } from '../shared/insights.js';
import { newTrack, recordFailure, tiltReason, tiltCard, easierOnSamePattern } from '../shared/tilt.js';
import { matchPatterns } from '../shared/patterns.js';

test('confidence: one open answer per problem, closed by the solve', () => {
  let log = recordConfidence([], { slug: 'a', answer: 'yes', difficulty: 'Easy', date: '2026-11-01' });
  log = recordConfidence(log, { slug: 'a', answer: 'no', difficulty: 'Easy', date: '2026-11-01' });   // changed mind
  assert.equal(log.length, 1);
  assert.equal(log[0].answer, 'no');
  log = resolveConfidence(log, 'a', 100);
  assert.equal(log[0].score, 100);
  assert.equal(resolveConfidence(log, 'a', 40), log);                // already closed
  assert.equal(recordConfidence(log, { slug: 'b', answer: 'sure' }), log);   // unknown answer ignored
});

test('calibration card: right numbers for a hand-made log', () => {
  const e = (answer, difficulty, score) => ({ slug: Math.random().toString(36), answer, difficulty, date: '2026-11-01', score });
  const log = [
    e('yes', 'Easy', 100), e('yes', 'Easy', 100), e('yes', 'Easy', 80),
    e('yes', 'Medium', 60), e('yes', 'Medium', 40), e('yes', 'Medium', 100),
    e('no', 'Hard', 20), e('no', 'Hard', 40), e('maybe', 'Medium', 80),
    { slug: 'open', answer: 'yes', difficulty: 'Easy', date: '2026-11-01' }   // not solved yet: not counted
  ];
  assert.equal(calibration(log), null);                    // only 9 resolved
  log.push(e('yes', 'Medium', 40));
  const c = calibration(log);
  assert.equal(c.count, 10);
  assert.equal(c.yesCount, 7);
  assert.equal(c.line, 'When you say Yes, you solve it alone 43% of the time');   // 3 of 7
  assert.equal(c.verdict, 'overconfident');
  assert.equal(c.byDifficulty.Easy.verdict, 'well-calibrated');                 // 2 of 3 SOLO
  assert.equal(c.byDifficulty.Medium.verdict, 'overconfident');                 // 1 of 4
  assert.equal(c.byDifficulty.Hard.verdict, 'well-calibrated');                 // said no, wasn't SOLO
});

test('déjà vu: pattern 3 points + shared tags, not solved in the last 2 days', () => {
  const history = {
    'lru-cache': { title: 'LRU Cache', problemNumber: '146', pattern: 'Hash map + doubly linked list', tags: ['Hash Table', 'Linked List', 'Design'], solved: true, solvedOn: '2026-10-17', level: 3 },
    'two-sum': { title: 'Two Sum', problemNumber: '1', pattern: 'Hash Table Lookup', tags: ['Array', 'Hash Table'], solved: true, solvedOn: '2026-11-06', level: 1 },   // yesterday
    'design-hashmap': { title: 'Design HashMap', pattern: 'Array of buckets', tags: ['Design'], solved: true, solvedOn: '2026-10-01', level: 1 },
    'unsolved': { title: 'X', pattern: 'hash map', tags: ['Hash Table', 'Linked List', 'Design'], solved: false }
  };
  const current = { slug: 'lfu-cache', pattern: 'Hash maps of frequency lists', topicTags: [{ name: 'Hash Table' }, { name: 'Linked List' }, { name: 'Design' }] };
  const m = similarSolved(current, history, '2026-11-07');
  assert.equal(m.slug, 'lru-cache');
  assert.equal(m.message, 'This looks like #146 LRU Cache, which you solved 3 weeks ago with Hint 3.');
  assert.equal(similarSolved({ slug: 'x', pattern: 'Greedy', topicTags: ['Math'] }, history, '2026-11-07'), null);
  assert.equal(agoText('2026-11-06', '2026-11-07'), 'yesterday');
  assert.equal(agoText('2026-08-01', '2026-11-07'), '3 months ago');
});

test('streaks across a month boundary; today still open', () => {
  const days = ['2026-09-28', '2026-09-29', '2026-09-30', '2026-10-01', '2026-10-02', '2026-10-10', '2026-10-11'];
  assert.deepEqual(streaks(days, '2026-10-11'), { current: 2, best: 5 });
  assert.deepEqual(streaks(days, '2026-10-12'), { current: 2, best: 5 });   // yesterday counts until today ends
  assert.deepEqual(streaks(days, '2026-10-13'), { current: 0, best: 5 });
  assert.deepEqual(streaks(['2026-12-31', '2027-01-01'], '2027-01-01'), { current: 2, best: 2 });
  assert.deepEqual(addActivityDay(['2026-10-01'], '2026-10-01'), ['2026-10-01']);
  assert.deepEqual(addActivityDay(['2026-10-02'], '2026-10-01'), ['2026-10-01', '2026-10-02']);
});

test('CSV: one row per item, commas and quotes escaped', () => {
  const csv = historyCsv({
    stats: { problems: { 'two-sum': { title: 'Two Sum, again', difficulty: 'Easy', score: 100, level: 1, solved: true, solvedOn: '2026-11-01' } } },
    revisionQueue: { '3sum': { title: '3Sum', difficulty: 'Medium', step: 1, nextDue: '2026-11-09', history: [{}] } },
    interviewHistory: [{ slug: 'lru-cache', title: 'Say "hi"', difficulty: 'Medium', date: new Date(2026, 10, 2).getTime(), durationSec: 1800, hintsUsed: 1, scorecard: { signal: 'Hire' } }]
  });
  const lines = csv.trim().split('\r\n');
  assert.equal(lines.length, 4);
  assert.equal(lines[0], 'type,slug,title,difficulty,date,score,level,detail');
  assert.equal(lines[1], 'problem,two-sum,"Two Sum, again",Easy,2026-11-01,100,1,solved');
  assert.equal(lines[2], 'revision,3sum,3Sum,Medium,2026-11-09,,1,1 reviews');
  assert.equal(lines[3], 'interview,lru-cache,"Say ""hi""",Medium,2026-11-02,Hire,1,30 min');
});

test('tilt: 3 failures within 10 minutes, once per problem', () => {
  const t0 = Date.UTC(2026, 10, 7, 10);
  let t = newTrack('two-sum', t0);
  t = recordFailure(t, t0 + 60_000);
  t = recordFailure(t, t0 + 120_000);
  assert.equal(tiltReason(t, 'Easy', t0 + 130_000), null);
  t = recordFailure(t, t0 + 180_000);
  assert.deepEqual(tiltReason(t, 'Easy', t0 + 190_000), { reason: 'failures', count: 3 });
  assert.equal(tiltReason({ ...t, shown: true }, 'Easy', t0 + 190_000), null);
  // failures spread over more than 10 minutes don't count together
  let s = newTrack('x', t0);
  for (const m of [0, 6, 12]) s = recordFailure(s, t0 + m * 60_000);
  assert.equal(tiltReason(s, 'Medium', t0 + 12 * 60_000 + 1), null);
});

test('tilt: stuck after 25/40/60 minutes only while the code is stalled', () => {
  const t0 = Date.UTC(2026, 10, 7, 10);
  const t = newTrack('x', t0);
  assert.equal(tiltReason({ ...t, lastCodeChangeAt: t0 + 24 * 60_000 }, 'Easy', t0 + 26 * 60_000), null);   // still typing
  assert.deepEqual(tiltReason({ ...t, lastCodeChangeAt: t0 + 10 * 60_000 }, 'Easy', t0 + 26 * 60_000), { reason: 'stuck', minutes: 26 });
  assert.equal(tiltReason(t, 'Medium', t0 + 39 * 60_000), null);
  assert.equal(tiltReason(t, 'Hard', t0 + 59 * 60_000), null);
  assert.equal(tiltReason(t, 'Hard', t0 + 61 * 60_000).reason, 'stuck');
  assert.equal(tiltReason({ ...t, solved: true }, 'Hard', t0 + 61 * 60_000), null);
});

test('tilt card suggestions', () => {
  assert.match(tiltCard({ reason: 'failures', count: 3 }).text, /Take 5 minutes/);
  assert.deepEqual(tiltCard({ reason: 'stuck', minutes: 41 }, { nextHint: 3 }).action, { kind: 'hint', hint: 3 });
  const easier = easierOnSamePattern(['Sliding Window'], 'Medium', {
    'a': { title: 'A', difficulty: 'Medium', pattern: 'sliding window' },
    'b': { title: 'B', difficulty: 'Easy', pattern: 'Sliding-window technique' }
  }, 'cur', matchPatterns);
  assert.deepEqual(easier, { slug: 'b', title: 'B' });
  assert.deepEqual(tiltCard({ reason: 'stuck', minutes: 41 }, { nextHint: 'solution', easier }).action, { kind: 'problem', slug: 'b', title: 'B' });
});
