// backend/src/index.js — LeetHint API (Cloudflare Worker)
//
//   POST /v1/generate   { action, problem, code? }  →  the provider's SSE stream, passed through
//   GET  /health                                     →  { ok, providers }
//
// The extension sends PROBLEM DATA, never a prompt: prompts are built here
// from shared/prompts.js, so this endpoint can only produce LeetHint hints —
// it is useless as a free general-purpose AI proxy.
// API keys live only in Worker secrets (wrangler secret put ...).

import { ACTIONS, LANGUAGES, PROMPT_VERSION, buildPrompt } from '../../shared/prompts.js';
import { configuredProviders, describeModels, openStream } from './providers.js';

// Input limits — real LeetCode problems fit comfortably inside these
const LIMITS = {
  slug: 200, title: 300, problemNumber: 10, difficulty: 10,
  description: 30000, cppSnippet: 6000, code: 30000,   // cppSnippet limit also applies to translate snippets
  tags: 30, tag: 60, hints: 10, hint: 1500
};

const CACHE_TTL_SECONDS = 60 * 60 * 24 * 30;   // 30 days

// KV is eventually consistent: a fresh write can take ~60 s to become
// readable, and a miss is itself cached at the edge for ~60 s. This small
// in-memory layer (per Worker isolate) answers repeats inside that window.
const MEMORY_CACHE_MAX = 200;
const memoryCache = new Map();

function rememberReply(key, text) {
  memoryCache.delete(key);
  memoryCache.set(key, text);
  if (memoryCache.size > MEMORY_CACHE_MAX) memoryCache.delete(memoryCache.keys().next().value);  // oldest
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const cors = corsHeaders(request, env);

    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    if (!cors) return json({ error: 'Origin not allowed' }, 403);

    if (url.pathname === '/health' && request.method === 'GET') {
      // Provider and model NAMES only — never anything about the keys themselves
      const health = { ok: true, providers: configuredProviders(env).map(p => p.name) };
      if (url.searchParams.has('models')) health.models = await describeModels(env);
      return json(health, 200, cors);
    }

    if (url.pathname === '/v1/generate' && request.method === 'POST') {
      try {
        return await handleGenerate(request, env, ctx, cors);
      } catch (e) {
        console.error('generate failed:', e.message);
        const status = e.status >= 400 && e.status < 600 ? e.status : 500;
        // Only our own (generic) messages reach the client — never upstream details
        return json({ error: e.expose ? e.message : publicMessage(status) }, status, cors);
      }
    }

    return json({ error: 'Not found' }, 404, cors);
  }
};

