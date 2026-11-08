// Only large models' solutions and hints are cached — run with: node --test tests/*.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cacheableFrom } from '../backend/src/store.js';

test('hints/solve/fix from a large model are cached', () => {
  for (const label of ['Groq (openai/gpt-oss-120b)', 'Workers AI (@cf/openai/gpt-oss-120b)', 'Gemini (gemini-3.8-flash)',
                       'Groq (moonshotai/kimi-k2-instruct)', 'Groq (openai/gpt-oss-120b) [joined]']) {
    assert.equal(cacheableFrom('p8:hints:two-sum:abc', label), true, label);
    assert.equal(cacheableFrom('p8:solve-python3:two-sum:abc', label), true, label);
  }
});

test('hints/solve/fix from a small model are not cached', () => {
  for (const label of ['Groq (openai/gpt-oss-20b)', 'Workers AI (@cf/openai/gpt-oss-20b)', 'Gemini (gemini-flash-lite-latest)',
                       'Groq (qwen/qwen3.8-27b)', 'OpenRouter (google/gemma-4-31b-it:free)', '', undefined]) {
    assert.equal(cacheableFrom('p8:hints:minimum-cost-to-make-red-nodes-connected:abc', label), false, String(label));
    assert.equal(cacheableFrom('p8:fix-signature:two-sum:abc', label), false, String(label));
  }
});

test('translations of verified code are cached from any model', () => {
  assert.equal(cacheableFrom('p8:translate-java:two-sum:abc', 'Groq (openai/gpt-oss-20b)'), true);
  assert.equal(cacheableFrom('p8:translate_all:two-sum:abc', 'Groq (openai/gpt-oss-20b)'), true);
});
