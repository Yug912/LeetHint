// Pattern guess (B10) — run with: node --test tests/*.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canonicalPattern, matchPattern, patternAccuracy, weakPatterns, PATTERN_CHIPS } from '../shared/patterns.js';

const MAPPINGS = [
  ['Sliding Window', 'Sliding Window'], ['sliding-window technique', 'Sliding Window'], ['Variable-size window', 'Sliding Window'],
  ['Two Pointers', 'Two Pointers'], ['two-pointer sweep', 'Two Pointers'], ['Fast and slow pointers', 'Two Pointers'],
  ['Hash Table', 'Hash Map'], ['Hash Map', 'Hash Map'], ['Hashing', 'Hash Map'], ['Frequency count', 'Hash Map'],
  ['Binary Search', 'Binary Search'], ['Binary Search on Answer', 'Binary Search'],
  ['Dynamic Programming', 'DP'], ['DP on Intervals', 'DP'], ['Memoization', 'DP'], ["Kadane's Algorithm", 'DP'], ['0/1 Knapsack', 'DP'],
  ['Breadth-First Search', 'Graph/BFS/DFS'], ['Depth-First Search', 'Graph/BFS/DFS'], ['Topological Sort', 'Graph/BFS/DFS'],
  ["Dijkstra's shortest path", 'Graph/BFS/DFS'], ['Graph', 'Graph/BFS/DFS'], ['Multi-source BFS', 'Graph/BFS/DFS'],
  ['Greedy', 'Greedy'], ['Greedy with sorting', 'Greedy'],
  ['Heap (Priority Queue)', 'Heap'], ['Top K elements', 'Heap'], ['Min-heap', 'Heap'],
  ['Stack', 'Stack'], ['Monotonic Stack', 'Stack'], ['Monotonic Queue', 'Stack'],
  ['Backtracking', 'Backtracking'], ['Trie', 'Trie'], ['Prefix tree', 'Trie'],
  ['Union Find', 'Union Find'], ['Disjoint Set Union', 'Union Find'], ['DSU', 'Union Find'],
  ['Bit Manipulation', null], ['Math', null], ['', null]
];

test(`${MAPPINGS.length} pattern spellings map to the chips`, () => {
  for (const [text, chip] of MAPPINGS) assert.equal(canonicalPattern(text), chip, text);
  assert.ok(MAPPINGS.length >= 20);
  for (const c of PATTERN_CHIPS) assert.equal(canonicalPattern(c), c);
});

test('a guess is right if it matches the hints\' pattern or any LeetCode tag', () => {
  const p = { pattern: 'Monotonic Stack', topicTags: ['Array', 'Stack', 'Monotonic Stack'] };
  assert.equal(matchPattern('Stack', p), true);
  assert.equal(matchPattern('Two Pointers', p), false);
  assert.equal(matchPattern('Hash Map', { pattern: 'One-pass complement lookup', topicTags: ['Array', 'Hash Table'] }), true);
  assert.equal(matchPattern('Other', { pattern: 'Bit Manipulation', topicTags: ['Bit Manipulation', 'Math'] }), true);
  assert.equal(matchPattern('Other', p), false);
});

test('accuracy per pattern from 3 guesses, weak ones under 50%', () => {
  const g = (pattern, correct) => ({ slug: 's', guess: 'x', correct, pattern, date: '2026-11-01' });
  const guesses = [g('DP', false), g('Dynamic Programming', false), g('DP on Trees', true),
                   g('Hash Map', true), g('Hash Table', true), g('hashing', true), g('Trie', false)];
  const acc = patternAccuracy(guesses);
  assert.deepEqual(acc.map(e => [e.pattern, e.correct, e.total, e.pct]), [['DP', 1, 3, 33], ['Hash Map', 3, 3, 100]]);
  assert.deepEqual(weakPatterns(guesses).map(e => e.pattern), ['DP']);
});
