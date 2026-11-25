// Pre-fill planning (tools/prefill-lib.mjs): window, budgets, order, phases, state — run with: node --test tests/*.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { windowStatus, tokensLeft, spendTokens, estimateTokens, orderProblems, companyFrequency, planTasks,
         emptyState, recordDone, recordFailure, isTransient, perDay, daysLeft, hackathonWarning, hm } from '../tools/prefill-lib.mjs';

const cfg = JSON.parse(readFileSync(new URL('../tools/prefill.config.json', import.meta.url)));
const win = { timeZone: 'Asia/Kolkata', start: '05:00', end: '06:00', quotaReset: '05:30' };
const ist = t => new Date(`2026-11-20T${t}:00+05:30`);

test('window: 05:00–06:00 IST, phase flips at 05:30 IST = 00:00 UTC', () => {
  assert.equal(windowStatus(ist('04:59'), win).inside, false);
  const a = windowStatus(ist('05:10'), win);
  assert.deepEqual([a.inside, a.phase, a.msLeft, a.msToReset], [true, 'before', 50 * 60000, 20 * 60000]);
  assert.equal(windowStatus(ist('05:30'), win).phase, 'after');
  assert.equal(windowStatus(ist('06:00'), win).inside, false);
  assert.equal(windowStatus(ist('08:00'), { ...win, end: '09:00' }).inside, true);   // --until 09:00
  assert.throws(() => windowStatus(ist('05:00'), { ...win, end: '04:00' }), /after the start/);
  assert.throws(() => hm('25:00'));
  assert.equal(new Date(ist('05:30')).toISOString().slice(11, 16), '00:00');
});

test('budgets: before-reset tokens belong to the old UTC day, after-reset to the new one', () => {
  const tokens = { hints: 10000, translation: 2500, beforeReset: 30000, afterReset: 15000 };
  const s = emptyState();
  spendTokens(s, ist('05:10'), 'before', 25000);
  assert.equal(tokensLeft(s, ist('05:20'), 'before', tokens), 5000);
  assert.equal(tokensLeft(s, ist('05:31'), 'after', tokens), 15000);   // a fresh UTC day
  spendTokens(s, ist('05:40'), 'after', 10000);
  assert.equal(tokensLeft(s, ist('05:50'), 'after', tokens), 5000);
  assert.equal(estimateTokens({ kind: 'full', langs: [] }, tokens), 10000);
  assert.equal(estimateTokens({ kind: 'full', langs: ['java', 'python3', 'javascript'] }, tokens), 17500);
  assert.equal(estimateTokens({ kind: 'translate', langs: ['java'] }, tokens), 2500);
});

const free = [
  { titleSlug: 'two-sum', likes: 70000 }, { titleSlug: 'lru-cache', likes: 20000 }, { titleSlug: 'valid-sudoku', likes: 9000 },
  { titleSlug: 'popular', likes: 99999 }, { titleSlug: 'asked', likes: 1 }, { titleSlug: 'quiet', likes: 5 }
];
const lists = { blind75: ['lru-cache', 'meeting-rooms', 'two-sum'], neetcode150: ['valid-sudoku', 'two-sum'] };
const freq = companyFrequency({ companies: { Amazon: [['asked', 'A', 50, 'M', 0], ['popular', 'P', 2, 'E', 0]] } }, { quiet: ['X'] });

test('order: Blind 75 → NeetCode 150 → most reported company problems → most liked; premium never', () => {
  assert.deepEqual(orderProblems(free, lists, freq), ['lru-cache', 'two-sum', 'valid-sudoku', 'asked', 'popular', 'quiet']);
});

const c = { ...cfg, priority: { count: 3, languages: [] }, languages: ['java', 'python3'], maxAttempts: 5, backfillPriorityLanguages: true };
const ordered = orderProblems(free, lists, freq);

test('plan: priority problems C++ only first, then the rest with all languages', () => {
  const p = planTasks({ ordered, state: emptyState(), cfg: c, promptVersion: 'p9' });
  assert.equal(p.mode, 'backlog');
  assert.equal(p.remaining, 6);
  assert.equal(p.priorityRemaining, 3);
  assert.deepEqual(p.tasks.map(t => [t.slug, t.langs.join('+')]),
    [['lru-cache', ''], ['two-sum', ''], ['valid-sudoku', ''], ['asked', 'java+python3'], ['popular', 'java+python3'], ['quiet', 'java+python3']]);
});

