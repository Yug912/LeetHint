// api/direct.js
// Optional own API key (plans 3.2–3.4): the user's free Gemini / Groq /
// OpenRouter key, stored ONLY in chrome.storage.local as ownKey
// { provider, key } and sent ONLY to that provider — never to our Worker.
// The prompt is built here with the same buildPrompt() the server uses, so
// replies have exactly the same ---TAG--- format and are parsed the same way.
//
// One fixed, tested model per provider — users don't pick models.

import { buildPrompt, ACTIONS } from '../shared/prompts.js';
import { readAnswerStream } from './ai.js';

export const OWN_KEY_PROVIDERS = {
  groq: {
    name: 'Groq', kind: 'openai', model: 'openai/gpt-oss-120b',
    endpoint: 'https://api.groq.com/openai/v1/chat/completions',
    keyUrl: 'https://console.groq.com/keys',
    tokensPerMinute: 8000   // free tier counts max_tokens up front
  },
  gemini: {
    name: 'Gemini', kind: 'gemini', model: 'gemini-flash-latest',
    keyUrl: 'https://aistudio.google.com/apikey'
  },
  openrouter: {
    name: 'OpenRouter', kind: 'openai', model: 'openai/gpt-oss-120b:free',
    endpoint: 'https://openrouter.ai/api/v1/chat/completions',
    keyUrl: 'https://openrouter.ai/keys',
    headers: { 'X-Title': 'LeetHint' }
  }
};

const STORAGE_KEY = 'ownKey';
const TEMPERATURE = 0.1;

// ── Storage ──
export async function getOwnKey() {
  try {
    const { ownKey } = await chrome.storage.local.get(STORAGE_KEY);
    return ownKey && OWN_KEY_PROVIDERS[ownKey.provider] && typeof ownKey.key === 'string' && ownKey.key.trim()
      ? { provider: ownKey.provider, key: ownKey.key.trim() } : null;
  } catch {
    return null;
  }
}
export async function saveOwnKey(provider, key) {
  if (!OWN_KEY_PROVIDERS[provider] || !String(key || '').trim()) throw new Error('Pick a provider and paste a key.');
  await chrome.storage.local.set({ [STORAGE_KEY]: { provider, key: String(key).trim() } });
}
export async function removeOwnKey() {
  await chrome.storage.local.remove(STORAGE_KEY).catch(() => {});
}

// ── Same per-action budgets and effort as the server (backend/src/index.js) ──
export function requestSettings(action, problem = {}, extra = {}) {
  const translating = action === 'translate' || action === 'translate_all';
  const hard = /hard/i.test(problem.difficulty || '');
  const effort = translating || action === 'interview_turn' || extra.lowEffort ? 'low'
               : action === 'interview_score' ? 'medium' : hard ? 'high' : 'medium';
  const maxTokens = ({
    hints: hard ? 8000 : 4500, solve: hard ? 7000 : 3500, fix: hard ? 6000 : 4000,
    translate: 1500, translate_all: 500 + 650 * (extra.languages?.length || 0),
    interview_turn: 1200, interview_score: 2500, interview_summary: 800
  }[action] || 3000) + (extra.language && !translating ? 400 : 0);
  return { effort, maxTokens, easy: /easy/i.test(problem.difficulty || '') };
}

const estimateTokens = text => Math.ceil(String(text).length / 3.5);

// The provider request — mirrors the server's buildRequest()
export function buildDirectRequest(provider, key, prompt, { effort, maxTokens, easy } = {}) {
  const cfg = OWN_KEY_PROVIDERS[provider];
  if (!cfg) throw new Error('Unknown provider');
  if (cfg.kind === 'gemini') {
    return {
      url: `https://generativelanguage.googleapis.com/v1beta/models/${cfg.model}:streamGenerateContent?alt=sse`,
      init: {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          // Gemini counts thinking inside maxOutputTokens — give it room
          generationConfig: { temperature: TEMPERATURE, maxOutputTokens: Math.max(maxTokens || 0, 12000) }
        })
      }
    };
  }
  // A free tokens/minute cap counts prompt + max_tokens: stay under it
  let max = maxTokens || 3000;
  if (cfg.tokensPerMinute) max = Math.max(1000, Math.min(max, cfg.tokensPerMinute - estimateTokens(prompt) - 200));
  let eff = effort;
  if (cfg.tokensPerMinute && eff === 'high') eff = 'medium';   // "high" can use the whole budget thinking
  if (easy && eff === 'medium' && /20b/.test(cfg.model)) eff = 'low';
  const reasoning = !eff || !/gpt-oss/.test(cfg.model) ? {}
    : provider === 'openrouter' ? { reasoning: { effort: eff } } : { reasoning_effort: eff };
  const hide = provider === 'groq' ? { include_reasoning: false } : {};
  return {
    url: cfg.endpoint,
    init: {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json', ...cfg.headers },
      body: JSON.stringify({
        model: cfg.model,
        messages: [{ role: 'user', content: prompt }],
        temperature: TEMPERATURE,
        max_tokens: max,
        stream: true,
        ...reasoning, ...hide
      })
    }
  };
}

