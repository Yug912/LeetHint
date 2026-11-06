// Tests for reading pre-generated hint files (api/static.js) — run with: node --test tests/*.test.mjs
// fetch is simulated; the sample file is tests/fixtures/cache/two-sum.json (contract item 1).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fetchStaticHints, mapStaticFile, isValidStaticFile } from '../api/static.js';

const sample = JSON.parse(await readFile(new URL('./fixtures/cache/two-sum.json', import.meta.url), 'utf8'));
const serve = (status, body) => async () => new Response(typeof body === 'string' ? body : JSON.stringify(body), { status });

test('file → the hints object the side panel uses', () => {
  const h = mapStaticFile(sample);
  assert.equal(h.hint1, sample.hints[0]);
  assert.equal(h.hint4, sample.hints[3]);
  assert.ok(h.hint5.startsWith('```cpp\nclass Solution {'));
  assert.match(h.hint5, /\n```\nApproach: Walk the array once.* · TC O\(n\) · SC O\(n\)$/);
  assert.equal(h.optimal_tc, 'O(n)');
  assert.equal(h.optimal_sc, 'O(n)');
  assert.equal(h.sc_breakdown, sample.spaceBreakdown);
  assert.equal(h.pattern, 'Hash Map');
  assert.deepEqual(Object.keys(h.translations).sort(), ['java', 'javascript', 'python3']);
  assert.equal(h.followUps.length, 3);
  assert.equal(h.source, 'static');
  assert.equal(h.promptVersion, 'p7');
});

test('fetches <base>/cache/<slug>.json', async () => {
  let asked = '';
  const h = await fetchStaticHints('Two-Sum', { baseUrl: 'https://c.test', fetchImpl: async url => { asked = url; return Response.json(sample); } });
  assert.equal(asked, 'https://c.test/cache/two-sum.json');
  assert.equal(h.source, 'static');
});

test('404, server error, bad JSON, network error, timeout → null (Worker path)', async () => {
  const o = { baseUrl: 'https://c.test' };
  assert.equal(await fetchStaticHints('two-sum', { ...o, fetchImpl: serve(404, 'Not found') }), null);
  assert.equal(await fetchStaticHints('two-sum', { ...o, fetchImpl: serve(500, '') }), null);
  assert.equal(await fetchStaticHints('two-sum', { ...o, fetchImpl: serve(200, '<html>') }), null);
  assert.equal(await fetchStaticHints('two-sum', { ...o, fetchImpl: async () => { throw new TypeError('offline'); } }), null);
  const hang = (url, { signal }) => new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason)));
  assert.equal(await fetchStaticHints('two-sum', { ...o, timeoutMs: 50, fetchImpl: hang }), null);
});

test('incomplete or mismatched files are not used', () => {
  assert.ok(isValidStaticFile(sample, 'two-sum'));
  assert.equal(isValidStaticFile(sample, 'three-sum'), false);
  assert.equal(isValidStaticFile({ ...sample, hints: sample.hints.slice(0, 3) }, 'two-sum'), false);
  assert.equal(isValidStaticFile({ ...sample, code: { python3: 'x' } }, 'two-sum'), false);
  assert.equal(isValidStaticFile({ ...sample, tc: '' }, 'two-sum'), false);
});

test('an older promptVersion is still used', async () => {
  const h = await fetchStaticHints('two-sum', { baseUrl: 'https://c.test', fetchImpl: async () => Response.json({ ...sample, promptVersion: 'p5' }) });
  assert.equal(h.promptVersion, 'p5');
});

test('bad follow-ups are dropped, not shown', () => {
  const h = mapStaticFile({ ...sample, followUps: [{ q: 'ok?', a: 'yes' }, { q: '' }, 'junk'] });
  assert.deepEqual(h.followUps, [{ q: 'ok?', a: 'yes' }]);
});
