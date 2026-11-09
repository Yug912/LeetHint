// Two live-test findings (2026-11-09) — run with: node --test tests/*.test.mjs
//  1. a reply whose only code fence is Hint 3's pseudocode must not become "the solution"
//  2. a slow reply that keeps streaming is not cut off; a stalled one is
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installFakeChrome } from './helpers/fake-chrome.mjs';

installFakeChrome();
const ai = await import('../api/ai.js');
const { CACHE_URL } = await import('../api/config.js');

const sse = text => `data: ${JSON.stringify({ choices: [{ delta: { content: text }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`;
const problem = { slug: 'count-valid-suffix-sorts-ii', title: 'X', difficulty: 'Hard', description: 'x', cppSnippet: 'class Solution {\npublic:\n    vector<int> countSorts(vector<int>& nums) {\n        \n    }\n};' };
const PSEUDO = '---APPROACH---\nA.\n---TC---\nO(n)\n---SC---\nO(n)\n---PATTERN---\nZ\n---HINT1---\na\n---HINT2---\nb\n---HINT3---\n```\ncompute Z on nums#target\nfor i = 0 .. n-1:\n    FT.add(k, 1)\n```\n---HINT4---\nd\n---CODE---\n(none)\n---END---';
const CODE = 'class Solution {\npublic:\n    vector<int> countSorts(vector<int>& nums) {\n        return {};\n    }\n};';
const SOLVE = `---APPROACH---\nB.\n---TC---\nO(n)\n---SC---\nO(n)\n---CODE---\n\`\`\`cpp\n${CODE}\n\`\`\`\n---END---`;

test('looksLikeCpp: real code yes, pseudocode no', () => {
  assert.equal(ai.looksLikeCpp(CODE), true);
  assert.equal(ai.looksLikeCpp('compute Z on nums\nfor i = 0 .. n-1:\n    FT.add(k, 1)'), false);
  assert.equal(ai.looksLikeCpp(''), false);
});

test('pseudocode-only reply → the solution is requested separately, never shown as code', async () => {
  const actions = [];
  globalThis.fetch = async (url, init = {}) => {
    if (String(url).startsWith(CACHE_URL)) return new Response('', { status: 404 });
    const { action } = JSON.parse(init.body);
    actions.push(action);
    return new Response(sse(action === 'hints' ? PSEUDO : SOLVE));
  };
  const h = await ai.generateHints(problem);
  assert.deepEqual(actions, ['hints', 'solve']);
  assert.equal(h.solution.code, CODE);
  assert.doesNotMatch(h.hint5, /compute Z/);
});

// A body that sends `pieces` with `gapMs` between them
function slowBody(pieces, gapMs) {
  const enc = new TextEncoder();
  return new ReadableStream({
    async start(c) {
      for (const p of pieces) { await new Promise(r => setTimeout(r, gapMs)); c.enqueue(enc.encode(p)); }
      c.close();
    }
  });
}

test('a slow reply that keeps streaming finishes, even past the old fixed limit', async () => {
  const saved = { ...ai.TIMEOUTS };
  Object.assign(ai.TIMEOUTS, { headersMs: 200, idleMs: 120, totalMs: 2000 });
  try {
    const parts = sse(SOLVE).match(/[\s\S]{1,40}/g);   // ~10 chunks, 60 ms apart ≈ 600 ms > idleMs
    globalThis.fetch = async () => new Response(slowBody(parts, 60));
    const text = await ai.route('solve', problem);
    assert.match(text, /class Solution/);
  } finally { Object.assign(ai.TIMEOUTS, saved); }
});

test('a reply that stops streaming is given up with a clear message', async () => {
  const saved = { ...ai.TIMEOUTS };
  Object.assign(ai.TIMEOUTS, { headersMs: 200, idleMs: 100, totalMs: 2000 });
  try {
    globalThis.fetch = async (url, init) => new Response(new ReadableStream({
      start(c) { c.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"---HINT1---"}}]}\n\n')); }   // then silence
    }));
    await assert.rejects(ai.route('solve', problem), /stopped answering/);
  } finally { Object.assign(ai.TIMEOUTS, saved); }
});
