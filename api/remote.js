// api/remote.js
// Remote switch (contract item 4): GET ${BACKEND_URL}/config, at most once an
// hour, cached in chrome.storage.local as remoteConfig ({ at, value }).
// Lets the server turn a costly feature off, or show a one-line message,
// without an extension update. Anything missing or failing means
// "everything on, no message" — exactly how the extension behaved before.

import { BACKEND_URL } from './config.js';
import { serverHeaders } from './install.js';

export const CONFIG_MAX_AGE_MS = 60 * 60 * 1000;
const STORAGE_KEY = 'remoteConfig';
const OVERRIDE_KEY = 'remoteConfigOverride';   // testing only — set by hand in DevTools
const CONFIG_TIMEOUT_MS = 4000;

export const REMOTE_DEFAULTS = Object.freeze({
  interview: true,
  fix: true,
  // Trial limits — null = the server has no trials yet (behave as before)
  trialInterviewsPerWeek: null,
  trialInterviewMinutes: null,
  trialFixesPerDay: null,
  message: ''
});

const positive = v => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : null);

// Only well-typed fields are taken; unknown or wrong ones keep the default
export function normalizeConfig(value) {
  const v = value && typeof value === 'object' ? value : {};
  return {
    interview: v.interview === false ? false : true,
    fix: v.fix === false ? false : true,
    trialInterviewsPerWeek: positive(v.trialInterviewsPerWeek),
    trialInterviewMinutes: positive(v.trialInterviewMinutes),
    trialFixesPerDay: positive(v.trialFixesPerDay),
    message: typeof v.message === 'string' ? v.message.trim().slice(0, 200) : ''
  };
}

let inFlight = null;

export async function getRemoteConfig({
  fetchImpl = globalThis.fetch, now = Date.now(), storage = globalThis.chrome?.storage?.local, baseUrl = BACKEND_URL
} = {}) {
  try {
    const stored = await storage?.get([STORAGE_KEY, OVERRIDE_KEY]);
    // Testing aid: a hand-set override wins, with no network call (see README)
    if (stored?.[OVERRIDE_KEY] && typeof stored[OVERRIDE_KEY] === 'object') return normalizeConfig(stored[OVERRIDE_KEY]);
    const saved = stored?.[STORAGE_KEY];
    if (saved && typeof saved.at === 'number' && now - saved.at < CONFIG_MAX_AGE_MS && now >= saved.at) {
      return normalizeConfig(saved.value);
    }
  } catch { /* storage unavailable — fetch below */ }

  // One request even if several parts of the panel ask at once
  if (!inFlight) {
    inFlight = (async () => {
      const remember = async value => {
        try { await storage?.set({ [STORAGE_KEY]: { at: now, value } }); } catch { /* fine */ }
        return value;
      };
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), CONFIG_TIMEOUT_MS);
      try {
        const res = await fetchImpl(`${baseUrl}/config`, { headers: await serverHeaders(), signal: controller.signal });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);   // older Worker: no /config yet
        return remember(normalizeConfig(await res.json()));
      } catch (e) {
        // Any failure → defaults, remembered too, so a missing endpoint is
        // asked at most once an hour instead of on every panel open
        console.debug('LeetHint: /config unavailable (' + (e?.name === 'AbortError' ? 'timeout' : e?.message) + ') — everything stays on');
        return remember({ ...REMOTE_DEFAULTS });
      } finally {
        clearTimeout(timer);
        inFlight = null;
      }
    })();
  }
  return inFlight;
}
