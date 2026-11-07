// Remote switch, client half (B4) — run with: node --test tests/*.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installFakeChrome } from './helpers/fake-chrome.mjs';

const store = installFakeChrome();
const { getRemoteConfig, CONFIG_DEFAULTS } = await import('../api/remote.js');
let calls = 0;

test('server off or no /config → everything on, no message', async () => {
  globalThis.fetch = async () => { calls++; throw new Error('offline'); };
  assert.deepEqual(await getRemoteConfig(), CONFIG_DEFAULTS);
  globalThis.fetch = async () => { calls++; return Response.json({ error: 'Not found' }, { status: 404 }); };
  assert.deepEqual(await getRemoteConfig(), CONFIG_DEFAULTS);
});

test('fetched at most once an hour; interview:false is picked up after that', async () => {
  calls = 0;
  globalThis.fetch = async () => { calls++; return Response.json({ interview: true, message: '' }); };
  const t0 = Date.now();
  await getRemoteConfig({ now: t0 });
  await getRemoteConfig({ now: t0 + 30 * 60e3 });
  assert.equal(calls, 1);
  globalThis.fetch = async () => { calls++; return Response.json({ interview: false, message: 'Interviews paused tonight', extra: 1 }); };
  const c = await getRemoteConfig({ now: t0 + 61 * 60e3 });
  assert.equal(calls, 2);
  assert.equal(c.interview, false);
  assert.equal(c.fix, true);                       // missing = on
  assert.equal(c.message, 'Interviews paused tonight');
  assert.equal(store.remoteConfig.value.interview, false);
});
