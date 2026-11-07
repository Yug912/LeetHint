// Tests for the contest block and the weekly new-problem cron — run with: node --test tests/*.test.mjs
// LeetCode's GraphQL and the AI provider are simulated.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fakeD1 } from './helpers/fake-d1.mjs';

const NOW_S = Math.floor(Date.now() / 1000);
const NEWEST = [   // newest first, like questionList ordered by FRONTEND_ID DESC
  { questionFrontendId: '4105', titleSlug: 'live-contest-q', title: 'Live', difficulty: 'Hard', isPaidOnly: false, acRate: 10 },
  { questionFrontendId: '4104', titleSlug: 'premium-one', title: 'Paid', difficulty: 'Easy', isPaidOnly: true, acRate: 50 },
  { questionFrontendId: '4103', titleSlug: 'new-a', title: 'New A', difficulty: 'Medium', isPaidOnly: false, acRate: 40 },
  { questionFrontendId: '4102', titleSlug: 'new-b', title: 'New B', difficulty: 'Easy', isPaidOnly: false, acRate: 60 },
  { questionFrontendId: '4101', titleSlug: 'new-c', title: 'New C', difficulty: 'Hard', isPaidOnly: false, acRate: 20 }
];
let aiCalls = 0;

globalThis.fetch = async (url, init = {}) => {
  if (String(url).endsWith('/models')) return Response.json({ data: [{ id: 'openai/gpt-oss-120b' }] });
  if (String(url).includes('leetcode.com/graphql')) {
    const { query, variables } = JSON.parse(init.body);
    if (query.includes('topTwoContests')) {
      return Response.json({ data: { topTwoContests: [
        { titleSlug: 'weekly-contest-999', startTime: NOW_S - 600, duration: 5400 },     // running now
        { titleSlug: 'biweekly-contest-500', startTime: NOW_S + 86400, duration: 5400 }  // tomorrow
      ] } });
    }
    if (query.includes('contestQuestionList')) {
      return Response.json({ data: { contestQuestionList: variables.s === 'weekly-contest-999' ? [{ titleSlug: 'live-contest-q' }] : [] } });
    }
    if (query.includes('questionList')) return Response.json({ data: { questionList: { totalNum: 4105, data: NEWEST } } });
    const q = NEWEST.find(n => n.titleSlug === variables.titleSlug);
    return Response.json({ data: { question: { questionFrontendId: q.questionFrontendId, title: q.title, difficulty: q.difficulty,
      content: `<p>Solve ${q.title}.</p>`, hints: [], isPaidOnly: q.isPaidOnly, topicTags: [], codeSnippets: [] } } });
  }
  aiCalls++;
  return new Response('data: {"choices":[{"delta":{"content":"---HINT1--- ok"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');
};
const { default: worker, prefillNewProblems } = await import('../backend/src/index.js');
const env = { GROQ_API_KEY: 'test', PROVIDER_ORDER: 'groq', DB: fakeD1() };

test('no hints for a problem while its contest is running', async () => {
  const res = await worker.fetch(new Request('https://api.test/v1/generate', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'chrome-extension://test' },
    body: JSON.stringify({ action: 'hints', problem: { slug: 'live-contest-q', title: 'Live', difficulty: 'Hard', description: 'x' } })
  }), env, { waitUntil: () => {} });
  assert.equal(res.status, 403);
  assert.equal((await res.json()).error, 'contest_running');
  assert.equal(aiCalls, 0);
});

test('cron: the newest free, non-contest, uncached problems — at most 2 per run', async () => {
  const first = await prefillNewProblems(env);
  assert.deepEqual(first.generated, ['new-a', 'new-b']);
  const second = await prefillNewProblems(env);     // next run picks up where it stopped
  assert.deepEqual(second.generated, ['new-c']);
  const third = await prefillNewProblems(env);      // everything cached now
  assert.deepEqual(third.generated, []);
  assert.equal(aiCalls, 3);
  assert.equal(env.DB.db.prepare("SELECT COUNT(*) AS n FROM cache WHERE key LIKE '%:hints:new-%'").get().n, 3);
});
