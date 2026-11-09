// Monday refresh (A15): only uncached, non-contest problems are generated — run with: node --test tests/*.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fakeD1 } from './helpers/fake-d1.mjs';
import { refreshNewProblems } from '../backend/src/refresh.js';
import { buildPrompt, PROMPT_VERSION } from '../shared/prompts.js';
import { writeCache } from '../backend/src/store.js';
import { createHash } from 'node:crypto';

const NOW = Date.UTC(2026, 10, 23, 6);
const problems = ['new-a', 'new-b', 'premium-c', 'contest-d', 'cached-e'];
const question = slug => ({ questionFrontendId: '4000', title: slug, difficulty: 'Medium', content: `<p>Solve ${slug}.</p>`, hints: [], topicTags: [{ name: 'Array' }], codeSnippets: [{ langSlug: 'cpp', code: 'class Solution {};' }] });
let generatedFor = [];
let contestList = [{ titleSlug: 'contest-d' }];

globalThis.fetch = async (url, init) => {
  const u = String(url);
  if (u.includes('leetcode.com/graphql')) {
    const { query, variables } = JSON.parse(init.body);
    if (query.includes('topTwoContests')) return Response.json({ data: { topTwoContests: [
      { titleSlug: 'weekly-contest-530', startTime: NOW / 1000 - 600, duration: 5400 },        // running
      { titleSlug: 'biweekly-contest-196', startTime: NOW / 1000 + 86400, duration: 5400 }] } });
    if (query.includes('contestQuestionList')) return Response.json({ data: { contestQuestionList: contestList } });
    if (query.includes('questionList')) return Response.json({ data: { questionList: { totalNum: 3900,
      data: problems.map(s => ({ titleSlug: s, isPaidOnly: s.startsWith('premium') })) } } });
    return Response.json({ data: { question: question(variables.titleSlug) } });
  }
  if (u.endsWith('/models')) return Response.json({ data: [{ id: 'openai/gpt-oss-120b' }] });
  generatedFor.push(JSON.parse(init.body).messages[0].content.match(/"(\S+)" \(Medium\)/)[1]);
  return new Response('data: {"choices":[{"delta":{"content":"---HINT1--- ok"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');
};

test('generates only uncached problems outside a live contest, under the user cache key', async () => {
  const env = { GROQ_API_KEY: 't', PROVIDER_ORDER: 'groq', DB: fakeD1() };
  const { htmlToText } = await import('../shared/html-text.js');
  const p = { slug: 'cached-e', title: 'cached-e', problemNumber: '4000', difficulty: 'Medium', description: htmlToText('<p>Solve cached-e.</p>'),
              cppSnippet: 'class Solution {};', topicTags: ['Array'], officialHints: [] };
  const key = `${PROMPT_VERSION}:hints:cached-e:${createHash('sha256').update(buildPrompt('hints', p)).digest('hex')}`;
  await writeCache(env, key, 'old', 'openai', NOW);
  const out = await refreshNewProblems(env, { now: NOW });
  assert.deepEqual(out.generated, ['new-a', 'new-b']);
  assert.deepEqual(out.cached, ['cached-e']);
  assert.deepEqual(out.skipped, ['contest-d']);            // premium ones never make the list
  assert.deepEqual(generatedFor, ['new-a', 'new-b']);
  assert.equal(env.DB.db.prepare("SELECT COUNT(*) AS n FROM cache WHERE key LIKE ?").get(`${PROMPT_VERSION}:hints:new-a:%`).n, 1);
});

test('a live contest whose problem list comes back empty skips the whole run', async () => {
  contestList = [];
  generatedFor = [];
  await assert.rejects(refreshNewProblems({ GROQ_API_KEY: 't', PROVIDER_ORDER: 'groq', DB: fakeD1() }, { now: NOW }), /contest is live/);
  assert.deepEqual(generatedFor, []);
  contestList = [{ titleSlug: 'contest-d' }];
});

test('cron runs (limit 1) generate one problem each, starting at a different place, skipping cached ones', async () => {
  const { runIndex } = await import('../backend/src/refresh.js');
  assert.equal(runIndex(Date.UTC(2026, 10, 23, 6, 0)), 0);
  assert.equal(runIndex(Date.UTC(2026, 10, 23, 6, 10)), 1);
  assert.equal(runIndex(Date.UTC(2026, 10, 23, 8, 50)), 17);
  const env = { GROQ_API_KEY: 't', PROVIDER_ORDER: 'groq', DB: fakeD1() };
  generatedFor = [];
  const run = async minutes => refreshNewProblems(env, { now: Date.UTC(2026, 10, 30, 6, minutes), limit: 1 });
  // a week after NOW no contest is live, so contest-d is a normal problem here
  const first = await run(10);                      // run 1 starts at new-b
  assert.deepEqual(first.generated, ['new-b']);
  const second = await run(0);                      // run 0 starts at new-a
  assert.deepEqual(second.generated, ['new-a']);
  const third = await run(10);                      // new-b now cached → next one
  assert.deepEqual(third.cached, ['new-b']);
  assert.equal(third.generated.length, 1);
  assert.deepEqual(generatedFor.slice(0, 2), ['new-b', 'new-a']);
});
