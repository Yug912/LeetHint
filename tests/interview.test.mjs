// Tests for the mock interview guards — run with: node --test tests/*.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { leakedTerms, repeatsEarlier, parseInterviewerReply } from '../api/interview.js';
import { buildInterviewTurnPrompt } from '../shared/prompts.js';

const problem = { title: 'Two Sum', description: 'Return indices of the two numbers that add up to target.' };
const reference = { pattern: 'Hash Map', approach: 'one pass', code: '', tc: 'O(n)', sc: 'O(n)' };
const candidate = text => ({ role: 'candidate', text });
const interviewer = text => ({ role: 'interviewer', text });


test('leak: naming the technique the candidate never said', () => {
  const reply = 'You could keep a map of numbers you have seen, then look up the complement.';
  assert.deepEqual(leakedTerms(reply, { problem, history: [candidate('I will use two loops.')], reference }), ['map', 'complement']);
});

test('leak: echoing the candidate\'s own words is fine', () => {
  const history = [candidate('I will use a hash map from value to index.')];
  assert.deepEqual(leakedTerms('Sounds good, what does the hash map cost in space?', { problem, history, reference }), []);
});

test('leak: words from the problem statement are fine', () => {
  const p = { title: 'Sliding Window Maximum', description: 'A window of size k moves along the array.' };
  assert.deepEqual(leakedTerms('What happens when the window moves by one?', { problem: p, history: [], reference: {} }), []);
});

test('leak: the reference pattern name counts, generic topics do not', () => {
  const ref = { pattern: "Kadane's Algorithm" };
  assert.deepEqual(leakedTerms("Have you heard of Kadane's algorithm?", { problem, history: [], reference: ref }), ["Kadane's algorithm"]);
  assert.deepEqual(leakedTerms('Think about the array as a whole.', { problem, history: [], reference: { pattern: 'Array' } }), []);
});

test('leak: a nudge without names passes', () => {
  const reply = 'What work does your inner loop repeat for every element?';
  assert.deepEqual(leakedTerms(reply, { problem, history: [candidate('two nested loops')], reference }), []);
});

test('repeat: same question again is caught, a new one is not', () => {
  const history = [interviewer('Could you walk me through how your code handles amount 3 with coins [2]?')];
  assert.equal(repeatsEarlier('Could you walk me through how your code handles amount 3 with coins [2]?', history), true);
  assert.equal(repeatsEarlier('What is the space complexity of your solution?', history), false);
  assert.equal(repeatsEarlier('Okay.', history), false);   // too short to judge
});

test('stage only moves forward', () => {
  const r = parseInterviewerReply('{"reply":"Let us code.","stage":"approach","hintGiven":false}', 'testing');
  assert.equal(r.stage, 'testing');
});

test('prompt: 30-minute interview, pacing follows the length', () => {
  const p = buildInterviewTurnPrompt({ title: 'T', description: 'x' }, { event: 'answer', elapsedSec: 600 });
  assert.match(p, /30-minute coding interview/);
  assert.match(p, /10 of 30 minutes used/);
  assert.match(p, /reach coding by ~11 min and finish coding by ~23 min/);
  assert.match(p, /after ~14 minutes, let them code/);
});

test('prompt: hint ladder and rejected draft are included', () => {
  const p = buildInterviewTurnPrompt({ title: 'Two Sum', description: 'x' },
    { event: 'answer', stage: 'approach', hintsGiven: 1, rejected: { reason: 'leak', draft: 'use a hash map' } });
  assert.match(p, /HINT LADDER/);
  assert.match(p, /a new hint now would be hint 2/);
  assert.match(p, /PREVIOUS DRAFT WAS REJECTED[\s\S]*use a hash map/);
  assert.doesNotMatch(buildInterviewTurnPrompt({ title: 'T', description: 'x' }, { event: 'answer' }), /REJECTED/);
});
