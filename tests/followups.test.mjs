// Follow-up questions in the hints prompt (S1, plan 4.7) — run with: node --test tests/*.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildPrompt, PROMPT_VERSION } from '../shared/prompts.js';

const problem = difficulty => ({ slug: 'x', title: 'X', difficulty, description: 'Do the thing.', cppSnippet: 'class Solution {\npublic:\n    int f(int n) {\n    }\n};' });

test('prompt version is p9 (Hint 1 may not state the rule or closed form either)', () => {
  assert.equal(PROMPT_VERSION, 'p9');
  assert.match(buildPrompt('hints', problem('Easy')), /NEVER state the rule the solution follows or the answer's closed form/);
});

test('hints ask for 3 follow-ups with answers that match the solution', () => {
  const p = buildPrompt('hints', problem('Medium'));
  assert.match(p, /EXACTLY 3 classic interview follow-up questions for THIS problem/);
  assert.match(p, /Each answer is 2-3 plain sentences that build\s+on YOUR solution/);
});

test('---FOLLOWUPS--- sits after ---HINT4--- and before ---CODE---, in the Interfaces shape', () => {
  const p = buildPrompt('hints', problem('Hard'));
  assert.match(p, /---HINT4---\n\.\.\.\n---FOLLOWUPS---\nQ: <question 1>\nA: <answer 1>\nQ: <question 2>\nA: <answer 2>\nQ: <question 3>\nA: <answer 3>\n---CODE---/);
});

test('only the hints reply asks for follow-ups', () => {
  for (const action of ['solve', 'fix', 'translate']) {
    assert.doesNotMatch(buildPrompt(action, problem('Medium'), 'class Solution {};', { language: 'java' }), /FOLLOWUPS/, action);
  }
});
