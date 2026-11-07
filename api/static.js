// api/static.js — pre-generated hint files from the static cache site
// ${CACHE_URL}/cache/<slug>.json is made by tools/prefill.mjs: compiled,
// signature-checked hints + solution in four languages (format: the shared
// contract in the scaling docs). Reading one costs no AI call at all.
// Any problem — timeout, 404, a malformed file — returns null, and the
// caller uses the LeetHint server exactly as before.

import { CACHE_URL } from './config.js';

const TIMEOUT_MS = 4000;

export async function fetchStaticHints(slug, { fetchImpl = globalThis.fetch, baseUrl = CACHE_URL, timeoutMs = TIMEOUT_MS } = {}) {
  if (!/^[a-z0-9-]+$/i.test(slug || '')) return null;
  try {
    const res = await fetchImpl(`${baseUrl}/cache/${slug.toLowerCase()}.json`, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return null;
    return mapStaticFile(await res.json());
  } catch {
    return null;
  }
}

// The file → the hints object the side panel already uses (same shape as a
// server reply after parsing). null when the file isn't usable.
export function mapStaticFile(file) {
  if (!file || typeof file !== 'object') return null;
  const hints = Array.isArray(file.hints) ? file.hints.map(h => String(h || '').trim()) : [];
  const cpp = String(file.code?.cpp || '').trim();
  if (hints.length < 4 || hints.some(h => !h) || !cpp || !file.tc || !file.sc) return null;

  const note = [file.approach, `TC ${file.tc}`, `SC ${file.sc}`].filter(Boolean).join(' · ');
  const translations = {};
  for (const [lang, code] of Object.entries(file.code || {})) {
    if (lang !== 'cpp' && typeof code === 'string' && code.trim()) translations[lang] = code.trim();
  }
  return {
    hint1: hints[0], hint2: hints[1], hint3: hints[2], hint4: hints[3],
    hint5: '```cpp\n' + cpp + '\n```\nApproach: ' + note,
    optimal_tc: String(file.tc), optimal_sc: String(file.sc),
    sc_breakdown: String(file.spaceBreakdown || ''),
    pattern: String(file.pattern || ''),
    translations,
    followUps: cleanFollowUps(file.followUps),
    source: 'static',
    promptVersion: String(file.promptVersion || '')
  };
}

export function cleanFollowUps(list) {
  return (Array.isArray(list) ? list : [])
    .map(f => ({ q: String(f?.q || '').trim(), a: String(f?.a || '').trim() }))
    .filter(f => f.q && f.a)
    .slice(0, 3);
}
