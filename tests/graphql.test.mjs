// LeetCode GraphQL smoke test (B16) — LIVE: runs only with LEETHINT_LIVE=1
//   LEETHINT_LIVE=1 node --test tests/graphql.test.mjs
// Run before each release: if LeetCode changed its API, this fails first.
import { test } from 'node:test';
import assert from 'node:assert/strict';

const live = process.env.LEETHINT_LIVE === '1';

test('the questionData query the extension uses still returns two-sum', { skip: !live && 'set LEETHINT_LIVE=1 to run' }, async () => {
  // The exact query from content/content.js (fetchQuestionData)
  const query = `query questionData($titleSlug: String!) {
    question(titleSlug: $titleSlug) {
      questionFrontendId title difficulty content hints
      topicTags { name }
      codeSnippets { langSlug code }
    }
  }`;
  const res = await fetch('https://leetcode.com/graphql', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Referer: 'https://leetcode.com/problems/two-sum/' },
    body: JSON.stringify({ query, variables: { titleSlug: 'two-sum' } })
  });
  assert.equal(res.status, 200);
  const q = (await res.json()).data?.question;
  assert.equal(q.questionFrontendId, '1');
  assert.equal(q.title, 'Two Sum');
  assert.equal(q.difficulty, 'Easy');
  assert.match(q.content, /<p>/);
  assert.ok(q.topicTags.some(t => t.name === 'Hash Table'));
  assert.ok(q.codeSnippets.some(s => s.langSlug === 'cpp' && /class Solution/.test(s.code)));
});