test('plan: done / current files / skipped / 5 failed attempts are not queued; an old prompt version is', () => {
  const s = emptyState();
  recordDone(s, 'lru-cache', { promptVersion: 'p9', langs: ['cpp'], at: 't' });
  recordDone(s, 'two-sum', { promptVersion: 'p8', langs: ['cpp'], at: 't' });
  for (let i = 0; i < 5; i++) recordFailure(s, 'asked', 'wrong answer', { at: 't' });
  recordFailure(s, 'popular', '429', { at: 't', countsAsAttempt: false });
  s.skipped.quiet = 'no C++ starter code';
  const p = planTasks({ ordered, state: s, cfg: c, promptVersion: 'p9', fileInfo: slug => slug === 'valid-sudoku' ? { promptVersion: 'p9', langs: ['cpp'] } : null });
  assert.deepEqual(p.tasks.map(t => t.slug), ['two-sum', 'popular']);
  assert.deepEqual(p.cachedNow, ['valid-sudoku']);
  assert.deepEqual(p.exhausted, ['asked']);
  assert.equal(s.failed.popular.attempts, 0);   // the AI being busy is not the problem's fault
});

test('plan: empty backlog → new problems (id above the first listing) + language backfill', () => {
  const s = emptyState();
  s.backlogMaxId = 100;
  for (const slug of ordered) recordDone(s, slug, { promptVersion: 'p9', langs: slug === 'asked' ? ['cpp', 'java', 'python3'] : ['cpp'], at: 't' });
  const withNew = [...ordered, 'brand-new'];
  const p = planTasks({ ordered: withNew, ids: { 'brand-new': '3999' }, state: s, cfg: c, promptVersion: 'p9' });
  assert.equal(p.mode, 'new');
  assert.equal(p.tasks[0].slug, 'brand-new');
  assert.equal(p.tasks[0].kind, 'full');
  assert.deepEqual(p.tasks.slice(1).map(t => [t.slug, t.kind, t.langs.join('+')]),
    [['lru-cache', 'translate', 'java+python3'], ['two-sum', 'translate', 'java+python3'], ['valid-sudoku', 'translate', 'java+python3'],
     ['popular', 'translate', 'java+python3'], ['quiet', 'translate', 'java+python3']]);
  // --mode new while the backlog isn't empty: only the new ones
  const s2 = emptyState(); s2.backlogMaxId = 100;
  assert.deepEqual(planTasks({ ordered: withNew, ids: { 'brand-new': '3999', 'two-sum': '1' }, state: s2, cfg: c, mode: 'new', promptVersion: 'p9' }).tasks.map(t => t.slug), ['brand-new']);
  assert.throws(() => planTasks({ ordered, state: s2, cfg: c, mode: 'weird', promptVersion: 'p9' }), /Unknown --mode/);
});

test('recordDone merges languages for the same prompt version, failures are cleared', () => {
  const s = emptyState();
  recordFailure(s, 'x', 'boom', { at: 't' });
  recordDone(s, 'x', { promptVersion: 'p9', langs: ['cpp'], at: 't' });
  recordDone(s, 'x', { promptVersion: 'p9', langs: ['java'], at: 't' });
  assert.deepEqual(s.done.x.langs, ['cpp', 'java']);
  assert.equal(s.failed.x, undefined);
});

test('transient errors: 429, busy, 5xx, network', () => {
  for (const e of [{ status: 429 }, { status: 503 }, { code: 'busy' }, { offline: true }, new Error('fetch failed')]) assert.ok(isTransient(e), JSON.stringify(e));
  for (const e of [new Error('wrong on LeetCode\'s examples'), { status: 400 }]) assert.ok(!isTransient(e));
});

test('rate, days left and the hackathon warning', () => {
  const s = emptyState();
  assert.equal(perDay(s, 40), 40);
  s.runs = [{ mode: 'backlog', newCached: 30 }, { mode: 'backlog', newCached: 50 }, { mode: 'backlog', newCached: 500, manual: true }];
  assert.equal(perDay(s, 40), 40);
  assert.equal(daysLeft(81, 40), 3);
  assert.equal(hackathonWarning({ priorityRemaining: 100, rate: 40, hackathon: '2026-11-25', today: '2026-11-20', count: 300 }), '');
  assert.match(hackathonWarning({ priorityRemaining: 280, rate: 40, hackathon: '2026-11-25', today: '2026-11-20', count: 300 }), /won't be done.*--until/);
});

test('priority lists: Blind 75 and NeetCode 150 have the right sizes', () => {
  const l = JSON.parse(readFileSync(new URL('../data/priority-lists.json', import.meta.url)));
  assert.equal(new Set(l.blind75).size, 75);
  assert.equal(new Set(l.neetcode150).size, 150);
});
