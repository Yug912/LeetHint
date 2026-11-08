// tools/examples.mjs — LeetCode's examples as a gate for static files.
// Offline: LeetCode is faked; compiling needs clang++ (skipped without it).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cppLiteral, cppType, expectedOutputs, normalise, sameAnswer, runExamples } from '../tools/examples.mjs';

let hasClang = true;
try { execFileSync(process.env.CXX || 'clang++', ['--version'], { stdio: 'pipe' }); } catch { hasClang = false; }

const TWO_SUM = {
  content: '<p><strong>Output:</strong> [0,1]</p><p><strong>Output:</strong> [1,2]</p><p><strong>Output:</strong> [0,1]</p>',
  metaData: JSON.stringify({ name: 'twoSum', params: [{ name: 'nums', type: 'integer[]' }, { name: 'target', type: 'integer' }], return: { type: 'integer[]' } }),
  exampleTestcaseList: ['[2,7,11,15]\n9', '[3,2,4]\n6', '[3,3]\n6']
};
const fake = q => async () => ({ question: q });
const RIGHT = `class Solution { public: vector<int> twoSum(vector<int>& n, int t) { unordered_map<int,int> m;
  for (int i = 0; i < (int)n.size(); i++) { if (m.count(t - n[i])) return {m[t - n[i]], i}; m[n[i]] = i; } return {}; } };`;
const WRONG = `class Solution { public: vector<int> twoSum(vector<int>& n, int t) {
  for (int i = 0; i < (int)n.size(); i++) for (int j = i; j < (int)n.size(); j++) if (n[i] + n[j] == t) return {i, j}; return {}; } };`;

test('LeetCode values → C++ literals and types', () => {
  assert.equal(cppType('list<list<integer>>'), 'vector<vector<int>>');
  assert.equal(cppLiteral('integer[][]', [[0, 1], [1, 2]]), 'vector<vector<int>>{vector<int>{0,1},vector<int>{1,2}}');
  assert.equal(cppLiteral('string', 'a"b'), '"a\\"b"');
  assert.equal(cppLiteral('character[]', ['a', "'"]), "vector<char>{'a','\\''}");
  assert.equal(cppLiteral('TreeNode', [3, 9, null, 7]), 'mkTree({3,9,NUL,7})');
  assert.throws(() => cppType('Node'), /unsupported/);
});

test('expected outputs, order-free answers and number tolerance', () => {
  assert.deepEqual(expectedOutputs(TWO_SUM.content), ['[0,1]', '[1,2]', '[0,1]']);
  assert.ok(sameAnswer(normalise([1, 0], 'flat'), normalise([0, 1], 'flat')));
  assert.ok(sameAnswer(normalise([[2, -1, -1], [1, 0, -1]], 'deep'), normalise([[-1, -1, 2], [-1, 0, 1]], 'deep')));
  assert.ok(!sameAnswer([0, 0], [1, 2]));
  assert.ok(sameAnswer(2.500001, 2.5));
});

test('a right solution passes, a wrong one fails with the case', { skip: !hasClang && 'needs clang++' }, async () => {
  assert.deepEqual(await runExamples('two-sum', RIGHT, { leetcode: fake(TWO_SUM) }), { ok: true, passed: 3, total: 3 });
  const bad = await runExamples('two-sum', WRONG, { leetcode: fake(TWO_SUM) });
  assert.equal(bad.ok, false);
  assert.equal(bad.passed, 1);   // [3,2,4] and [3,3] both return [0,0]
  assert.equal(bad.failures[0].expected, '[1,2]');
});

test('a problem the runner cannot drive is skipped, not failed', async () => {
  const design = { ...TWO_SUM, metaData: JSON.stringify({ classname: 'LRUCache', methods: [] }) };
  const r = await runExamples('lru-cache', RIGHT, { leetcode: fake(design) });
  assert.equal(r.ok, false);
  assert.ok(r.skipped);
});
