// Tests for the pattern guess (shared/patterns.js) — run with: node --test tests/*.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PATTERN_CHIPS, normalizePattern, chipsIn, matchPattern, primaryPattern, patternAccuracy, weakPatterns } from '../shared/patterns.js';

// [text as a model or LeetCode writes it, chip]
const MAPPINGS = [
  ['Sliding Window', 'Sliding Window'], ['sliding-window technique', 'Sliding Window'], ['Variable-size window', 'Sliding Window'],
  ['Two Pointers', 'Two Pointers'], ['two-pointer approach', 'Two Pointers'], ['Fast and slow pointers', 'Two Pointers'],
  ['Hash Table', 'Hash Map'], ['HashMap lookup', 'Hash Map'], ['hash set', 'Hash Map'], ['Counting', 'Hash Map'], ['Frequency map', 'Hash Map'],
  ['Binary Search', 'Binary Search'], ['binary search on the answer', 'Binary Search'],
  ['Dynamic Programming', 'DP'], ['DP (bottom-up tabulation)', 'DP'], ['Memoization', 'DP'], ['0/1 knapsack', 'DP'],
  ['Breadth-First Search', 'Graph/BFS/DFS'], ['Depth-First Search', 'Graph/BFS/DFS'], ['Graph', 'Graph/BFS/DFS'],
  ['Topological Sort', 'Graph/BFS/DFS'], ['Binary Tree', 'Graph/BFS/DFS'], ['Binary Search Tree', 'Graph/BFS/DFS'], ['Shortest Path', 'Graph/BFS/DFS'],
  ['Greedy', 'Greedy'], ['Greedy interval scheduling', 'Greedy'],
  ['Heap (Priority Queue)', 'Heap'], ['min-heap', 'Heap'], ['Top K elements', 'Heap'],
  ['Stack', 'Stack'], ['Monotonic Stack', 'Stack'], ['monotonic deque', 'Stack'],
  ['Backtracking', 'Backtracking'], ['generate all permutations', 'Backtracking'],
  ['Trie', 'Trie'], ['prefix tree', 'Trie'],
  ['Union Find', 'Union Find'], ['Disjoint Set Union (DSU)', 'Union Find'],
  ['Other', 'Other']
];

test(`${MAPPINGS.length} pattern spellings map to the right chip`, () => {
  assert.ok(MAPPINGS.length >= 20);
  for (const [text, chip] of MAPPINGS) assert.equal(normalizePattern(text), chip, text);
});

test('every chip maps to itself; plain topics map to nothing', () => {
  for (const chip of PATTERN_CHIPS) assert.equal(normalizePattern(chip), chip);
  for (const plain of ['Array', 'String', 'Math', 'Sorting', 'Linked List', '', 'Unknown']) assert.equal(normalizePattern(plain), null, plain);
});

test('combined patterns name every chip', () => {
  assert.deepEqual(chipsIn('Hash Map + Sliding Window').sort(), ['Hash Map', 'Sliding Window']);
  assert.deepEqual(chipsIn('BFS / Union Find').sort(), ['Graph/BFS/DFS', 'Union Find']);
});

test('a guess is right if it matches the hints\' pattern OR a topic tag', () => {
  const twoSum = { pattern: 'Hash Map', topicTags: ['Array', 'Hash Table'] };
  assert.equal(matchPattern('Hash Map', twoSum), true);
  assert.equal(matchPattern('Two Pointers', twoSum), false);
  const threeSum = { pattern: 'Sorting + Two Pointers', topicTags: ['Array', 'Two Pointers', 'Sorting'] };
  assert.equal(matchPattern('Two Pointers', threeSum), true);
  // Only a topic tag matches
  assert.equal(matchPattern('Binary Search', { pattern: 'Prefix sums', topicTags: ['Binary Search', 'Prefix Sum'] }), true);
  // "Other" only when nothing known applies
  assert.equal(matchPattern('Other', { pattern: 'Math', topicTags: ['Math'] }), true);
  assert.equal(matchPattern('Other', twoSum), false);
  assert.equal(matchPattern('', twoSum), false);
});

test('primaryPattern: the hints\' pattern first, then the tags', () => {
  assert.equal(primaryPattern({ pattern: 'Sliding window', topicTags: ['Hash Table'] }), 'Sliding Window');
  assert.equal(primaryPattern({ pattern: 'Unknown', topicTags: ['Array', 'Hash Table'] }), 'Hash Map');
  assert.equal(primaryPattern({}), 'Other');
});

test('accuracy per pattern needs 3 guesses; under 50% is weak', () => {
  const g = (pattern, correct) => ({ slug: 'x', guess: 'DP', correct, pattern, date: '2026-11-01' });
  const guesses = [g('DP', false), g('DP', false), g('Dynamic Programming', true),
                   g('Hash Map', true), g('Hash Table', true), g('Hash Map', true), g('Hash Map', false),
                   g('Trie', true), g('Trie', true)];
  const acc = patternAccuracy(guesses);
  assert.deepEqual(acc.map(r => [r.pattern, r.total, r.pct]), [['DP', 3, 33], ['Hash Map', 4, 75]]);   // Trie: only 2
  assert.deepEqual(weakPatterns(guesses).map(r => r.pattern), ['DP']);
});
