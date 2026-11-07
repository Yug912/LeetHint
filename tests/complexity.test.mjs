// TLE warning (B13) — run with: node --test tests/*.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseBound, maxConstraint, loopDepth, exponentialRecursion, estimateCost, tleWarning, prettyBound } from '../shared/complexity.js';

test('bounds parse in every way LeetCode writes them', () => {
  assert.equal(parseBound('10^5'), 1e5);
  assert.equal(parseBound('2 * 10^4'), 2e4);
  assert.equal(parseBound('5 x 10^4'), 5e4);
  assert.equal(parseBound('1e5'), 1e5);
  assert.equal(parseBound('10⁵'), 1e5);
  assert.equal(parseBound('100000'), 1e5);
  assert.equal(prettyBound(2e4), '2 × 10^4');
  assert.equal(prettyBound(1e5), '10^5');
});

test('the largest SIZE bound is found; value bounds are ignored', () => {
  const s = `Constraints:\n\n- 2 <= nums.length <= 10^4\n- -10^9 <= nums[i] <= 10^9\n- -10^9 <= target <= 10^9`;
  assert.equal(maxConstraint(s).bound, 1e4);
  assert.equal(maxConstraint('1 <= n <= 2 * 10^5\n1 <= k <= n').bound, 2e5);
  assert.equal(maxConstraint('m == grid.length\nn == grid[i].length\n1 <= m, n <= 300').bound, 300);
  assert.equal(maxConstraint('The number of nodes in the tree is in the range [0, 100].'), null);
  assert.equal(maxConstraint('no constraints here'), null);
});

test('C++: nesting depth, single-statement loops and sort', () => {
  const cpp = `class Solution { public:
    vector<int> twoSum(vector<int>& nums, int target) {
      for (int i = 0; i < nums.size(); i++) {
        for (int j = i + 1; j < nums.size(); j++) {
          if (nums[i] + nums[j] == target) return {i, j};   // for (fake) in a comment
        }
      }
      return {};
    } };`;
  assert.equal(loopDepth(cpp, 'cpp'), 2);
  assert.equal(loopDepth('for (int i=0;i<n;i++) for (int j=0;j<n;j++) s += a[i]*a[j];', 'cpp'), 2);
  assert.equal(loopDepth('for (int i=0;i<n;i++) s += a[i];\nfor (int j=0;j<n;j++) t += a[j];', 'cpp'), 1);
  assert.equal(loopDepth('while (l < r) { int m = (l + r) / 2; if (a[m] < x) l = m + 1; else r = m; }', 'cpp'), 1);
  assert.equal(estimateCost('sort(a.begin(), a.end()); for (int i=0;i<n;i++) {}', 'cpp').label, 'O(n log n)');
  assert.equal(loopDepth('string s = "for (;;) {"; int x = 0;', 'cpp'), 0);
});

test('Java and JavaScript loops', () => {
  const java = `class Solution { public int f(int[] a) { int c = 0;
    for (int x : a) { for (int y : a) { while (y > 0) { y--; c++; } } } return c; } }`;
  assert.equal(loopDepth(java, 'java'), 3);
  const js = `var f = function(a) { let c = 0; a.forEach(x => { for (const y of a) c += x * y; }); return c; };`;
  assert.equal(loopDepth(js, 'javascript'), 2);
  assert.equal(loopDepth('for (let i = 0; i < n; i++) { total += a[i]; }', 'javascript'), 1);
});

test('Python: indentation and comprehensions', () => {
  const py = `class Solution:
    def twoSum(self, nums, target):
        for i in range(len(nums)):
            for j in range(i + 1, len(nums)):
                if nums[i] + nums[j] == target:
                    return [i, j]
        # for x in comment
        return []`;
  assert.equal(loopDepth(py, 'python3'), 2);
  assert.equal(loopDepth('def f(a):\n    return sum(x*y for x in a for y in a)', 'python3'), 2);
  assert.equal(loopDepth('def f(a):\n    for x in a:\n        pass\n    for y in a:\n        pass', 'python3'), 1);
  assert.equal(estimateCost('def f(a):\n    a.sort()\n    return a[0]', 'python3').label, 'O(n log n)');
});

test('two self-calls without a memo = possibly exponential', () => {
  assert.equal(exponentialRecursion('int fib(int n) { if (n < 2) return n; return fib(n-1) + fib(n-2); }', 'cpp'), true);
  assert.equal(exponentialRecursion('int fib(int n, vector<int>& memo) { return fib(n-1, memo) + fib(n-2, memo); }', 'cpp'), false);
  assert.equal(exponentialRecursion('def go(i):\n    return go(i+1) + go(i+2)', 'python3'), true);
});

test('the warning: only when it would exceed ~10^8 operations', () => {
  const statement = 'Constraints:\n2 <= nums.length <= 10^5';
  const w = tleWarning(statement, 'for (int i=0;i<n;i++) { for (int j=0;j<n;j++) {} }', 'cpp');
  assert.equal(w.message, 'Your nested loops look like O(n²). With n up to 10^5 this may time out; aim for about O(n log n).');
  assert.equal(tleWarning('1 <= n <= 1000', 'for (int i=0;i<n;i++) { for (int j=0;j<n;j++) {} }', 'cpp'), null);
  assert.equal(tleWarning(statement, 'for (int i=0;i<n;i++) {}', 'cpp'), null);
  assert.match(tleWarning('1 <= n <= 45', 'int fib(int n) { return fib(n-1) + fib(n-2); }', 'cpp').message, /O\(2ⁿ\)/);
});