async function handleGenerate(request, env, ctx, cors) {
  // ── Rate limit per client IP (Workers Rate Limiting binding) ──
  if (env.RATE_LIMITER) {
    const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
    const { success } = await env.RATE_LIMITER.limit({ key: ip });
    if (!success) throw clientError(429, 'Too many requests — wait a minute and try again.');
  }

  const raw = await request.text();
  if (raw.length > 80000) throw clientError(413, 'Request too large.');
  let body;
  try { body = JSON.parse(raw); } catch { throw clientError(400, 'Invalid JSON.'); }

  const action = ACTIONS.includes(body.action) ? body.action : null;
  if (!action) throw clientError(400, 'Unknown action.');
  const problem = sanitizeProblem(body.problem);
  const needsCode = action === 'fix' || action === 'translate' || action === 'translate_all';
  const code = needsCode ? clip(body.code, LIMITS.code) : '';
  if (needsCode && !code) throw clientError(400, 'No code given.');

  const isLanguage = l => typeof l === 'string' && Object.hasOwn(LANGUAGES, l) && l !== 'cpp';
  const extra = {};
  if (action === 'translate' && !isLanguage(body.language)) throw clientError(400, 'Unsupported language.');
  // 'translate', and optionally 'hints'/'solve' (the solution also in this language)
  if (isLanguage(body.language) && action !== 'fix' && action !== 'translate_all') {
    extra.language = body.language;
    extra.snippet = clip(body.snippet, LIMITS.cppSnippet);
  }
  if (action === 'translate_all') {
    extra.languages = [...new Set(Array.isArray(body.languages) ? body.languages : [])].filter(isLanguage).sort();
    if (!extra.languages.length) throw clientError(400, 'No languages given.');
    const snippets = body.snippets && typeof body.snippets === 'object' ? body.snippets : {};
    extra.snippets = Object.fromEntries(extra.languages.map(l => [l, clip(snippets[l], LIMITS.cppSnippet)]));
  }

  const prompt = buildPrompt(action, problem, code, extra);

  // More thinking where it pays off: Hard problems get "high" reasoning;
  // translation of already-verified code needs little
  const translating = action === 'translate' || action === 'translate_all';
  const hard = /hard/i.test(problem.difficulty);
  // lowEffort: the extension's retry after a reply whose thinking used up the
  // whole token budget before any answer was written
  const effort = translating || body.lowEffort === true ? 'low' : hard ? 'high' : 'medium';

  // Ask only for the tokens each job needs (thinking included) — free tiers
  // count the requested maximum against a tokens/minute budget, so smaller
  // requests mean more problems per minute
  const maxTokens = {
    hints: hard ? 6000 : 4500, solve: hard ? 5000 : 3500, fix: 4000,
    translate: 1500, translate_all: 500 + 650 * (extra.languages?.length || 0)
  }[action] + (extra.language && !translating ? 400 : 0);

  // Translations go to a smaller/faster model first, keeping the big model's
  // budget free for the next problem's hints
  const tier = translating ? 'fast' : 'main';

  // ── Shared cache: same problem + prompt → instant reply for every user ──
  // Keyed by a hash of the FULL prompt, so a client sending a fake statement
  // for a real slug only ever gets (and caches) its own fake result.
  const cacheable = action !== 'fix' && env.HINTS_CACHE;
  const cacheKey = cacheable
    ? `${PROMPT_VERSION}:${action}${extra.language ? '-' + extra.language : ''}:${problem.slug}:${await sha256(prompt)}`.slice(0, 500)
    : '';
  if (cacheable) {
    const fromMemory = memoryCache.get(cacheKey);
    if (fromMemory) return sseResponse(fromMemory.raw, fromMemory.kind, cors, { 'X-LeetHint-Cache': 'HIT', 'X-LeetHint-Cache-Layer': 'memory' });
    const { value, metadata } = await env.HINTS_CACHE.getWithMetadata(cacheKey);
    if (value) {
      const kind = metadata?.kind || 'openai';
      rememberReply(cacheKey, { raw: value, kind });
      return sseResponse(value, kind, cors, { 'X-LeetHint-Cache': 'HIT', 'X-LeetHint-Cache-Layer': 'kv' });
    }
  }

  // ── Stream from the first provider/model that accepts the request ──
  const tag = `${action}${extra.language ? '-' + extra.language : ''} ${problem.slug}`;
  const easy = /easy/i.test(problem.difficulty);
  const { upstream, kind, label } = await openStream(env, prompt, { effort, maxTokens, tier, easy });
  console.log(`${tag} (${effort}, ${maxTokens} tok) → ${label}`);

  // The upstream SSE bytes go to the client UNTOUCHED — the Worker never parses
  // the stream. (Parsing every chunk used to exceed the free plan's 10 ms CPU
  // limit, and Cloudflare then cut replies off mid-way.) The extension parses it.
  let stream = upstream.body;
  if (cacheable) {
    const [toClient, toCache] = upstream.body.tee();
    stream = toClient;
    ctx.waitUntil(cacheWhenComplete(env, cacheKey, toCache, kind));
  }

  // Which provider/model answered (names only) — for diagnosing slow replies
  return sseResponse(stream, kind, cors, { 'X-LeetHint-Cache': 'MISS', 'X-LeetHint-Model': label });
}

