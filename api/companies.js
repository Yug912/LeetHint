// api/companies.js — company tags per problem slug.
// Fresher tags come from the cache site once a week; the copy bundled with
// the extension (data/companies.json) is the fallback: first run offline, or
// the site down. Every storage and fetch call is wrapped, so a failure only
// means older tags, never an error.

export const COMPANIES_MAX_AGE_MS = 7 * 24 * 3600 * 1000;

// storage: chrome.storage.local (or a fake with get/set)
// fetchFn: fetch;  cacheUrl: CACHE_URL;  bundledUrl: chrome.runtime.getURL('data/companies.json')
// → { data, source: 'stored' | 'site' | 'stale' | 'bundled' | 'none' }
export async function loadCompanies({ storage, fetchFn = fetch, cacheUrl, bundledUrl, now = Date.now() }) {
  let stored = null;
  try {
    const { companiesData, companiesFetchedAt = 0 } = await storage.get(['companiesData', 'companiesFetchedAt']);
    if (isTags(companiesData)) {
      stored = companiesData;
      if (now - companiesFetchedAt < COMPANIES_MAX_AGE_MS) return { data: stored, source: 'stored' };
    }
  } catch { /* storage unavailable → act as if empty */ }

  try {
    const res = await fetchFn(`${cacheUrl}/companies.json`, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const fresh = await res.json();
    if (!isTags(fresh)) throw new Error('bad file');
    try { await storage.set({ companiesData: fresh, companiesFetchedAt: now }); } catch {}
    return { data: fresh, source: 'site' };
  } catch { /* offline or site down */ }

  if (stored) return { data: stored, source: 'stale' };
  try {
    const res = await fetchFn(bundledUrl);
    const bundled = await res.json();
    if (isTags(bundled)) return { data: bundled, source: 'bundled' };
  } catch {}
  return { data: {}, source: 'none' };
}

const isTags = v => !!v && typeof v === 'object' && !Array.isArray(v);
