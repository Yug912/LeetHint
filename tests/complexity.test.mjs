// Tests for the TLE warning heuristic (shared/complexity.js) — run with: node --test tests/*.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseNumber, parseMaxBound, analyzeCode, tleWarning } from '../shared/complexity.js';

test('numbers as LeetCode writes them', () => {
  assert.equal(parseNumber('10^5'), 1e5);
  assert.equal(parseNumber('2 * 10^4'), 2e4);
  assert.equal(parseNumber('10⁵'), 1e5);
  assert.equal(parseNumber('100000'), 1e5);
  assert.equal(parseNumber('100,000'), 1e5);
  assert.equal(parseNumber('1e5'), 1e5);
  assert.equal(parseNumber('5*10**4'), 5e4);
});

test('constraint parser: the largest SIZE, never an element value', () => {
  const twoSum = `Constraints:
- 2 <= nums.length <= 10^4
- -10^9 <= nums[i] <= 10^9
- -10^9 <= target <= 10^9`;
  assert.equal(parseMaxBound(twoSum), 1e4);
  assert.equal(parseMaxBound('1 <= n <= 10^5'), 1e5);
  assert.equal(parseMaxBound('1 <= s.length <= 5 * 10^4\ns consists of English letters'), 5e4);
  assert.equal(parseMaxBound('m == grid.length\nn == grid[i].length\n1 <= m, n <= 200'), 200);
  assert.equal(parseMaxBound('The number of nodes in the tree is in the range [0, 10^4].'), 1e4);
  assert.equal(parseMaxBound('1 ≤ nums.length ≤ 2 * 10^5'), 2e5);
  assert.equal(parseMaxBound('0 <= nums[i] <= 10^9'), 0);
  assert.equal(parseMaxBound(''), 0);
});

const CPP_N2 = `class Solution {
public:
    vector<int> twoSum(vector<int>& nums, int target) {
        for (int i = 0; i < nums.size(); i++) {
            for (int j = i + 1; j < nums.size(); j++)
                if (nums[i] + nums[j] == target) return {i, j};   // "for" in a comment: for
        }
        return {};
    }
};`;

test('C++: nested loops, braces or not; comments and strings ignored', () => {
  assert.equal(analyzeCode(CPP_N2, 'cpp').loopDepth, 2);
  assert.equal(analyzeCode('for(int i=0;i<n;i++) for(int j=0;j<n;j++) for(int k=0;k<n;k++) s++;', 'cpp').loopDepth, 3);
  assert.equal(analyzeCode('for (int i=0;i<n;i++) a++;\nfor (int j=0;j<n;j++) b++;', 'cpp').loopDepth, 1);
  assert.equal(analyzeCode('string s = "for (;;) for (;;)"; int x = 1;', 'cpp').loopDepth, 0);
  assert.equal(analyzeCode('do { i++; } while (i < n);', 'cpp').loopDepth, 1);
  assert.equal(analyzeCode('sort(nums.begin(), nums.end()); for (auto x : nums) s += x;', 'cpp').sorts, true);
});

test('Java: nested loops and Arrays.sort', () => {
  const java = `class Solution {
    public int[] twoSum(int[] nums, int target) {
        Arrays.sort(nums);
        for (int i = 0; i < nums.length; i++) {
            int j = i + 1;
            while (j < nums.length) { if (nums[i] + nums[j] == target) return new int[]{i, j}; j++; }
        }
        return new int[0];
    }
}`;
  const a = analyzeCode(java, 'java');
  assert.equal(a.loopDepth, 2);
  assert.equal(a.sorts, true);
});

test('Python: indentation, comprehensions, sorted()', () => {
  const py = `class Solution:
    def twoSum(self, nums: List[int], target: int) -> List[int]:
        for i in range(len(nums)):
            for j in range(i + 1, len(nums)):
                if nums[i] + nums[j] == target:
                    return [i, j]
        # for for for
        return []`;
  assert.equal(analyzeCode(py, 'python3').loopDepth, 2);
  assert.equal(analyzeCode('pairs = [(a, b) for a in xs for b in ys]', 'python3').loopDepth, 2);
  assert.equal(analyzeCode('for x in xs:\n    total += x\nfor y in ys:\n    total += y', 'python3').loopDepth, 1);
  assert.equal(analyzeCode('xs = sorted(xs)', 'python3').sorts, true);
});

test('JavaScript: for / for...of / while', () => {
  const js = `var twoSum = function(nums, target) {
    for (const i of nums.keys()) {
        let j = 0;
        while (j < nums.length) { j++; }
    }
};`;
  assert.equal(analyzeCode(js, 'javascript').loopDepth, 2);
});

test('recursion with two self-calls and no memo = possibly exponential', () => {
  const fib = 'class Solution {\npublic:\n  int fib(int n) {\n    if (n < 2) return n;\n    return fib(n - 1) + fib(n - 2);\n  }\n};';
  assert.equal(analyzeCode(fib, 'cpp').exponential, true);
  const memo = 'class Solution {\n  int memo[50];\npublic:\n  int fib(int n) {\n    if (n < 2) return n;\n    if (memo[n]) return memo[n];\n    return memo[n] = fib(n - 1) + fib(n - 2);\n  }\n};';
  assert.equal(analyzeCode(memo, 'cpp').exponential, false);
  const py = 'class Solution:\n    def climb(self, n):\n        if n <= 1:\n            return 1\n        return self.climb(n - 1) + self.climb(n - 2)';
  assert.equal(analyzeCode(py, 'python3').exponential, true);
  const once = 'void dfs(int u) { for (int v : g[u]) dfs(v); }\nint main() { dfs(0); }';
  assert.equal(analyzeCode(once, 'cpp').exponential, false);
});

test('the warning: O(n²) with n up to 10^5 → aim for O(n log n)', () => {
  const w = tleWarning(CPP_N2, 'cpp', '1 <= nums.length <= 10^5');
  assert.equal(w.message, 'Your nested loops look like O(n²). With n up to 10^5 this may time out; aim for about O(n log n).');
  // Same code, small n → fine
  assert.equal(tleWarning(CPP_N2, 'cpp', '2 <= nums.length <= 10^3'), null);
  // No constraint found → say nothing
  assert.equal(tleWarning(CPP_N2, 'cpp', 'no constraints here'), null);
  // Exponential recursion with n up to 10^4
  const fib = 'int f(int n) { return n < 2 ? n : f(n - 1) + f(n - 2); }';
  assert.match(tleWarning(fib, 'cpp', '1 <= n <= 10^4').message, /^Your recursion calls itself twice with no memo — that looks like O\(2ⁿ\)\./);
  // A single loop is fine even for 10^5
  assert.equal(tleWarning('for (int i = 0; i < n; i++) s += a[i];', 'cpp', '1 <= n <= 10^5'), null);
});
