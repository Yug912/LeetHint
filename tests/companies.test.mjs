// Company tags from the cache site (S11) — run with: node --test tests/*.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadCompanies, COMPANIES_MAX_AGE_MS } from '../api/companies.js';

const SITE = 'https://leethint.pages.dev', BUNDLED = 'chrome-extension://x/data/companies.json';
const NOW = Date.parse('2026-11-07T12:00:00Z');
const bundled = { 'two-sum': ['Amazon'] };
const site = { 'two-sum': ['Amazon', 'Google'], 'new-problem': ['Meta'] };

function fakeStorage(initial = {}) {
  const data = { ...initial };
  return { data, get: async keys => Object.fromEntries(keys.filter(k => k in data).map(k => [k, data[k]])),
           set: async o => Object.assign(data, o) };
}
// online: the site answers; offline: only the bundled file (it's inside the extension)
const fetcher = ({ online }) => {
  const calls = [];
  const fn = async url => {
    calls.push(url);
    if (url === BUNDLED) return new Response(JSON.stringify(bundled));
    if (!online) throw new TypeError('Failed to fetch');
    return new Response(JSON.stringify(site));
  };
  return Object.assign(fn, { calls });
};
const load = (storage, fetchFn, now = NOW) => loadCompanies({ storage, fetchFn, cacheUrl: SITE, bundledUrl: BUNDLED, now });

test('first run online: tags come from the site and are stored with the time', async () => {
  const storage = fakeStorage(), f = fetcher({ online: true });
  const r = await load(storage, f);
  assert.equal(r.source, 'site');
  assert.deepEqual(r.data, site);
  assert.deepEqual(storage.data, { companiesData: site, companiesFetchedAt: NOW });
});

test('first run offline: the bundled tags still show', async () => {
  const r = await load(fakeStorage(), fetcher({ online: false }));
  assert.equal(r.source, 'bundled');
  assert.deepEqual(r.data, bundled);
});

test('within 7 days the stored copy is used without fetching', async () => {
  const f = fetcher({ online: true });
  const r = await load(fakeStorage({ companiesData: bundled, companiesFetchedAt: NOW - 3 * 86400e3 }), f);
  assert.equal(r.source, 'stored');
  assert.equal(f.calls.length, 0);
});

test('after 7 days tags update from the site; offline then keeps the old copy', async () => {
  const old = { companiesData: bundled, companiesFetchedAt: NOW - COMPANIES_MAX_AGE_MS - 1 };
  const storage = fakeStorage(old);
  assert.equal((await load(storage, fetcher({ online: true }))).source, 'site');
  assert.deepEqual(storage.data.companiesData, site);
  const r = await load(fakeStorage(old), fetcher({ online: false }));
  assert.deepEqual([r.source, r.data], ['stale', bundled]);
});

test('a broken site file, a 404 or broken storage falls back without throwing', async () => {
  const bad = async url => url === BUNDLED ? new Response(JSON.stringify(bundled)) : new Response('[1,2]');
  assert.equal((await load(fakeStorage(), bad)).source, 'bundled');
  const notFound = async url => url === BUNDLED ? new Response(JSON.stringify(bundled)) : new Response('', { status: 404 });
  assert.equal((await load(fakeStorage(), notFound)).source, 'bundled');
  const broken = { get: async () => { throw new Error('no storage'); }, set: async () => { throw new Error('no storage'); } };
  assert.equal((await load(broken, fetcher({ online: true }))).source, 'site');
  const nothing = async () => { throw new Error('down'); };
  assert.deepEqual(await load(fakeStorage(), nothing), { data: {}, source: 'none' });
});
