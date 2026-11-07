// D1 → static file export (A15) and follow-up parsing — run with: node --test tests/*.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readAnswerStream, parseHintsReply, parseFollowUps } from '../api/ai.js';
import { slugOfKey, toStaticFile } from '../tools/export-d1.mjs';
import { PROMPT_VERSION } from '../shared/prompts.js';

export const REPLY = `---APPROACH---
Store each value's index; for every number look up target minus it.
---TC---
O(n)
---SC---
O(n)
---SC_BREAKDOWN---
- unordered_map seen: up to n entries → O(n)
---PATTERN---
Hash Map
---HINT1---
What do you need to know about earlier numbers?
---HINT2---
Use a hash map from value to index.
---HINT3---
for i, x: if target - x seen → return
---HINT4---
**Duplicates** — [3,3], target 6
---FOLLOWUPS---
Q: What if the array is sorted?
A: Use two pointers from both ends for O(1) extra space.
Q: What if there are many queries?
A: Keep the map built once and answer each in O(1).
Q: What if the numbers don't fit in memory?
A: Sort externally and stream two pointers over the file.
---CODE---
\`\`\`cpp
class Solution {
public:
    vector<int> twoSum(vector<int>& nums, int target) { return {}; }
};
\`\`\`
---END---`;

const sse = text => text.match(/[\s\S]{1,40}/g).map(p => `data: ${JSON.stringify({ choices: [{ delta: { content: p } }] })}\n\n`).join('') + 'data: [DONE]\n\n';

test('follow-ups parse into exactly 3 { q, a } pairs', () => {
  const f = parseFollowUps(REPLY);
  assert.equal(f.length, 3);
  assert.deepEqual(f[0], { q: 'What if the array is sorted?', a: 'Use two pointers from both ends for O(1) extra space.' });
  assert.deepEqual(parseFollowUps('---HINT1---\nx\n---CODE---'), []);
});

test('a cached SSE reply becomes a contract-shaped static file', async () => {
  const text = await readAnswerStream(new Response(sse(REPLY)), 'openai');
  const file = toStaticFile({ slug: 'two-sum', title: 'Two Sum', difficulty: 'Easy' }, parseHintsReply(text), '2026-11-23');
  assert.deepEqual(Object.keys(file), ['slug', 'title', 'difficulty', 'promptVersion', 'generatedAt', 'pattern', 'tc', 'sc',
                                       'spaceBreakdown', 'approach', 'hints', 'followUps', 'code', 'verified']);
  assert.equal(file.pattern, 'Hash Map');
  assert.equal(file.tc, 'O(n)');
  assert.equal(file.hints.length, 4);
  assert.equal(file.hints[3], '**Duplicates** - [3,3], target 6');   // dashes normalised, as in the panel
  assert.equal(file.followUps.length, 3);
  assert.match(file.code.cpp, /^class Solution \{[\s\S]*twoSum/);
  assert.equal(file.approach, "Store each value's index; for every number look up target minus it.");
});

test('only plain hints keys of the current prompt version are exported', () => {
  const h = 'a'.repeat(64);
  assert.equal(slugOfKey(`${PROMPT_VERSION}:hints:two-sum:${h}`), 'two-sum');
  assert.equal(slugOfKey(`${PROMPT_VERSION}:hints-python3:two-sum:${h}`), '');
  assert.equal(slugOfKey(`p1:hints:two-sum:${h}`), '');
  assert.equal(slugOfKey(`${PROMPT_VERSION}:fix-signature:two-sum:${h}`), '');
});
