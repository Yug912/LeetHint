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
