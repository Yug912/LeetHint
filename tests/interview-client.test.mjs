// Cheaper interviews, client half (B9) — run with: node --test tests/*.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installFakeChrome } from './helpers/fake-chrome.mjs';

installFakeChrome();
const { interviewPayload, summaryDue, summarise, codeWorthSending, SUMMARY_EVERY } = await import('../api/interview.js');

const turn = (role, i) => ({ role, text: `${role} says something meaningful number ${i}`.repeat(4), at: i });
function sessionWith(n, extra = {}) {
  const history = [];
  for (let i = 0; i < n; i++) history.push(turn(i % 2 ? 'candidate' : 'interviewer', i));
  return { interviewId: 'aaaaaaaa-aaaa-4aaa-8aaa-000000000001', durationMin: 15, stage: 'approach', startedAt: Date.now() - 6e5,
           hintsGiven: 0, history, starterCode: 'class Solution {\npublic:\n    int f() {\n    }\n};', ...extra };
}

test('every turn carries interviewId and durationMin', () => {
  const p = interviewPayload(sessionWith(3), 'answer', '');
  assert.equal(p.interviewId, 'aaaaaaaa-aaaa-4aaa-8aaa-000000000001');
  assert.equal(p.durationMin, 15);
  assert.equal(p.history.length, 3);
  assert.equal(p.summary, undefined);
});

test('with a summary: only the last 4 turns go, and bodies stay under ~6 KB after turn 10', () => {
  const s = sessionWith(24, { summary: '1. a\n2. b\n3. c\n4. d\n5. e'.repeat(20) });
  const p = interviewPayload(s, 'answer', '');
  assert.equal(p.history.length, 4);
  assert.ok(p.summary.length <= 1500);
  assert.ok(JSON.stringify(p).length < 6000, `payload is ${JSON.stringify(p).length} bytes`);
  // The scorecard still gets everything
  assert.equal(interviewPayload(s, 'answer', '', null, { full: true }).history.length, 24);
});

test('editor code is sent once it changed from the template, or when code is being judged', () => {
  const s = sessionWith(2);
  assert.equal(codeWorthSending(s, s.starterCode), false);
  assert.equal(interviewPayload(s, 'answer', s.starterCode).code, '');
  const written = s.starterCode.replace('    }', '        return 42 * helper(nums, target, memo);\n    }');
  assert.equal(codeWorthSending(s, written), true);
  assert.equal(codeWorthSending({ ...s, stage: 'testing' }, s.starterCode), true);
});

test('a summary is due every 6 interviewer turns and folds in only the new turns', async () => {
  assert.equal(SUMMARY_EVERY, 6);
  const s = sessionWith(12);                       // 6 interviewer turns
  assert.equal(summaryDue(s), true);
  let sent;
  globalThis.fetch = async (url, init) => {
    sent = JSON.parse(init.body);
    return new Response(`data: ${JSON.stringify({ choices: [{ delta: { content: '1. x\n2. x\n3. x\n4. x\n5. x' }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`);
  };
  const next = await summarise({ slug: 'two-sum', title: 'Two Sum' }, s);
  assert.equal(sent.action, 'interview_summary');
  assert.equal(sent.interview.history.length, 12);
  assert.deepEqual(next, { summary: '1. x\n2. x\n3. x\n4. x\n5. x', summaryAt: 6, summaryUpTo: 12 });
  Object.assign(s, next);
  assert.equal(summaryDue(s), false);
  s.history.push(...sessionWith(12).history);      // 6 more interviewer turns
  assert.equal(summaryDue(s), true);
  await summarise({ slug: 'two-sum', title: 'Two Sum' }, s);
  assert.equal(sent.interview.history.length, 12);   // only the turns since the last summary
  assert.match(sent.interview.summary, /^1\. x/);
});

// Ending early (15 min is the limit, not a target): a fast candidate who has
// covered everything gets the scorecard instead of recycled questions.
const { interviewerTurn, overstaying, MAX_COMPLEXITY_TURNS, MAX_TESTING_TURNS } = await import('../api/interview.js');
const replies = list => {
  let i = 0;
  globalThis.fetch = async () => new Response(`data: ${JSON.stringify({ choices: [{ delta: { content: JSON.stringify(list[Math.min(i++, list.length - 1)]) }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`);
};
const lateSession = (stage, history) => ({ interviewId: 'aaaaaaaa-aaaa-4aaa-8aaa-000000000002', durationMin: 15, stage,
  startedAt: Date.now() - 4 * 60000, hintsGiven: 0, history });
