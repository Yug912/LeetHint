// Pre-fill helpers (A4): statement text and the local compile check — run with: node --test tests/*.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { htmlToText } from '../shared/html-text.js';
import { compileError } from '../tools/prefill.mjs';

test('statement HTML → text keeps exponents and decodes entities like content.js', () => {
  const html = '<p>Given <code>nums</code>&nbsp;and <code>target</code>.</p><ul><li><code>2 &lt;= nums.length &lt;= 10<sup>4</sup></code></li><li>x<sub>i</sub> &amp; y</li></ul>';
  assert.equal(htmlToText(html), 'Given nums and target.\n\n- 2 <= nums.length <= 10^4\n- x_i & y');
});

let haveCompiler = true;
try { execFileSync(process.env.CXX || 'clang++', ['--version'], { stdio: 'ignore' }); } catch { haveCompiler = false; }

test('compile check: good code passes with LeetCode\'s prelude, broken code reports the error', { skip: !haveCompiler && 'no C++ compiler' }, () => {
  const good = `class Solution {
public:
    vector<int> twoSum(vector<int>& nums, int target) {
        unordered_map<int, int> seen;
        for (int i = 0; i < (int)nums.size(); i++) {
            auto it = seen.find(target - nums[i]);
            if (it != seen.end()) return {it->second, i};
            seen[nums[i]] = i;
        }
        return {};
    }
    ListNode* id(ListNode* h) { return h; }
    TreeNode* t(TreeNode* r) { return r; }
};`;
  assert.equal(compileError(good), '');
  const bad = 'class Solution { public: int f(vector<int>& a) { return undefinedThing + a.size(); } };';
  assert.match(compileError(bad), /undefinedThing/);
});
