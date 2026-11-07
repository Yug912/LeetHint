// Tests for the D1 store — run with: node --test tests/*.test.mjs
// A real SQLite database (node:sqlite) runs the real migration, wrapped in D1's API.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fakeD1 } from './helpers/fake-d1.mjs';
import { getCached, putCached, saveReport, useTrial, isAdmittedInterview, admitInterview, isBlocked,
         dayPeriod, weekPeriod, periodResetsAt } from '../backend/src/store.js';

test('cache: D1 first; KV still read during the move; nothing stored without either', async () => {
  const kv = new Map([['old-key', 'old reply']]);
  const env = { DB: fakeD1(), HINTS_CACHE: {
    getWithMetadata: async k => ({ value: kv.get(k) ?? null, metadata: { kind: 'gemini' } }),
    put: async () => { throw new Error('KV must not be written once D1 exists'); }
  } };
  assert.equal(await getCached(env, 'new-key'), null);
  await putCached(env, 'new-key', 'data: hi', 'openai');
  assert.deepEqual(await getCached(env, 'new-key'), { raw: 'data: hi', kind: 'openai', layer: 'd1' });
  assert.deepEqual(await getCached(env, 'old-key'), { raw: 'old reply', kind: 'gemini', layer: 'kv' });
  await putCached({}, 'x', 'y', 'openai');   // no store at all: a no-op, not an error
});

test('reports: a repeat from the same reporter on the same day is ignored', async () => {
  const env = { DB: fakeD1() };
  const r = { slug: 'two-sum', day: '2026-11-07', reporter: 'abc', promptVersion: 'p7', reason: 'wrong_hint', note: '' };
  await saveReport(env, r);
  await saveReport(env, { ...r, note: 'again' });
  await saveReport(env, { ...r, reporter: 'def' });
  assert.equal(env.DB.db.prepare('SELECT COUNT(*) AS n FROM reports').get().n, 2);
});

test('trials: 3 fixes a day, then refused; another install or day is separate', async () => {
  const env = { DB: fakeD1() };
  const grants = [];
  for (let i = 0; i < 4; i++) grants.push(await useTrial(env, 'a', '2026-11-07', 'fix', 3));
  assert.deepEqual(grants, [true, true, true, false]);
  assert.equal(await useTrial(env, 'b', '2026-11-07', 'fix', 3), true);
  assert.equal(await useTrial(env, 'a', '2026-11-08', 'fix', 3), true);
  assert.equal(await useTrial(env, 'a', '2026-11-07', 'fix', 0), false);
  assert.equal(await useTrial({}, 'a', 'p', 'fix', 3), true);   // no D1 → no limit
});

test('interviews: admitted once; a refused one is not recorded', async () => {
  const env = { DB: fakeD1() };
  assert.equal(await isAdmittedInterview(env, 'iv1'), false);
  await admitInterview(env, 'iv1', 'a');
  assert.equal(await isAdmittedInterview(env, 'iv1'), true);
  assert.equal(await isAdmittedInterview(env, 'iv2'), false);
});

test('blocklist', async () => {
  const env = { DB: fakeD1() };
  env.DB.db.prepare('INSERT INTO blocked (install_id, reason, created) VALUES (?, ?, ?)').run('bad', 'abuse', 0);
  assert.equal(await isBlocked(env, 'bad'), true);
  assert.equal(await isBlocked(env, 'good'), false);
  assert.equal(await isBlocked(env, ''), false);
});

test('periods: UTC day, ISO week, and when they reset', () => {
  const thu = new Date('2026-11-05T15:00:00Z');
  assert.equal(dayPeriod(thu), '2026-11-05');
  assert.equal(weekPeriod(thu), '2026-W45');
  assert.equal(weekPeriod(new Date('2027-01-01T00:00:00Z')), '2026-W53');   // Fri 1 Jan 2027 belongs to 2026's last week
  assert.equal(periodResetsAt('day', thu), '2026-11-06T00:00:00Z');
  assert.equal(periodResetsAt('week', thu), '2026-11-09T00:00:00Z');        // next Monday
  assert.equal(periodResetsAt('week', new Date('2026-11-09T10:00:00Z')), '2026-11-16T00:00:00Z');
});
