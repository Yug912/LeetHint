// Tests for interview follow-ups in live replies (contract item 2) and the
// "Report wrong hint" request (contract item 7) — run with: node --test tests/*.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';

const store = new Map([['installId', 'test-install']]);
globalThis.chrome = { storage: { local: {
  get: async k => (store.has(k) ? { [k]: store.get(k) } : {}),
  set: async o => { for (const [k, v] of Object.entries(o)) store.set(k, v); }
} } };

const { parseFollowUps, reportHint } = await import('../api/ai.js');

const reply = `---HINT1---
Think about complements.
---HINT4---
Watch out for [3,3].
---FOLLOWUPS---
Q: What if the array is sorted?
A: Use two pointers from both ends for O(1) extra space.
Q: What if there can be many answers?
A: Collect every pair; keep counts in the map.
Q: What if the numbers don't fit in memory?
A: Sort externally, then sweep
with two pointers.
---CODE---
\`\`\`cpp
class Solution {};
\`\`\``;

test('three Q/A pairs between Hint 4 and the code', () => {
  const f = parseFollowUps(reply);
  assert.equal(f.length, 3);
  assert.deepEqual(f[0], { q: 'What if the array is sorted?', a: 'Use two pointers from both ends for O(1) extra space.' });
  assert.equal(f[2].a, 'Sort externally, then sweep with two pointers.');   // wrapped line joined
});

test('numbered / bold variants still parse', () => {
  const f = parseFollowUps('---FOLLOWUPS---\n1. **Q:** Sorted input?\n**A:** Two pointers.\nQ2: Streams?\nA2: Hash set.\n---CODE---');
  assert.deepEqual(f, [{ q: 'Sorted input?', a: 'Two pointers.' }, { q: 'Streams?', a: 'Hash set.' }]);
});

test('older replies (no section) and questions without answers → nothing shown', () => {
  assert.deepEqual(parseFollowUps('---HINT1---\nx\n---CODE---\ncode'), []);
  assert.deepEqual(parseFollowUps('---FOLLOWUPS---\nQ: Only a question\n---CODE---'), []);
});

test('report: POST /v1/report with the contract body and install header', async () => {
  let req;
  globalThis.fetch = async (url, init) => { req = { url, init }; return new Response(null, { status: 204 }); };
  assert.equal(await reportHint({ slug: 'two-sum', promptVersion: 'p7', reason: 'wrong_hint' }), true);
  assert.match(req.url, /\/v1\/report$/);
  assert.equal(req.init.method, 'POST');
  assert.equal(req.init.headers['X-LeetHint-Install'], 'test-install');
  assert.deepEqual(JSON.parse(req.init.body), { slug: 'two-sum', promptVersion: 'p7', reason: 'wrong_hint' });
});

test('report: older Worker (404) or offline → false, no throw', async () => {
  globalThis.fetch = async () => new Response('Not found', { status: 404 });
  assert.equal(await reportHint({ slug: 'two-sum', reason: 'other' }), false);
  globalThis.fetch = async () => { throw new TypeError('offline'); };
  assert.equal(await reportHint({ slug: 'two-sum', reason: 'other' }), false);
});

test('report: unknown reason → other; note clipped to 500 chars', async () => {
  let body;
  globalThis.fetch = async (url, init) => { body = JSON.parse(init.body); return new Response(null, { status: 204 }); };
  await reportHint({ slug: 'two-sum', reason: 'spam', note: 'x'.repeat(900) });
  assert.equal(body.reason, 'other');
  assert.equal(body.note.length, 500);
});

// ── LeetCode changed its page (plan 5.3): only the slug is known ──
const { generateHints } = await import('../api/ai.js');
const { readFile } = await import('node:fs/promises');
const sample = JSON.parse(await readFile(new URL('./fixtures/cache/two-sum.json', import.meta.url), 'utf8'));

test('empty problem data: static hints still load by slug', async () => {
  const asked = [];
  globalThis.fetch = async url => { asked.push(String(url)); return Response.json(sample); };
  const h = await generateHints({ slug: 'two-sum', title: 'Two Sum', description: '' });
  assert.equal(h.source, 'static');
  assert.equal(asked.some(u => u.includes('/v1/generate')), false);
});

test('empty problem data and no file: a clear message, no AI call', async () => {
  const asked = [];
  globalThis.fetch = async url => { asked.push(String(url)); return new Response('Not found', { status: 404 }); };
  await assert.rejects(generateHints({ slug: 'new-problem', title: 'New Problem', description: '' }), /LeetCode changed its page/);
  assert.equal(asked.some(u => u.includes('/v1/generate')), false);
});

// ── B1 lookup order: local cache → static file → Worker ──
test('a static result is saved under hints_v3_<slug>, and the next visit fetches nothing', async () => {
  store.delete('hints_v3_two-sum');
  let asked = 0;
  globalThis.fetch = async () => { asked++; return Response.json(sample); };
  const problem = { slug: 'two-sum', title: 'Two Sum', description: 'Find two numbers.' };
  const first = await generateHints(problem);
  assert.equal(asked, 1);
  assert.deepEqual(store.get('hints_v3_two-sum'), first);
  let partials = 0;
  const again = await generateHints(problem, { onPartial: () => partials++ });
  assert.equal(asked, 1, 'no request at all on a repeat visit');
  assert.equal(again.hint1, first.hint1);
  assert.equal(partials, 1);
});
