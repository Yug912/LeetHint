// Tests for the accuracy rules in the prompts — run with: node --test tests/*.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildPrompt } from '../shared/prompts.js';
import { parseFollowUps } from '../shared/followups.js';

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

test('hints ask for 3 follow-up questions, in the shared format', () => {
  const p = buildPrompt('hints', problem('Medium'));
  assert.match(p, /FOLLOW-UPS — then write EXACTLY 3 follow-up questions/);
  assert.match(p, /---HINT4---\n\.\.\.\n---FOLLOWUPS---\nQ: \.\.\.\nA: \.\.\./);
  assert.ok(p.indexOf('---FOLLOWUPS---') < p.indexOf('---CODE---'));
  assert.doesNotMatch(buildPrompt('solve', problem('Medium')), /FOLLOWUPS/);   // solution-only replies don't need them
});

test('follow-ups are read back as { q, a } pairs', () => {
  const reply = `---HINT4---\nedge cases\n---FOLLOWUPS---\nQ: What if the array is sorted?\nA: Use two pointers from both ends.\n` +
    `**Q:** What about a stream?\n**A:** Keep a hash map of seen values;\nstill O(n).\n1. Q: Return all pairs?\nA: Collect every match.\n---CODE---\n\`\`\`cpp\n\`\`\``;
  assert.deepEqual(parseFollowUps(reply), [
    { q: 'What if the array is sorted?', a: 'Use two pointers from both ends.' },
    { q: 'What about a stream?', a: 'Keep a hash map of seen values; still O(n).' },
    { q: 'Return all pairs?', a: 'Collect every match.' }
  ]);
  assert.deepEqual(parseFollowUps('no section here'), []);
});
