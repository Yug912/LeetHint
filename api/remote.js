// api/remote.js — the server's remote switches (GET /config, cached 1 hour).
// Lets a feature be turned off or limited without an extension update.
// Any error — server down, an older Worker without /config — means the
// defaults below: every feature on, no message. Never shows an error.

import { BACKEND_URL } from './config.js';
import { backendHeaders } from './ai.js';

export const CONFIG_DEFAULTS = {
  interview: true, fix: true, trialInterviewsPerWeek: 1, trialInterviewMinutes: 15, trialFixesPerDay: 3, message: ''
};
const MAX_AGE_MS = 60 * 60 * 1000;

// Unknown or missing fields mean "feature on, no message" (contract item 4)
export function normalizeConfig(raw) {
  const c = raw && typeof raw === 'object' ? raw : {};
  const num = (v, d) => Number.isFinite(Number(v)) && v !== null && v !== '' ? Number(v) : d;
  return {
    interview: c.interview !== false,
    fix: c.fix !== false,
    trialInterviewsPerWeek: num(c.trialInterviewsPerWeek, CONFIG_DEFAULTS.trialInterviewsPerWeek),
    trialInterviewMinutes: num(c.trialInterviewMinutes, CONFIG_DEFAULTS.trialInterviewMinutes),
    trialFixesPerDay: num(c.trialFixesPerDay, CONFIG_DEFAULTS.trialFixesPerDay),
    message: typeof c.message === 'string' ? c.message.slice(0, 300) : ''
  };
}

// Fetched at most once an hour; kept in chrome.storage.local as remoteConfig { at, value }
export async function getRemoteConfig({ now = Date.now() } = {}) {
  let saved = null;
  try { saved = (await chrome.storage.local.get('remoteConfig')).remoteConfig; } catch {}
  if (saved?.value && now - saved.at < MAX_AGE_MS) return normalizeConfig(saved.value);
  try {
    const res = await fetch(`${BACKEND_URL}/config`, { headers: await backendHeaders(), signal: AbortSignal.timeout(5000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const value = normalizeConfig(await res.json());
    try { await chrome.storage.local.set({ remoteConfig: { at: now, value } }); } catch {}
    return value;
  } catch {
    // Keep using the last known switches if there are any, else the defaults
    return normalizeConfig(saved?.value || CONFIG_DEFAULTS);
  }
}
