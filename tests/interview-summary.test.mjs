// Tests for cheaper interview turns (contract item 9, api/interview.js) —
// run with: node --test tests/*.test.mjs. The Worker is simulated.
import { test } from 'node:test';
import assert from 'node:assert/strict';

const store = new Map([['installId', 'test-install']]);
globalThis.chrome = { storage: { local: {
  get: async k => (store.has(k) ? { [k]: store.get(k) } : {}),
  set: async o => { for (const [k, v] of Object.entries(o)) store.set(k, v); },
  remove: async k => { store.delete(k); }
} } };

const { interviewerTurn, summarizeInterview, needsSummary, interviewPayload, codeForTurn, RECENT_TURNS } =
  await import('../api/interview.js');

const problem = { slug: 'two-sum', title: 'Two Sum', difficulty: 'Easy', description: 'Find two numbers that add up to target.' };
const reference = { code: 'class Solution { /* ~1 KB of reference code */ };'.padEnd(1000, ' '), approach: 'hash map', tc: 'O(n)', sc: 'O(n)', pattern: 'Hash Map' };
const sse = text => new Response(`data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\ndata: [DONE]\n\n`);

// A worker that knows interview_summary (newServer) or not (older Worker)
function worker({ newServer }) {
  const bodies = [];
  globalThis.fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    bodies.push({ raw: init.body, body });
    if (body.action === 'interview_summary') {
      return newServer ? sse('1. Candidate clarified duplicates.\n2. Proposed brute force O(n^2).\n3. Moved to a hash map.\n4. Coding.\n5. No hints yet.')
                       : Response.json({ error: 'Unknown action.' }, { status: 400 });
    }
    return sse('{"reply":"Good. What would you check next?","stage":"coding","hintGiven":false}');
  };
  return bodies;
}

function newSession(durationMin = 15) {
  return { interviewId: 'iv-123', durationMin, slug: 'two-sum', stage: 'coding', history: [], hintsGiven: 0, startedAt: Date.now() - 600000 };
}

// One interviewer + candidate exchange, like the side panel does
async function exchange(session, code) {
  session.history.push({ role: 'candidate', text: 'I think we can store each number and look for its complement as we scan. '.repeat(3) });
  const r = await interviewerTurn(problem, session, 'answer', { code, reference });
  session.history.push({ role: 'interviewer', text: r.reply + ' (turn ' + session.history.length + ')' });
  if (needsSummary(session)) await summarizeInterview(problem, session);
}

test('every turn carries interviewId and durationMin', () => {
  const p = interviewPayload(newSession(15), 'start', '', null);
  assert.equal(p.interviewId, 'iv-123');
  assert.equal(p.durationMin, 15);
});

test('new server: summary every 6 turns, then summary + last 4 turns; bodies < 6 KB after turn 10', async () => {
  const bodies = worker({ newServer: true });
  const session = newSession();
  const code = 'class Solution {\npublic:\n  vector<int> twoSum(vector<int>& nums, int target) {\n    unordered_map<int,int> seen;\n  }\n};';
  for (let i = 0; i < 12; i++) await exchange(session, code);
  const summaries = bodies.filter(b => b.body.action === 'interview_summary');
  assert.equal(summaries.length, 2);                         // after turns 6 and 12
  assert.equal(summaries[0].body.interview.interviewId, 'iv-123');
  const turns = bodies.filter(b => b.body.action === 'interview_turn');
  const late = turns.slice(10);
  for (const t of late) {
    assert.ok(t.body.interview.summary, 'summary sent');
    assert.ok(t.body.interview.history.length <= RECENT_TURNS);
    assert.ok(t.raw.length < 6000, `body is ${t.raw.length} bytes`);
  }
  // Code unchanged since it was last sent → not sent again
  assert.equal(late.at(-1).body.interview.code, '');
});

test('code is sent again once it changes meaningfully', () => {
  const s = { summary: 'x', lastSentCode: 'int a = 1;' };
  assert.equal(codeForTurn(s, 'int a = 1;  '), '');
  assert.equal(codeForTurn(s, 'int a = 1;\nfor (int i = 0; i < n; i++) total += nums[i];'), 'int a = 1;\nfor (int i = 0; i < n; i++) total += nums[i];');
});

test('older server (no interview_summary): full transcript and code every turn, asked once only', async () => {
  const bodies = worker({ newServer: false });
  const session = newSession(30);
  for (let i = 0; i < 13; i++) await exchange(session, 'class Solution {};');
  assert.equal(bodies.filter(b => b.body.action === 'interview_summary').length, 1);
  const last = bodies.filter(b => b.body.action === 'interview_turn').at(-1).body.interview;
  assert.equal(last.summary, undefined);
  assert.equal(last.history.length, session.history.length - 1);   // everything before this reply
  assert.equal(last.code, 'class Solution {};');
});
