// Tests for the accuracy rules in the prompts — run with: node --test tests/*.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildPrompt, buildHintsPrompt, PROMPT_VERSION } from '../shared/prompts.js';

const problem = difficulty => ({ slug: 'x', title: 'X', difficulty, description: 'Do the thing.', cppSnippet: 'class Solution {\npublic:\n    int f(int n) {\n    }\n};' });

test('Hard problems cross-check against a brute force; others do not', () => {
  assert.match(buildPrompt('hints', problem('Hard')), /HARD PROBLEM — the examples are NOT enough/);
  assert.doesNotMatch(buildPrompt('hints', problem('Medium')), /HARD PROBLEM/);
});

test('every solution prompt asks for a compile check', () => {
  assert.match(buildPrompt('solve', problem('Easy')), /COMPILE CHECK: every helper is a member function at class scope/);
});

test('Hint 1 bans naming techniques, including "instead of X" contrasts', () => {
  const p = buildPrompt('hints', problem('Medium'));
  assert.match(p, /NEVER name an algorithm, technique or data structure/);
  assert.match(p, /No "instead of X, use Y" contrasts/);
});

test('Fix with a failing test puts that test first', () => {
  const p = buildPrompt('fix', problem('Hard'), 'class Solution {};', { failure: 'Input: n = 3\nOutput: 2\nExpected: 1' });
  assert.match(p, /LEETCODE REJECTED THIS CODE[\s\S]*Expected: 1/);
  assert.match(p, /0\. Trace the code on the failing input/);
  assert.doesNotMatch(buildPrompt('fix', problem('Hard'), 'class Solution {};'), /REJECTED/);
});

test('hints reply asks for 3 follow-ups between ---HINT4--- and ---CODE--- (contract item 2)', () => {
  const p = buildPrompt('hints', problem('Medium'));
  assert.match(p, /---HINT4---\n\.\.\.\n---FOLLOWUPS---\nQ: \.\.\.\nA: \.\.\.\nQ: \.\.\.\nA: \.\.\.\nQ: \.\.\.\nA: \.\.\.\n---CODE---/);
  assert.match(p, /3 classic interview follow-up questions for THIS problem/);
  assert.match(p, /Each answer is 2-3 plain sentences/);
  // Only the hints reply carries follow-ups: plain solve, fix and the hints-only fallback do not
  assert.doesNotMatch(buildPrompt('solve', problem('Medium')), /FOLLOWUPS/);
  assert.doesNotMatch(buildPrompt('fix', problem('Medium'), 'class Solution {};'), /FOLLOWUPS/);
  assert.doesNotMatch(buildHintsPrompt(problem('Medium')), /FOLLOWUPS/);
});

test('prompt version is p7 (follow-ups changed the hints prompt)', () => {
  assert.equal(PROMPT_VERSION, 'p7');
});
