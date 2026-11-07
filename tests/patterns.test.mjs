// Tests for the pattern-guess mapping — run with: node --test tests/*.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { matchPatterns, problemPatterns, isGuessCorrect, guessAccuracy, weakPatterns, PATTERN_CHIPS } from '../shared/patterns.js';

const CASES = [
  ['Sliding Window', 'Sliding Window'],
  ['sliding-window technique', 'Sliding Window'],
  ['Variable-size window with a hash map', 'Sliding Window'],
  ['Two Pointers', 'Two Pointers'],
  ['two-pointer sweep from both ends', 'Two Pointers'],
  ['Fast & slow pointers (Floyd cycle detection)', 'Two Pointers'],
  ['Hash Table', 'Hash Map'],
  ['Hash Table Lookup', 'Hash Map'],
  ['unordered_map of complements', 'Hash Map'],
  ['Binary Search', 'Binary Search'],
  ['binary search on the answer', 'Binary Search'],
  ['Dynamic Programming', 'DP'],
  ['1-D DP over prefixes', 'DP'],
  ['Memoization', 'DP'],
  ['Breadth-First Search', 'Graph/BFS/DFS'],
  ['Depth-First Search', 'Graph/BFS/DFS'],
  ['Topological Sort', 'Graph/BFS/DFS'],
  ['Graph', 'Graph/BFS/DFS'],
  ['Greedy', 'Greedy'],
  ['Heap (Priority Queue)', 'Heap'],
  ['Top K with a min-heap', 'Heap'],
  ['Monotonic Stack', 'Stack'],
  ['Stack', 'Stack'],
  ['Backtracking', 'Backtracking'],
  ['generate all permutations', 'Backtracking'],
  ['Trie', 'Trie'],
  ['prefix tree of words', 'Trie'],
  ['Union Find', 'Union Find'],
  ['Disjoint Set Union', 'Union Find']
];

test('at least 20 different wordings map onto the right chip', () => {
  assert.ok(CASES.length >= 20);
  for (const [text, chip] of CASES) assert.ok(matchPatterns(text).includes(chip), `${text} → ${chip} (got ${matchPatterns(text)})`);
});

test('plain topics map to nothing, so only "Other" is right', () => {
  for (const t of ['Array', 'String', 'Math', 'Simulation', '']) assert.deepEqual(matchPatterns(t), []);
  assert.equal(isGuessCorrect('Other', 'Array simulation', ['Array', 'Math']), true);
  assert.equal(isGuessCorrect('Hash Map', 'Array simulation', ['Array']), false);
});

test('a guess is right if the hints OR any LeetCode tag names it', () => {
  const tags = [{ name: 'Array', slug: 'array' }, { name: 'Hash Table', slug: 'hash-table' }];
  assert.equal(isGuessCorrect('Hash Map', 'Single pass', tags), true);
  assert.equal(isGuessCorrect('Sliding Window', 'Sliding-window technique', ['String']), true);
  assert.equal(isGuessCorrect('Two Pointers', 'Sliding-window technique', ['String']), false);
  assert.deepEqual(problemPatterns('Monotonic stack', ['Stack', 'Array']), ['Stack']);
  assert.ok(PATTERN_CHIPS.includes('Other'));
});

test('accuracy per pattern needs 3 guesses; under 50% is a weak pattern', () => {
  const g = (pattern, correct) => ({ pattern, correct });
  const guesses = [g('Sliding Window', false), g('sliding window', false), g('Sliding Window', true),
                   g('DP', true), g('DP', true), g('DP', true), g('Trie', false)];
  const acc = guessAccuracy(guesses);
  assert.deepEqual(acc.map(a => [a.chip, a.total, a.correct]), [['Sliding Window', 3, 1], ['DP', 3, 3]]);
  assert.deepEqual(weakPatterns(guesses), ['Sliding Window']);
});
