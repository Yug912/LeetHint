// Live check that LeetCode's GraphQL still returns what LeetHint reads.
// Skipped by default (it calls leetcode.com); run before each release with:
//   LEETHINT_LIVE=1 node --test tests/graphql.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fetchProblem } from '../shared/leetcode.js';

test('two-sum: title, difficulty, statement, C++ snippet and tags', { skip: process.env.LEETHINT_LIVE !== '1' && 'set LEETHINT_LIVE=1 to run' }, async () => {
  const p = await fetchProblem('two-sum');
  assert.equal(p.slug, 'two-sum');
  assert.equal(p.title, 'Two Sum');
  assert.equal(p.difficulty, 'Easy');
  assert.match(p.description, /target/);
  assert.match(p.description, /nums\.length/);         // constraints made it through htmlToText
  assert.match(p.cppSnippet, /class Solution/);
  assert.ok(p.topicTags.length > 0);
  assert.ok(p.codeSnippets?.python3, 'per-language snippets');
});
