// api/static.js
// Pre-generated hint files on the static cache site (contract item 1):
//   ${CACHE_URL}/cache/<slug>.json
// One file per problem, already verified (compiled, signature-checked), so a
// cached problem costs no AI call at all — for any number of users.
// Any problem (timeout, 404, bad file) → null, and the caller uses the Worker.

import { CACHE_URL } from './config.js';

export const STATIC_TIMEOUT_MS = 4000;

const isText = v => typeof v === 'string' && v.trim().length > 0;

// Is this a usable hint file for this slug?
export function isValidStaticFile(file, slug) {
  if (!file || typeof file !== 'object') return false;
  if (slug && String(file.slug || '').toLowerCase() !== String(slug).toLowerCase()) return false;
  if (!Array.isArray(file.hints) || file.hints.length < 4 || !file.hints.slice(0, 4).every(isText)) return false;
  return isText(file.code?.cpp) && isText(file.tc) && isText(file.sc);
}

// Only well-formed { q, a } pairs, at most 3
export function cleanFollowUps(list) {
  return (Array.isArray(list) ? list : [])
    .filter(f => f && isText(f.q) && isText(f.a))
    .slice(0, 3)
    .map(f => ({ q: f.q.trim(), a: f.a.trim() }));
}

// The file → the hints object the side panel already uses (same shape as a
// parsed Worker reply, plus source: 'static')
export function mapStaticFile(file) {
  const note = [file.approach, 'TC ' + file.tc, 'SC ' + file.sc].filter(isText).join(' · ');
  const translations = {};
  for (const [lang, code] of Object.entries(file.code || {})) {
    if (lang !== 'cpp' && isText(code)) translations[lang] = code.trim();
  }
  return {
    hint1: file.hints[0].trim(), hint2: file.hints[1].trim(),
    hint3: file.hints[2].trim(), hint4: file.hints[3].trim(),
    hint5: '```cpp\n' + file.code.cpp.trim() + '\n```\nApproach: ' + note,
    optimal_tc: file.tc, optimal_sc: file.sc,
    sc_breakdown: isText(file.spaceBreakdown) ? file.spaceBreakdown : '',
    pattern: isText(file.pattern) ? file.pattern : 'Unknown',
    translations,
    followUps: cleanFollowUps(file.followUps),
    source: 'static',
    promptVersion: file.promptVersion || ''
  };
}

// → hints object, or null when there is no usable file
export async function fetchStaticHints(slug, { fetchImpl = globalThis.fetch, timeoutMs = STATIC_TIMEOUT_MS, baseUrl = CACHE_URL } = {}) {
  if (!slug || !baseUrl) return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(`${baseUrl}/cache/${encodeURIComponent(slug.toLowerCase())}.json`, { signal: controller.signal });
    if (!res.ok) return miss(slug, `HTTP ${res.status}`);
    const file = await res.json();
    return isValidStaticFile(file, slug) ? mapStaticFile(file) : miss(slug, 'malformed file');
  } catch (e) {
    return miss(slug, e?.name === 'AbortError' ? 'timeout' : e?.message);   // offline, timeout, not JSON
  } finally {
    clearTimeout(timer);
  }
}

// No usable file → the Worker path takes over, as before
function miss(slug, why) {
  console.debug(`LeetHint: no static hints for ${slug} (${why}) — using the server`);
  return null;
}
