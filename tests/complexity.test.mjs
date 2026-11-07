// Tests for the TLE warning heuristic — run with: node --test tests/*.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { maxInputSize, estimateComplexity, tleWarning, guessLanguage } from '../shared/complexity.js';

test('constraint parser: the largest size bound, never a value bound', () => {
  assert.equal(maxInputSize('Constraints:\n2 <= nums.length <= 10^4\n-10^9 <= nums[i] <= 10^9\n-10^9 <= target <= 10^9'), 10000);
  assert.equal(maxInputSize('1 <= nums.length <= 2 * 10^4'), 20000);
  assert.equal(maxInputSize('n == height.length\n1 <= n <= 2 * 10^4\n0 <= height[i] <= 10^5'), 20000);
  assert.equal(maxInputSize('1 ≤ s.length ≤ 5 * 10^4'), 50000);
  assert.equal(maxInputSize('m == grid.length\nn == grid[i].length\n1 <= m, n <= 300'), 300);
  assert.equal(maxInputSize('1 <= n <= 10<sup>5</sup>'), 100000);
  assert.equal(maxInputSize('The number of nodes in the list is in the range [0, 5000].\n1 <= k <= 10^9'), 0);
  assert.equal(maxInputSize('no constraints here'), 0);
});

test('C++: nested loops, constant loops, binary search and sliding window', () => {
  const nested = `class Solution { public: vector<int> twoSum(vector<int>& nums, int t) {
    for (int i = 0; i < nums.size(); i++) { for (int j = i + 1; j < nums.size(); j++) { if (nums[i] + nums[j] == t) return {i, j}; } }
    return {}; } };`;
  assert.equal(estimateComplexity(nested, 'cpp').loops, 2);
  assert.equal(estimateComplexity(nested, 'cpp').label, 'O(n²)');

  const braceless = `for (int i = 0; i < n; i++)\n  for (int j = 0; j < n; j++)\n    s += a[i] * a[j];\nfor (int k = 0; k < n; k++) { s++; }`;
  assert.equal(estimateComplexity(braceless, 'cpp').loops, 2);

  const dirs = `for (int i = 0; i < n; i++) { for (int d = 0; d < 4; d++) { go(i, d); } }`;
  assert.equal(estimateComplexity(dirs, 'cpp').loops, 1);

  const window = `int l = 0; for (int r = 0; r < n; r++) { cnt[s[r]]++; while (cnt[s[r]] > 1) { cnt[s[l++]]--; } best = max(best, r - l + 1); }`;
  assert.equal(estimateComplexity(window, 'cpp').loops, 1);

  const bs = `for (int x : queries) { int lo = 0, hi = n - 1; while (lo <= hi) { int mid = (lo + hi) / 2; if (a[mid] < x) lo = mid + 1; else hi = mid - 1; } }`;
  assert.equal(estimateComplexity(bs, 'cpp').loops, 1);

  const bfs = `while (!q.empty()) { int u = q.front(); q.pop(); for (int v : adj[u]) if (!seen[v]) { seen[v] = 1; q.push(v); } }`;
  assert.equal(estimateComplexity(bfs, 'cpp').loops, 1);

  assert.equal(estimateComplexity('sort(a.begin(), a.end()); for (int i = 0; i < n; i++) s += a[i];', 'cpp').label, 'O(n log n)');
  assert.equal(estimateComplexity('// for (int i = 0; i < n; i++) for (int j = 0; j < n; j++)\nreturn 0;', 'cpp').loops, 0);
});

test('Java and JavaScript loops', () => {
  const java = `class Solution { public int[] twoSum(int[] nums, int target) {
    for (int i = 0; i < nums.length; i++) { for (int j = i + 1; j < nums.length; j++) { if (nums[i] + nums[j] == target) return new int[]{i, j}; } }
    return new int[0]; } }`;
  assert.equal(guessLanguage(java), 'java');
  assert.equal(estimateComplexity(java).loops, 2);
  const js = `var twoSum = function(nums, target) {
    for (let i = 0; i < nums.length; i++) { for (const j of nums.keys()) { if (i !== j && nums[i] + nums[j] === target) return [i, j]; } }
  };`;
  assert.equal(guessLanguage(js), 'javascript');
  assert.equal(estimateComplexity(js).loops, 2);
  assert.equal(estimateComplexity('const seen = new Map(); for (let i = 0; i < nums.length; i++) { seen.set(nums[i], i); }', 'javascript').loops, 1);
});

test('Python loops, comprehensions and exponential recursion', () => {
  const py = `class Solution:\n    def twoSum(self, nums, target):\n        for i in range(len(nums)):\n            for j in range(i + 1, len(nums)):\n                if nums[i] + nums[j] == target:\n                    return [i, j]\n`;
  assert.equal(guessLanguage(py), 'python');
  assert.equal(estimateComplexity(py).loops, 2);
  assert.equal(estimateComplexity('def f(a):\n    for x in a:\n        for d in range(4):\n            pass\n', 'python').loops, 1);
  assert.equal(estimateComplexity('def f(a):\n    return [x * y for x in a for y in a]\n', 'python').loops, 2);
  const fib = 'def fib(n):\n    if n < 2:\n        return n\n    return fib(n - 1) + fib(n - 2)\n';
  assert.equal(estimateComplexity(fib, 'python').exponential, true);
  const memo = '@cache\ndef fib(n):\n    if n < 2:\n        return n\n    return fib(n - 1) + fib(n - 2)\n';
  assert.equal(estimateComplexity(memo, 'python').exponential, false);
});

test('warning only when the estimate exceeds ~10^8 operations', () => {
  const desc = '2 <= nums.length <= 10^5';
  const quad = 'for (int i = 0; i < n; i++) { for (int j = 0; j < n; j++) { s++; } }';
  const w = tleWarning(desc, quad, 'cpp');
  assert.match(w.message, /nested loops look like O\(n²\)/);
  assert.match(w.message, /n up to 10\^5/);
  assert.match(w.message, /aim for about O\(n log n\)/);
  assert.match(w.message, /not a real run/);
  assert.equal(tleWarning('1 <= nums.length <= 10^3', quad, 'cpp'), null);          // 10^6 fits
  assert.equal(tleWarning(desc, 'for (int i = 0; i < n; i++) s++;', 'cpp'), null);   // O(n) fits
  assert.equal(tleWarning('no bound', quad, 'cpp'), null);
  assert.match(tleWarning('1 <= n <= 50', 'int f(int n){ if(n<2) return n; return f(n-1)+f(n-2); }', 'cpp').message, /exponential/);
});