const twoSum = { slug: 'two-sum', title: 'Two Sum', difficulty: 'Easy', description: 'Return indices of two numbers adding to target.' };

test('end early: a question repeated twice after testing ends the interview with the scorecard', async () => {
  const asked = 'How would your solution change if the array were already sorted in ascending order?';
  const s = lateSession('complexity', [
    { role: 'interviewer', text: asked, stage: 'complexity' }, { role: 'candidate', text: 'Two pointers from both ends, O(1) space.', stage: 'complexity' }]);
  replies([{ reply: asked, stage: 'complexity', hintGiven: false }]);
  const r = await interviewerTurn(twoSum, s, 'answer', { code: '' });
  assert.equal(r.stage, 'feedback');
  assert.match(r.reply, /scorecard is ready/);
});

test('end early: past the follow-up limit in the complexity stage, the next turn wraps up', async () => {
  const history = [];
  for (let i = 0; i < MAX_COMPLEXITY_TURNS; i++) {
    history.push({ role: 'interviewer', text: `Distinct follow-up question number ${i} about memory limits and variants`, stage: 'complexity' },
                 { role: 'candidate', text: `answer ${i}`, stage: 'complexity' });
  }
  const s = lateSession('complexity', history);
  assert.equal(overstaying(s), true);
  replies([{ reply: 'What if the numbers were streamed in one at a time from a network socket?', stage: 'complexity', hintGiven: false }]);
  const r = await interviewerTurn(twoSum, s, 'answer', { code: '' });
  assert.equal(r.stage, 'feedback');
});

test('end early: the normal flow is untouched (new follow-up within the limit, earlier stages)', async () => {
  const s = lateSession('complexity', [{ role: 'interviewer', text: 'What is the time and space complexity of your code?', stage: 'complexity' },
                                       { role: 'candidate', text: 'O(n) time and O(n) space.', stage: 'complexity' }]);
  assert.equal(overstaying(s), false);
  replies([{ reply: 'Right. What if you could not use extra memory at all?', stage: 'complexity', hintGiven: false }]);
  const r = await interviewerTurn(twoSum, s, 'answer', { code: '' });
  assert.equal(r.stage, 'complexity');
  assert.match(r.reply, /extra memory/);
  // Older sessions without stage tags never trip the limit
  assert.equal(overstaying(lateSession('complexity', sessionWith(20).history)), false);
});

test('stuck in testing: a repeated trace request, or too many testing turns, moves on to complexity', async () => {
  const ask = 'Walk me through nums = [-3, 4, 3, 90] with target 0 and tell me which indices your code returns.';
  const s = lateSession('testing', [{ role: 'interviewer', text: ask, stage: 'testing' }, { role: 'candidate', text: 'It returns [0,1] for [2,7,11,15].', stage: 'testing' }]);
  replies([{ reply: ask, stage: 'testing', hintGiven: false }]);
  let r = await interviewerTurn(twoSum, s, 'answer', { code: '' });
  assert.equal(r.stage, 'complexity');
  assert.match(r.reply, /time and space complexity/);

  const history = [];
  for (let i = 0; i < MAX_TESTING_TURNS; i++) {
    history.push({ role: 'interviewer', text: `Trace distinct example number ${i} with different values please`, stage: 'testing' },
                 { role: 'candidate', text: `trace ${i}`, stage: 'testing' });
  }
  replies([{ reply: 'Now try an array where every value is negative and the target is minus ten.', stage: 'testing', hintGiven: false }]);
  r = await interviewerTurn(twoSum, lateSession('testing', history), 'answer', { code: '' });
  assert.equal(r.stage, 'complexity');
});

test('end early: the prompt says time is a limit, not a target', async () => {
  const { buildInterviewTurnPrompt, buildInterviewSummaryPrompt } = await import('../shared/prompts.js');
  const p = buildInterviewTurnPrompt(twoSum, { event: 'answer', durationMin: 15, stage: 'complexity', history: [] });
  assert.match(p, /ends when the work is done, not when the clock runs out/);
  assert.match(p, /FINISH EARLY/);
  assert.match(p, /AT MOST two follow-up questions/);
  assert.match(buildInterviewSummaryPrompt(twoSum, { history: [] }), /EVERY question the interviewer has already asked/);
});
