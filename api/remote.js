// api/remote.js — the server's remote switches (GET /config)
// Lets the owner turn a feature off for everyone without a store update.
// Fetched at most once an hour and kept in chrome.storage.local as
// remoteConfig: { at, value }. Any error, or an older server without /config,
// → the defaults: every feature on, no message.

import { BACKEND_URL } from './config.js';
import { installHeaders } from './install.js';

const KEY = 'remoteConfig';
const MAX_AGE_MS = 60 * 60 * 1000;

export const DEFAULT_CONFIG = Object.freeze({
  interview: true, fix: true,
  trialInterviewsPerWeek: 0, trialInterviewMinutes: 0, trialFixesPerDay: 0,   // 0 = no trial limits known
  message: ''
});

// Unknown or missing fields mean "feature on, no message"
export function normalizeConfig(raw) {
  const v = raw && typeof raw === 'object' ? raw : {};
  const count = x => (Number(x) > 0 ? Math.floor(Number(x)) : 0);
  return {
    interview: v.interview !== false,
    fix: v.fix !== false,
    trialInterviewsPerWeek: count(v.trialInterviewsPerWeek),
    trialInterviewMinutes: Math.min(60, count(v.trialInterviewMinutes)),
    trialFixesPerDay: count(v.trialFixesPerDay),
    message: typeof v.message === 'string' ? v.message.trim().slice(0, 200) : ''
  };
}

export async function getRemoteConfig({
  storage = globalThis.chrome?.storage?.local, fetchImpl = globalThis.fetch, now = Date.now(), force = false
} = {}) {
  let saved = null;
  try { saved = (await storage?.get(KEY))?.[KEY] || null; } catch { /* no storage */ }
  if (!force && saved && now - saved.at < MAX_AGE_MS) return normalizeConfig(saved.value);

  try {
    const res = await fetchImpl(`${BACKEND_URL}/config`, { headers: await installHeaders(), signal: AbortSignal.timeout(5000) });
    if (!res.ok) throw new Error(String(res.status));
    const value = normalizeConfig(await res.json());
    await storage?.set({ [KEY]: { at: now, value } }).catch?.(() => {});
    return value;
  } catch {
    // Keep the last good answer if there is one, but ask again next time
    return saved ? normalizeConfig(saved.value) : { ...DEFAULT_CONFIG };
  }
}
