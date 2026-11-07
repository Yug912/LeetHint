// Tests for the cheaper interview requests (summary + recent turns) — run
// with: node --test tests/*.test.mjs. The server is faked.
import { test } from 'node:test';
import assert from 'node:assert/strict';

const store = {};
globalThis.chrome = { storage: { local: {
  get: async k => ({ [k]: store[k] }), set: async o => Object.assign(store, o), remove: async () => {}
} } };
const sent = [];
globalThis.fetch = async (url, init) => {
  if (String(url).endsWith('/v1/generate')) {
    const body = JSON.parse(init.body);
    sent.push({ body, bytes: init.body.length });
    const text = body.action === 'interview_summary'
      ? '1. Coding.\n2. Hash map idea, correct.\n3. O(n) time stated.\n4. One hint about repeated work.\n5. Check duplicates.'
      : '{"reply":"Okay, keep going.","stage":"coding","hintGiven":false}';
    return new Response(`data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`);
  }
  return new Response('', { status: 404 });
};
const { interviewPayload, needsSummary, summarizeInterview, interviewerTurn } = await import('../api/interview.js');

const problem = { slug: 'two-sum', title: 'Two Sum', difficulty: 'Easy', description: 'd' };
const CODE = 'class Solution {\npublic:\n    vector<int> twoSum(vector<int>& nums, int target) {\n        unordered_map<int,int> seen;\n        for (int i = 0; i < nums.size(); i++) {\n            if (seen.count(target - nums[i])) return {seen[target - nums[i]], i};\n            seen[nums[i]] = i;\n        }\n        return {};\n    }\n};';
const REF = { code: CODE, approach: 'One pass with a hash map.', tc: 'O(n)', sc: 'O(n)', pattern: 'Hash map' };

function sessionWithTurns(n, stage = 'coding') {
  const history = [];
  for (let i = 0; i < n; i++) {
    history.push({ role: 'interviewer', text: `Question ${i}: ${'tell me more about how your approach handles this case and why it works. '.repeat(2)}` });
    history.push({ role: 'candidate', text: `Answer ${i}: ${'I would keep a map of what I have seen and check the complement for each element in turn. '.repeat(2)}` });
  }
  return { slug: 'two-sum', interviewId: '6f1c2a4e-1b2c-4d3e-9f00-123456789abc', durationMin: 15, trial: true,
           startedAt: Date.now() - 600_000, stage, history, hintsGiven: 1 };
}

test('payload: interview ID and length always; editor code only once coding starts', () => {
  const early = interviewPayload(sessionWithTurns(1, 'approach'), 'answer', CODE, REF);
  assert.equal(early.interviewId, '6f1c2a4e-1b2c-4d3e-9f00-123456789abc');
  assert.equal(early.durationMin, 15);
  assert.equal(early.code, '');
  assert.equal(interviewPayload(sessionWithTurns(1, 'coding'), 'answer', CODE, REF).code, CODE);
  assert.equal(interviewPayload(sessionWithTurns(1, 'approach'), 'code', CODE, REF).code, CODE);
});

test('summary every few turns: later requests send it + only recent turns, under ~6 KB at turn 10+', async () => {
  const s = sessionWithTurns(10);                     // 20 spoken turns
  assert.equal(needsSummary(s), true);
  const done = await summarizeInterview(problem, s);
  assert.equal(done.summaryUpTo, 16);                 // all but the last 4
  assert.match(done.summary, /^1\. Coding\./);
  const sumReq = sent.find(r => r.body.action === 'interview_summary');
  assert.equal(sumReq.body.interview.history.length, 16);
  Object.assign(s, done);
  assert.equal(needsSummary(s), false);

  const p = interviewPayload(s, 'answer', CODE, REF);
  assert.equal(p.history.length, 4);
  assert.equal(p.summary, done.summary);

  await interviewerTurn(problem, s, 'answer', { code: CODE, reference: REF });
  const turn = sent.at(-1);
  assert.equal(turn.body.action, 'interview_turn');
  assert.ok(turn.bytes < 6000, `turn request was ${turn.bytes} bytes`);

  // Without the summary the same turn would be far bigger
  const fullBytes = JSON.stringify({ interview: interviewPayload({ ...s, summary: '', summaryUpTo: 0 }, 'answer', CODE, REF) }).length;
  assert.ok(fullBytes > turn.bytes * 1.5, `${fullBytes} vs ${turn.bytes}`);
});

test('an older server without interview_summary: no summary, turns keep their history', async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => Response.json({ error: 'Unknown action.' }, { status: 400 });
  try {
    assert.equal(await summarizeInterview(problem, sessionWithTurns(10)), null);
  } finally {
    globalThis.fetch = realFetch;
  }
});
