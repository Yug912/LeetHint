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
    const saved = (await storage?.get(STORAGE_KEY))?.[STORAGE_KEY];
    if (saved && typeof saved.at === 'number' && now - saved.at < CONFIG_MAX_AGE_MS && now >= saved.at) {
      return normalizeConfig(saved.value);
    }
  } catch { /* storage unavailable — fetch below */ }

  // One request even if several parts of the panel ask at once
  if (!inFlight) {
    inFlight = (async () => {
      try {
        const res = await fetchImpl(`${baseUrl}/config`, { headers: await serverHeaders(), signal: AbortSignal.timeout(5000) });
        if (!res.ok) return { ...REMOTE_DEFAULTS };   // older Worker: no /config yet
        const value = normalizeConfig(await res.json());
        try { await storage?.set({ [STORAGE_KEY]: { at: now, value } }); } catch { /* fine */ }
        return value;
      } catch {
        return { ...REMOTE_DEFAULTS };
      } finally {
        inFlight = null;
      }
    })();
  }
  return inFlight;
}
