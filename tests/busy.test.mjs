// Every provider refusing → a waiting line, not an error (A9) — run with: node --test tests/*.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';

globalThis.fetch = async (url) => {
  if (String(url).endsWith('/models')) return Response.json({ data: [{ id: 'openai/gpt-oss-120b' }] });
  return Response.json({ error: { message: 'Rate limit reached for tokens per minute (TPM). Please try again in 30s.' } }, { status: 429 });
};
const { default: worker } = await import('../backend/src/index.js?busy');
const env = { GROQ_API_KEY: 't', PROVIDER_ORDER: 'groq' };

const call = () => worker.fetch(new Request('https://api.test/v1/generate', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Origin: 'chrome-extension://test' },
  body: JSON.stringify({ action: 'hints', problem: { slug: 'two-sum', title: 'Two Sum', difficulty: 'Easy', description: 'x' } })
}), env, { waitUntil() {} });

test('every provider at its limit → 429 busy + Retry-After + position', async () => {
  const r1 = await call();
  assert.equal(r1.status, 429);
  const b1 = await r1.json();
  assert.equal(b1.error, 'busy');
  assert.equal(b1.retryAfter, 30);                      // from the provider's "try again in 30s"
  assert.equal(r1.headers.get('Retry-After'), '30');
  assert.equal(r1.headers.get('Access-Control-Allow-Origin'), 'chrome-extension://test');
  const b2 = await (await call()).json();
  assert.equal(b2.position, b1.position + 1);           // the next one waits behind it
});
