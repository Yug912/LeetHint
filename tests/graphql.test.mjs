// Live check of LeetCode's GraphQL query (plan 5.3) — run before each release:
//   LEETHINT_LIVE=1 node --test tests/graphql.test.mjs        (PowerShell: $env:LEETHINT_LIVE=1; node --test tests/graphql.test.mjs)
// Skipped otherwise, so the normal test run never touches the network.
// The query is the same as fetchQuestionData() in content/content.js
// (content scripts can't be imported) — keep the two in step.
import { test } from 'node:test';
import assert from 'node:assert/strict';

const live = process.env.LEETHINT_LIVE === '1';

const QUERY = `query questionData($titleSlug: String!) {
    question(titleSlug: $titleSlug) {
      questionFrontendId title difficulty content hints
      topicTags { name }
      codeSnippets { langSlug code }
    }
  }`;

test('LeetCode GraphQL still returns what the extension reads (two-sum)', { skip: !live && 'set LEETHINT_LIVE=1 to run' }, async () => {
  const res = await fetch('https://leetcode.com/graphql', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Referer: 'https://leetcode.com/problems/two-sum/' },
    body: JSON.stringify({ query: QUERY, variables: { titleSlug: 'two-sum' } }),
    signal: AbortSignal.timeout(15000)
  });
  assert.equal(res.status, 200, `HTTP ${res.status}`);
  const q = (await res.json())?.data?.question;
  assert.ok(q, 'data.question is missing — the query or schema changed');
  assert.equal(q.questionFrontendId, '1');
  assert.equal(q.title, 'Two Sum');
  assert.equal(q.difficulty, 'Easy');
  assert.match(q.content, /nums/, 'content (statement HTML) is empty');
  assert.ok(q.topicTags.some(t => t.name === 'Hash Table'), 'topicTags changed');
  const cpp = q.codeSnippets.find(s => s.langSlug === 'cpp');
  assert.match(cpp?.code || '', /class Solution/, 'C++ snippet missing');
  assert.ok(q.codeSnippets.some(s => s.langSlug === 'python3'), 'python3 snippet missing');
});