// The provider's own error text (shown to the user when testing a key)
async function providerError(res, cfg) {
  let msg = '';
  try {
    const body = await res.json();
    const e = Array.isArray(body) ? body[0]?.error : body?.error;
    msg = (typeof e === 'string' ? e : e?.message) || body?.message || '';
  } catch { /* not JSON */ }
  const err = new Error(`${cfg.name}: ${msg || `error ${res.status}`}`);
  err.status = res.status;
  err.auth = res.status === 401 || res.status === 403 ||
             (res.status === 400 && /api[ _-]?key|unauthori[sz]ed|invalid.*key|permission/i.test(msg));
  err.provider = cfg.name;
  return err;
}

// One action, straight to the provider with the user's key → the reply text.
// opts: the same as the Worker call (code, language, snippet, languages,
// snippets, interview, failure, onText, lowEffort) + own: { provider, key }
export async function callDirect(action, problem, opts = {}) {
  const { own, onText, code = '', lowEffort = false, fetchImpl = globalThis.fetch } = opts;
  const cfg = OWN_KEY_PROVIDERS[own?.provider];
  if (!cfg) throw new Error('No own key set');
  // An action this version's prompts don't know (e.g. interview_summary
  // before Person A ships it) would silently get the solution prompt instead
  if (!ACTIONS.includes(action)) {
    throw Object.assign(new Error(`"${action}" isn't available with an own key yet`), { code: 'unsupported' });
  }
  const extra = { language: opts.language, snippet: opts.snippet, languages: opts.languages,
                  snippets: opts.snippets, failure: opts.failure, interview: opts.interview };
  const prompt = buildPrompt(action, problem, code, extra);
  const { url, init } = buildDirectRequest(own.provider, own.key, prompt, requestSettings(action, problem, { ...extra, lowEffort }));

  let res;
  try {
    const timeout = AbortSignal.timeout(180000);
    res = await fetchImpl(url, { ...init, signal: opts.signal && AbortSignal.any ? AbortSignal.any([opts.signal, timeout]) : timeout });
  } catch {
    if (opts.signal?.aborted) throw Object.assign(new Error('Cancelled'), { name: 'AbortError' });
    const err = new Error(`Could not reach ${cfg.name} — check your connection.`);
    err.offline = true;
    throw err;
  }
  if (!res.ok) throw await providerError(res, cfg);

  const text = await readAnswerStream(res, cfg.kind, onText);
  if (!text.trim()) {
    if (!lowEffort) return callDirect(action, problem, { ...opts, lowEffort: true });
    throw new Error(`${cfg.name} returned an empty reply — please retry.`);
  }
  return text;
}

// "Test key": one tiny request → { ok: true } or { ok: false, message }
export async function testOwnKey(provider, key, { fetchImpl = globalThis.fetch } = {}) {
  const cfg = OWN_KEY_PROVIDERS[provider];
  if (!cfg || !String(key || '').trim()) return { ok: false, message: 'Pick a provider and paste a key.' };
  const { url, init } = buildDirectRequest(provider, String(key).trim(), 'Reply with the single word OK.', { effort: 'low', maxTokens: 1000 });
  try {
    const res = await fetchImpl(url, { ...init, signal: AbortSignal.timeout(30000) });
    if (!res.ok) return { ok: false, message: (await providerError(res, cfg)).message };
    const text = await readAnswerStream(res, cfg.kind);
    return text.trim() ? { ok: true } : { ok: false, message: `${cfg.name} answered with an empty reply — try again.` };
  } catch (e) {
    return { ok: false, message: `Could not reach ${cfg.name}: ${e.message}` };
  }
}