// Reads the copy of the stream natively (no per-chunk JS) and caches it only
// if the model finished normally and actually wrote an answer — a cut-off
// reply would otherwise be served forever.
async function cacheWhenComplete(env, cacheKey, stream, kind) {
  try {
    const raw = await new Response(stream).text();
    const cut = /"finish_reason"\s*:\s*"length"|"finishReason"\s*:\s*"MAX_TOKENS"/.test(raw);
    const finished = !cut && (kind === 'gemini' ? /"finishReason"\s*:\s*"STOP"/.test(raw)
                   : kind === 'workersai' ? raw.includes('[DONE]')
                   : /"finish_reason"\s*:\s*"stop"/.test(raw));
    const answered = kind === 'gemini' ? /"text"\s*:\s*"[^"]/.test(raw)
                   : /"(content|response)"\s*:\s*"[^"]/.test(raw);
    if (!finished || !answered) return;
    rememberReply(cacheKey, { raw, kind });
    await env.HINTS_CACHE.put(cacheKey, raw, { expirationTtl: CACHE_TTL_SECONDS, metadata: { kind } });
  } catch (e) {
    console.warn('cache write skipped:', e.message);
  }
}


// ─────────────────────────────────────────────
// INPUT SANITISING — only known fields, all clipped
// ─────────────────────────────────────────────
function clip(value, max) {
  return typeof value === 'string' ? value.slice(0, max) : '';
}

function sanitizeProblem(p) {
  if (!p || typeof p !== 'object') throw clientError(400, 'Missing problem.');
  const slug = clip(p.slug, LIMITS.slug).toLowerCase();
  if (!/^[a-z0-9-]+$/.test(slug)) throw clientError(400, 'Invalid problem slug.');
  const list = (arr, n, max) => (Array.isArray(arr) ? arr : []).slice(0, n).map(s => clip(s, max)).filter(Boolean);
  return {
    slug,
    title:         clip(p.title, LIMITS.title) || slug,
    problemNumber: clip(p.problemNumber, LIMITS.problemNumber),
    difficulty:    clip(p.difficulty, LIMITS.difficulty),
    description:   clip(p.description, LIMITS.description),
    cppSnippet:    clip(p.cppSnippet, LIMITS.cppSnippet),
    topicTags:     list(p.topicTags, LIMITS.tags, LIMITS.tag),
    officialHints: list(p.officialHints, LIMITS.hints, LIMITS.hint)
  };
}


// ─────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────

// Only the extension may call this API. ALLOWED_ORIGINS (comma-separated, e.g.
// "chrome-extension://abcdef...") pins it to your published extension ID;
// unset, any chrome-extension:// origin is accepted. Origins can be faked
// outside a browser — the rate limiter is the real abuse protection.
function corsHeaders(request, env) {
  const origin = request.headers.get('Origin') || '';
  const allowed = (env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);
  const ok = allowed.length ? allowed.includes(origin) : origin.startsWith('chrome-extension://');
  if (!ok) return null;
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Expose-Headers': 'X-LeetHint-Cache, X-LeetHint-Cache-Layer, X-LeetHint-Model, X-LeetHint-Format',
    'Vary': 'Origin'
  };
}

function clientError(status, message) {
  const e = new Error(message);
  e.status = status;
  e.expose = true;
  return e;
}

function publicMessage(status) {
  if (status === 429) return 'The AI providers are busy right now — try again in a minute.';
  if (status === 503) return 'LeetHint server is not configured yet.';
  return 'The AI service could not answer — please retry.';
}

function json(data, status = 200, extra = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...extra }
  });
}

// X-LeetHint-Format tells the extension how to read the stream: 'openai', 'workersai' or 'gemini' SSE
function sseResponse(body, kind, cors, extra = {}) {
  return new Response(body, {
    headers: { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store',
               'X-LeetHint-Format': kind, ...cors, ...extra }
  });
}

async function sha256(text) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('');
}
