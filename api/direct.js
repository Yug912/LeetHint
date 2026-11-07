// api/direct.js — the user's OWN free API key: call the provider straight
// from the browser, with no LeetHint server in between.
//
// The key lives only in chrome.storage.local (ownKey: { provider, key }) and
// is sent only to that provider. Answers made with it stay in this browser —
// nothing here ever talks to the LeetHint Worker.
//
// Same prompts as the server (shared/prompts.js), same streamed reply format,
// so the rest of the extension can't tell the two apart.

import { buildPrompt } from '../shared/prompts.js';
import { readAnswerStream } from './ai.js';

// One fixed, tested model per provider — users don't pick models
export const OWN_KEY_PROVIDERS = {
  gemini: {
    name: 'Google Gemini', kind: 'gemini', model: 'gemini-flash-latest',
    keyUrl: 'https://aistudio.google.com/apikey', host: 'https://generativelanguage.googleapis.com/*'
  },
  groq: {
    name: 'Groq', kind: 'openai', model: 'openai/gpt-oss-120b',
    endpoint: 'https://api.groq.com/openai/v1/chat/completions',
    keyUrl: 'https://console.groq.com/keys', host: 'https://api.groq.com/*'
  },
  openrouter: {
    name: 'OpenRouter', kind: 'openai', model: 'nvidia/nemotron-3-ultra-550b-a55b:free',   // a :free model (checked 2026-11-07)
    endpoint: 'https://openrouter.ai/api/v1/chat/completions',
    keyUrl: 'https://openrouter.ai/keys', host: 'https://openrouter.ai/*',
    headers: { 'HTTP-Referer': 'https://github.com/Yug912/LeetHint', 'X-Title': 'LeetHint' }
  }
};

// ── the saved key ──
export async function getOwnKey() {
  try {
    if (typeof chrome === 'undefined' || !chrome.storage?.local) return null;
    const { ownKey } = await chrome.storage.local.get('ownKey');
    return ownKey?.key && OWN_KEY_PROVIDERS[ownKey.provider] ? ownKey : null;
  } catch {
    return null;
  }
}

export async function setOwnKey(provider, key) {
  if (!key) return chrome.storage.local.remove('ownKey');
  return chrome.storage.local.set({ ownKey: { provider, key: key.trim() } });
}

// Token budgets per job — the same as the server's (backend/src/index.js)
export function maxTokensFor(action, problem, extra = {}) {
  const hard = /hard/i.test(problem?.difficulty || '');
  const base = {
    hints: hard ? 8000 : 4500, solve: hard ? 7000 : 3500, fix: hard ? 6000 : 4000,
    translate: 1500, translate_all: 500 + 650 * (extra.languages?.length || 0),
    interview_turn: 1200, interview_score: 2500, interview_summary: 800
  }[action] || 4000;
  return base + (extra.language && !action.startsWith('translate') ? 400 : 0);
}

function effortFor(action, problem, lowEffort) {
  if (lowEffort || action.startsWith('translate') || action === 'interview_turn' || action === 'interview_summary') return 'low';
  if (action === 'interview_score') return 'medium';
  return /hard/i.test(problem?.difficulty || '') ? 'high' : 'medium';
}

// The provider request for a prompt → { url, init }
export function buildDirectRequest(provider, key, prompt, { maxTokens = 4000, effort = 'medium', stream = true } = {}) {
  const p = OWN_KEY_PROVIDERS[provider];
  if (!p) throw new Error('Unknown provider.');
  if (p.kind === 'gemini') {
    return {
      url: `https://generativelanguage.googleapis.com/v1beta/models/${p.model}:${stream ? 'streamGenerateContent?alt=sse' : 'generateContent'}`,
      init: {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
        body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }],
                               generationConfig: { temperature: 0.1, maxOutputTokens: Math.max(maxTokens, stream ? 12000 : 0) } })
      }
    };
  }
  return {
    url: p.endpoint,
    init: {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}`, ...p.headers },
      body: JSON.stringify({
        model: p.model, messages: [{ role: 'user', content: prompt }],
        temperature: 0.1, max_tokens: maxTokens, stream,
        ...(provider === 'openrouter' ? { reasoning: { effort } } : { reasoning_effort: effort, include_reasoning: false })
      })
    }
  };
}

// The provider's own error text, made readable
async function providerError(res, name) {
  const body = await res.json().catch(() => ({}));
  const msg = body.error?.message || body[0]?.error?.message || `HTTP ${res.status}`;
  const e = new Error(res.status === 401 || res.status === 403 || /api key|invalid/i.test(msg)
    ? `${name} rejected the key: ${msg}` : `${name}: ${msg}`);
  e.status = res.status;
  e.ownKey = true;
  return e;
}

// Same job as callBackend() in api/ai.js, straight to the provider
export async function callDirect(action, problem, opts = {}, ownKey) {
  const { code = '', onText, language, snippet, languages, snippets, interview, failure, lowEffort = false } = opts;
  const p = OWN_KEY_PROVIDERS[ownKey.provider];
  const extra = { language, snippet, failure, languages, snippets, interview };
  const prompt = buildPrompt(action, problem, code, extra);
  const { url, init } = buildDirectRequest(ownKey.provider, ownKey.key, prompt,
    { maxTokens: maxTokensFor(action, problem, extra), effort: effortFor(action, problem, lowEffort) });
  let res;
  try {
    res = await fetch(url, { ...init, signal: AbortSignal.timeout(180000) });
  } catch {
    const err = new Error(`Could not reach ${p.name} — check your connection.`);
    err.offline = true;
    throw err;
  }
  if (!res.ok) throw await providerError(res, p.name);
  console.log(`LeetHint: ${action} reply (own key, ${p.name} ${p.model})`);
  return readAnswerStream(res, p.kind, onText);
}

// Settings → "Test key": one tiny request. → 'ok' or throws the provider's error
export async function testOwnKey(provider, key) {
  const p = OWN_KEY_PROVIDERS[provider];
  const { url, init } = buildDirectRequest(provider, key, 'Reply with the single word OK.', { maxTokens: 300, effort: 'low', stream: false });
  let res;
  try {
    res = await fetch(url, { ...init, signal: AbortSignal.timeout(30000) });
  } catch {
    throw new Error(`Could not reach ${p.name} — check your connection.`);
  }
  if (!res.ok) throw await providerError(res, p.name);
  return 'ok';
}
