// Companies tab: "what does Amazon ask?" — run with: node --test tests/*.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { loadCompanyLists, companyOptions, companyProblems, filterProblems, solvedSlugs, progress, pickNext, companyLabel } from '../api/company-lists.js';

const DOC = {
  source: 'test', builtAt: '2026-11-10',
  companies: {
    Zeta: [['z-one', 'Z One', 3, 'E', 0]],
    Amazon: [['lru-cache', 'LRU Cache', 117, 'M', 0], ['two-sum', 'Two Sum', 117, 'E', 0],
             ['trapping-rain-water', 'Trapping Rain Water', 45, 'H', 0], ['meeting-rooms-ii', 'Meeting Rooms II', 48, 'M', 1]],
    Facebook: [['valid-palindrome-ii', 'Valid Palindrome II', 30, 'E', 0]],
    Empty: []
  }
};

test('companies: popular ones first, then A→Z; empty lists left out; display names', () => {
  const opts = companyOptions(DOC);
  assert.deepEqual(opts.map(o => o.name), ['Amazon', 'Facebook', 'Zeta']);
  assert.equal(opts[0].count, 4);
  assert.equal(opts[1].label, 'Meta (Facebook)');
  assert.equal(companyLabel('tiktok'), 'TikTok');
  assert.deepEqual(companyOptions(null), []);
});

test('a company list keeps the file order (most asked first) with its full-list rank', () => {
  const list = companyProblems(DOC, 'Amazon');
  assert.deepEqual(list.map(p => p.slug), ['lru-cache', 'two-sum', 'trapping-rain-water', 'meeting-rooms-ii']);
  assert.deepEqual(list[0], { rank: 1, slug: 'lru-cache', title: 'LRU Cache', times: 117, difficulty: 'Medium', premium: false });
  assert.equal(list[3].premium, true);
  assert.deepEqual(companyProblems(DOC, 'Nobody'), []);
});

test('filters: difficulty, hide solved, hide Premium — ranks are not renumbered', () => {
  const list = companyProblems(DOC, 'Amazon');
  const solved = new Set(['two-sum']);
  assert.deepEqual(filterProblems(list, { difficulty: 'Medium' }).map(p => p.rank), [1, 4]);
  assert.deepEqual(filterProblems(list, { hideSolved: true, solved }).map(p => p.slug), ['lru-cache', 'trapping-rain-water', 'meeting-rooms-ii']);
  assert.deepEqual(filterProblems(list, { hidePremium: true, difficulty: 'Medium' }).map(p => p.slug), ['lru-cache']);
});

test('solved slugs come from stats; old entries without the flag count as solved', () => {
  const s = solvedSlugs({ problems: { 'two-sum': { solved: true }, 'lru-cache': { solved: false }, 'old-one': { score: 80 } } });
  assert.deepEqual([...s].sort(), ['old-one', 'two-sum']);
  assert.equal(solvedSlugs(undefined).size, 0);
});

test('progress and the practise button: unsolved free problems from the top N only', () => {
  const list = companyProblems(DOC, 'Amazon');
  const solved = new Set(['lru-cache', 'two-sum']);
  assert.deepEqual(progress(list, solved, 2), { solved: 2, total: 2 });
  assert.deepEqual(progress(list, solved), { solved: 2, total: 4 });
  assert.equal(pickNext(list, solved, { top: 4, random: () => 0.99 }).slug, 'trapping-rain-water');   // Premium one skipped
  assert.equal(pickNext(list, solved, { top: 2 }), null);
});

test('loading: a bad or missing file gives null, never an error', async () => {
  assert.equal(await loadCompanyLists({ url: 'x', fetchFn: async () => new Response('nope', { status: 404 }) }), null);
  assert.equal(await loadCompanyLists({ url: 'x', fetchFn: async () => new Response('[1,2]') }), null);
  assert.equal(await loadCompanyLists({ url: 'x', fetchFn: async () => { throw new Error('offline'); } }), null);
  const doc = await loadCompanyLists({ url: 'x', fetchFn: async () => Response.json(DOC) });
  assert.equal(companyProblems(doc, 'Amazon').length, 4);
});

test('the bundled data file: big companies present, sorted by times asked, valid rows', () => {
  const doc = JSON.parse(readFileSync(new URL('../data/company-problems.json', import.meta.url), 'utf8'));
  for (const c of ['Amazon', 'Google', 'Facebook', 'Microsoft']) {
    const list = companyProblems(doc, c);
    assert.ok(list.length > 200, `${c} has ${list.length}`);
    for (let i = 1; i < list.length; i++) assert.ok(list[i - 1].times >= list[i].times, `${c} sorted at ${i}`);
    assert.ok(list.every(p => /^[a-z0-9-]+$/.test(p.slug) && p.title && p.times > 0));
  }
  assert.equal(companyProblems(doc, 'Amazon')[0].slug, 'lru-cache');
  const all = Object.values(doc.companies).flat();
  assert.ok(all.filter(r => r[3]).length / all.length > 0.98, 'difficulty known for nearly every row');
});
