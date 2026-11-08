// backend/src/index.js — LeetHint API (Cloudflare Worker)
//
//   POST /v1/generate   { action, problem, code? }  →  the provider's SSE stream, passed through
//   GET  /health                                     →  { ok, providers }
//   GET  /config                                     →  feature switches (cached 1 hour)
//   POST /v1/report     { slug, promptVersion, reason, note? }  →  204
//   GET  /stats?token=  →  today's use per provider + trial budget left (STATS_TOKEN secret)
//
// The extension sends PROBLEM DATA, never a prompt: prompts are built here
// from shared/prompts.js, so this endpoint can only produce LeetHint hints —
// it is useless as a free general-purpose AI proxy.
// API keys live only in Worker secrets (wrangler secret put ...).

import { ACTIONS, LANGUAGES, PROMPT_VERSION, buildPrompt,
         INTERVIEW_STAGES, INTERVIEW_EVENTS, INTERVIEW_MINUTES } from '../../shared/prompts.js';
import { configuredProviders, describeModels, openStream } from './providers.js';
import { quotaClient } from './quota.js';
import { openThroughGate } from './gate.js';
import { refreshNewProblems } from './refresh.js';
import { hasCache, readCache, writeCache, isCompleteReply, cacheableFrom, saveReport, takeTrial, refundTrial, admitInterview,
         isBlocked, utcDay, isoWeek, nextUtcMidnightIso, nextMondayIso } from './store.js';

// Input limits — real LeetCode problems fit comfortably inside these
const LIMITS = {
  slug: 200, title: 300, problemNumber: 10, difficulty: 10,
  description: 30000, cppSnippet: 6000, code: 30000,   // cppSnippet limit also applies to translate snippets
  tags: 30, tag: 60, hints: 10, hint: 1500, failure: 3000
};

// The shared cache lives in D1 (store.js). This small in-memory layer (per
// Worker isolate) answers repeats without a database read — and covers KV's
// ~60 s eventual consistency while KV is still the fallback.
const MEMORY_CACHE_MAX = 200;
const memoryCache = new Map();

function rememberReply(key, text) {
  memoryCache.delete(key);
  memoryCache.set(key, text);
  if (memoryCache.size > MEMORY_CACHE_MAX) memoryCache.delete(memoryCache.keys().next().value);  // oldest
}

export default {
  async fetch(request, env, ctx) {
    const res = await route(request, env, ctx);
    logEvent(env, request, res);
    return res;
  },

  // Monday 06:00 UTC (wrangler.toml [triggers]): pre-generate the newest problems
  async scheduled(event, env, ctx) {
    ctx.waitUntil(refreshNewProblems(env).catch(e => console.warn('refresh failed:', e.message)));
  }
};

async function route(request, env, ctx) {
  const url = new URL(request.url);
  if (url.pathname === '/stats' && request.method === 'GET') return handleStats(url, env);
  const cors = corsHeaders(request, env);

  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
  if (!cors) return json({ error: 'Origin not allowed' }, 403);

  if (url.pathname === '/health' && request.method === 'GET') {
    // Provider and model NAMES only — never anything about the keys themselves
    const health = { ok: true, providers: configuredProviders(env).map(p => p.name) };
    if (url.searchParams.has('models')) health.models = await describeModels(env);
    return json(health, 200, cors);
  }

  if (url.pathname === '/config' && request.method === 'GET') {
    return json(remoteConfig(env), 200, { ...cors, 'Cache-Control': 'public, max-age=3600' });
  }

  if (url.pathname === '/v1/report' && request.method === 'POST') {
    try {
      await guard(request, env);
      return await handleReport(request, env, cors);
    } catch (e) {
      return errorResponse(e, cors);
    }
  }

  if (url.pathname === '/v1/generate' && request.method === 'POST') {
    try {
      await guard(request, env);
      return await handleGenerate(request, env, ctx, cors);
    } catch (e) {
      return errorResponse(e, cors);
    }
  }

  return json({ error: 'Not found' }, 404, cors);
}


// ─────────────────────────────────────────────
// MONITORING — one Analytics Engine event per /v1 request (free, no extra
// CPU: writeDataPoint is fire-and-forget), plus GET /stats for a quick look
// ─────────────────────────────────────────────
const eventInfo = new WeakMap();   // request → { action, trial }
const noteEvent = (request, info) => eventInfo.set(request, { ...eventInfo.get(request), ...info });

function logEvent(env, request, res) {
  if (!env.EVENTS) return;
  const path = new URL(request.url).pathname;
  if (!path.startsWith('/v1/')) return;
  try {
    const info = eventInfo.get(request) || {};
    const outcome = res.status === 429 ? (res.headers.get('X-LeetHint-Error') || 'rate_limited')
                  : res.status === 403 ? (res.headers.get('X-LeetHint-Error') || 'forbidden')
                  : res.status >= 400 ? 'error' : 'ok';
    const model = res.headers.get('X-LeetHint-Model') || '';
    env.EVENTS.writeDataPoint({
      indexes: [path],
      // blob1 action · blob2 cache layer (or "miss") · blob3 provider · blob4 outcome · blob5 trial
      blobs: [info.action || '', res.headers.get('X-LeetHint-Cache-Layer') || (res.headers.get('X-LeetHint-Cache') === 'MISS' ? 'miss' : ''),
              model.split(' (')[0], outcome, info.trial || ''],
      doubles: [res.status]
    });
  } catch (e) {
    console.warn('event log failed:', e.message);
  }
}

// GET /stats?token=<STATS_TOKEN> — today's numbers. Without the right token
// (or with no STATS_TOKEN secret set) it doesn't exist: 404.
async function handleStats(url, env) {
  const token = url.searchParams.get('token') || '';
  if (!env.STATS_TOKEN || token.length !== env.STATS_TOKEN.length || token !== env.STATS_TOKEN) {
    return json({ error: 'Not found' }, 404);
  }
  const q = await quotaClient(env).snapshot();
  const out = {
    day: q.day, dailyTokens: q.dailyTokens,
    tokensReservedByProvider: q.byProvider || {},
    tokensUsedByShare: q.used || {},
    tokensLeftByShare: q.left || {},
    trialShareLeftPercent: q.dailyTokens ? Math.round(100 * (q.left?.trial || 0) / (q.dailyTokens * 0.25)) : null,
    trialInterviewsRunning: q.interviewsRunning || 0,
    pausedUntil: Object.fromEntries(Object.entries(q.paused || {}).map(([k, t]) => [k, new Date(t).toISOString()]))
  };
  if (env.DB) {
    const day = utcDay(), week = isoWeek();
    const rows = (await env.DB.prepare(`SELECT action, SUM(count) AS n, COUNT(*) AS installs FROM usage
                                         WHERE (action = 'fix' AND period = ?) OR (action = 'interview' AND period = ?) GROUP BY action`)
      .bind(day, week).all()).results;
    out.trialsGranted = Object.fromEntries(rows.map(r => [r.action, { count: r.n, installs: r.installs }]));
    out.reportsToday = (await env.DB.prepare('SELECT COUNT(*) AS n FROM reports WHERE day = ?').bind(day).first())?.n || 0;
    out.cachedReplies = (await env.DB.prepare('SELECT COUNT(*) AS n FROM cache').first())?.n || 0;
  }
  return json(out);
}

function errorResponse(e, cors) {
  if (e.body) return json(e.body, e.status, { ...cors, ...e.headers });
  console.error('request failed:', e.message);
  const status = e.status >= 400 && e.status < 600 ? e.status : 500;
  // Only our own (generic) messages reach the client — never upstream details
  return json({ error: e.expose ? e.message : publicMessage(status) }, status, cors);
}

// Every /v1/* request: blocked installs first, then the rate limits
async function guard(request, env) {
  if (await isBlocked(env, installIdOf(request))) throw replyError(403, { error: 'blocked' });
  await rateLimit(request, env);
}

// POST /v1/report — "Report wrong hint". Stored for a weekly look; the slug
// is then regenerated by hand (node tools/prefill.mjs --only <slug> --force)
const REPORT_REASONS = ['wrong_solution', 'wrong_hint', 'other'];
async function handleReport(request, env, cors) {
  const raw = await request.text();
  if (raw.length > 4000) throw clientError(413, 'Request too large.');
  let body;
  try { body = JSON.parse(raw); } catch { throw clientError(400, 'Invalid JSON.'); }
  const slug = clip(body?.slug, LIMITS.slug).toLowerCase();
  if (!/^[a-z0-9-]+$/.test(slug)) throw clientError(400, 'Invalid problem slug.');
  if (!REPORT_REASONS.includes(body.reason)) throw clientError(400, 'Unknown reason.');
  const promptVersion = /^p\d{1,4}$/.test(body.promptVersion) ? body.promptVersion : PROMPT_VERSION;
  // Without an install ID (shouldn't happen: only new versions report), one per IP
  const who = installIdOf(request) || 'ip:' + (await sha256(request.headers.get('CF-Connecting-IP') || 'unknown')).slice(0, 16);
  const stored = await saveReport(env, who, { slug, promptVersion, reason: body.reason, note: clip(body.note, 500) });
  console.log(`report ${slug} ${body.reason}${stored ? '' : ' (duplicate, ignored)'}`);
  return new Response(null, { status: 204, headers: cors });
}

// The anonymous install ID the extension sends (X-LeetHint-Install), or ''
// for old extension versions and anything not shaped like a UUID
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function installIdOf(request) {
  const id = (request.headers.get('X-LeetHint-Install') || '').trim();
  return UUID_RE.test(id) ? id.toLowerCase() : '';
}

// ── Rate limits (Workers Rate Limiting bindings) ──
// Per install (20/min) is the real limit, so testers sharing one Wi-Fi don't
// block each other; the per-IP limit (120/min) is only a backstop. Requests
// without an install ID (old extension versions) get the IP limit alone.
async function rateLimit(request, env) {
  const installId = installIdOf(request);
  if (installId && env.INSTALL_LIMITER) {
    const { success } = await env.INSTALL_LIMITER.limit({ key: installId });
    if (!success) throw rateLimited();
  }
  if (env.RATE_LIMITER) {
    const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
    const { success } = await env.RATE_LIMITER.limit({ key: ip });
    if (!success) throw rateLimited();
  }
}

// Contract: HTTP 403 { error: "trial_used", action, resetsAt }
function trialUsed(action) {
  return replyError(403, { error: 'trial_used', action, resetsAt: action === 'fix' ? nextUtcMidnightIso() : nextMondayIso() });
}

// → null (not a trial) or { refund() }; throws trial_used when none are left
async function checkTrial(env, installId, action, signatureFix, interview) {
  if (!installId) return null;
  // Trial interviews: a new one only while fewer than 3 run and today's trial
  // budget still holds a whole interview (QuotaKeeper)
  if (action.startsWith('interview_') && interview?.interviewId) {
    const quota = quotaClient(env);
    const id = interview.interviewId;
    if (action === 'interview_turn' && interview.event === 'start') {
      const r = await quota.admitInterview({ id });
      if (!r.ok) throw r.reason === 'busy' ? busyError(60000) : trialUsed('interview');
    } else if (action === 'interview_score') await quota.endInterview({ id });
    else await quota.touchInterview({ id });
  }
  if (!env.DB) return null;
  const cfg = remoteConfig(env);
  if (action === 'fix' && !signatureFix) {
    const period = utcDay();
    if (!(await takeTrial(env, installId, 'fix', period, cfg.trialFixesPerDay))) throw trialUsed('fix');
    return { refund: () => refundTrial(env, installId, 'fix', period) };
  }
  // Trial interviews have no separate code-check turns (the editor code still
  // rides along with every spoken turn)
  if (action === 'interview_turn' && interview?.event === 'code') {
    throw replyError(400, { error: 'code_checks_off', message: 'Code checks are not part of free trial interviews.' });
  }
  if (action === 'interview_turn' && interview?.event === 'start' && interview.interviewId) {
    const verdict = await admitInterview(env, installId, interview.interviewId, cfg.trialInterviewsPerWeek);
    if (verdict === 'refused') throw trialUsed('interview');
  }
  return null;   // later turns of an admitted interview are never refused
}

// Contract: every AI provider is at its per-minute limit → a waiting line:
// HTTP 429, Retry-After, { error: "busy", retryAfter, position }. position is
// a best estimate: how many requests this Worker copy sent back to wait in the
// last retryAfter seconds (they will come back before this one).
const recentBusy = [];
export function busyError(retryAfterMs, now = Date.now()) {
  const retryAfter = Math.min(60, Math.max(5, Math.ceil((retryAfterMs > 0 ? retryAfterMs : 20000) / 1000)));
  while (recentBusy.length && recentBusy[0] < now - retryAfter * 1000) recentBusy.shift();
  recentBusy.push(now);
  return replyError(429, { error: 'busy', retryAfter, position: recentBusy.length },
                    { 'Retry-After': String(retryAfter) });
}

// Contract: HTTP 429 { error: "rate_limited", retryAfter: 60 }
function rateLimited() {
  return replyError(429, { error: 'rate_limited', retryAfter: 60, message: 'Too many requests — wait a minute and try again.' },
                    { 'Retry-After': '60' });
}

// GET /config — remote feature switches, from [vars] (editable in the
// Cloudflare dashboard without an extension update)
const flag = (v, dflt) => v === undefined || v === '' ? dflt : !/^(false|0|off|no)$/i.test(String(v).trim());
const count = (v, dflt) => Number.isFinite(parseInt(v, 10)) ? parseInt(v, 10) : dflt;
export function remoteConfig(env) {
  return {
    interview: flag(env.CONFIG_INTERVIEW, true),
    fix: flag(env.CONFIG_FIX, true),
    trialInterviewsPerWeek: count(env.CONFIG_TRIAL_INTERVIEWS_PER_WEEK, 1),
    trialInterviewMinutes: count(env.CONFIG_TRIAL_INTERVIEW_MINUTES, 15),
    trialFixesPerDay: count(env.CONFIG_TRIAL_FIXES_PER_DAY, 3),
    message: String(env.CONFIG_MESSAGE || '').slice(0, 300)
  };
}

async function handleGenerate(request, env, ctx, cors) {
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
  // Fix: what LeetCode reported for this code (failing test or compile error)
  if (action === 'fix') extra.failure = clip(body.failure, LIMITS.failure);
  if (action === 'translate_all') {
    extra.languages = [...new Set(Array.isArray(body.languages) ? body.languages : [])].filter(isLanguage).sort();
    if (!extra.languages.length) throw clientError(400, 'No languages given.');
    const snippets = body.snippets && typeof body.snippets === 'object' ? body.snippets : {};
    extra.snippets = Object.fromEntries(extra.languages.map(l => [l, clip(snippets[l], LIMITS.cppSnippet)]));
  }
  const interviewing = action === 'interview_turn' || action === 'interview_score' || action === 'interview_summary';
  if (interviewing) extra.interview = sanitizeInterview(body.interview);

  const prompt = buildPrompt(action, problem, code, extra);

  // ── Free trials (D1): Fix and mock interviews are counted per install ID.
  // The signature fix is automatic, not a trial; requests without an install
  // ID (old extension versions) aren't counted.
  const installId = installIdOf(request);
  noteEvent(request, { action });
  const trial = await checkTrial(env, installId, action, body.reason === 'signature' && !extra.failure, extra.interview)
    .catch(e => { if (e.body?.error === 'trial_used') noteEvent(request, { trial: 'refused' }); throw e; });
  if (trial) noteEvent(request, { trial: 'granted' });

  // More thinking where it pays off: Hard problems get "high" reasoning;
  // translation of already-verified code needs little
  const translating = action === 'translate' || action === 'translate_all';
  const hard = /hard/i.test(problem.difficulty);
  // lowEffort: the extension's retry after a reply whose thinking used up the
  // whole token budget before any answer was written
  // Interviewer turns are short spoken replies — low reasoning keeps them
  // fast enough for a conversation (the hidden reference does the judging);
  // the scorecard is graded once, so it gets more thought
  const effort = translating || action === 'interview_turn' || action === 'interview_summary' || body.lowEffort === true ? 'low'
               : action === 'interview_score' ? 'medium' : hard ? 'high' : 'medium';

  // Ask only for the tokens each job needs (thinking included) — free tiers
  // count the requested maximum against a tokens/minute budget, so smaller
  // requests mean more problems per minute
  // Hard problems also cross-check against a brute force in their reasoning,
  // which needs room — a reply cut off mid-thought is worse than a slow one
  const maxTokens = {
    hints: hard ? 8000 : 4500, solve: hard ? 7000 : 3500, fix: hard ? 6000 : 4000,
    translate: 1500, translate_all: 500 + 650 * (extra.languages?.length || 0),
    interview_turn: 1200, interview_score: 2500, interview_summary: 800
  }[action] + (extra.language && !translating ? 400 : 0);

  // Translations go to a smaller/faster model first, keeping the big model's
  // budget free for the next problem's hints
  // Interview code checks and "think out loud" nudges are low-stakes, so they
  // too use the small model and leave the accurate one's daily budget for answers
  const quickTurn = action === 'interview_turn' && (extra.interview.event === 'code' || extra.interview.event === 'nudge');
  // Real interviewer turns and the scorecard need the strongest models: small
  // ones leak the solution and lose track of the conversation. Each starts on
  // a different model than hints do, so they don't share a per-minute budget
  // Hard hints/solutions/fixes: strong models only, with their full thinking
  // budget (small models and cut-off replies produced the wrong Hard solutions)
  const tier = translating || quickTurn || action === 'interview_summary' ? 'fast'
             : action === 'interview_score' ? 'judge'
             : interviewing ? 'interview'
             : hard ? 'hard' : 'main';

  // ── Shared cache: same problem + prompt → instant reply for every user ──
  // Keyed by a hash of the FULL prompt, so a client sending a fake statement
  // for a real slug only ever gets (and caches) its own fake result.
  // Interviews are personal conversations — never cached or shared.
  // Fix is personal too, EXCEPT the automatic signature fix: the code being
  // fixed came from the shared cache, so every user sends the same prompt and
  // gets the same stored fix. Other code only ever fills its own key.
  const signatureFix = action === 'fix' && body.reason === 'signature' && !extra.failure;
  const cacheable = (action !== 'fix' || signatureFix) && !interviewing && hasCache(env);
  const keyFor = async (act, lang, p) => `${PROMPT_VERSION}:${act}${lang ? '-' + lang : ''}:${problem.slug}:${await sha256(p)}`.slice(0, 500);
  const cacheKey = cacheable ? await keyFor(action, signatureFix ? 'signature' : extra.language, prompt) : '';
  // Hints/solution in a user's language also count as the problem's SHARED
  // copy (the plain C++ reply): a later user in any other language gets these
  // hints instantly and only needs a small translation, not a full re-solve.
  // The extra language section is simply ignored by everyone else.
  const sharedKey = cacheable && extra.language && (action === 'hints' || action === 'solve')
    ? await keyFor(action, '', buildPrompt(action, problem, '', {})) : '';
  const cacheKeys = [cacheKey, sharedKey].filter(Boolean);
  for (const key of cacheKeys) {
    const fromMemory = memoryCache.get(key);
    if (fromMemory) return sseResponse(fromMemory.raw, fromMemory.kind, cors, { 'X-LeetHint-Cache': 'HIT', 'X-LeetHint-Cache-Layer': 'memory' });
    const hit = await readCache(env, key);
    if (hit) {
      rememberReply(key, { raw: hit.raw, kind: hit.kind });
      return sseResponse(hit.raw, hit.kind, cors, { 'X-LeetHint-Cache': 'HIT', 'X-LeetHint-Cache-Layer': key === cacheKey ? hit.layer : hit.layer + '-shared' });
    }
  }

  // ── Stream from the first provider/model that accepts the request ──
  // (logs never include the interview transcript — only the action and slug)
  const tag = `${action}${extra.language ? '-' + extra.language : ''}${interviewing ? '-' + extra.interview.event : ''} ${problem.slug}`;
  const easy = /easy/i.test(problem.difficulty);
  // Which part of the day's budget pays: Fix (a user's own code) and mock
  // interviews are trials (25%); everything shared by all users is hints (70%)
  const share = (action === 'fix' && !signatureFix) || interviewing ? 'trial' : 'hints';
  // A cache miss goes through its ProblemGate when bound: identical misses
  // arriving together share one AI call (and the gate writes the cache)
  const opts = { effort, maxTokens, tier, easy, share };
  const open = cacheable && env.GATE ? openThroughGate(env, cacheKey, prompt, opts, cacheKeys) : openStream(env, prompt, opts);
  const { upstream, kind, label, gated } = await open.catch(async e => {
    await trial?.refund();   // nothing was generated — the trial isn't used up
    if (e.dailyShare === 'trial') throw trialUsed(action === 'fix' ? 'fix' : 'interview');
    throw e.busy ? busyError(e.retryAfterMs) : e;
  });
  console.log(`${tag} (${effort}, ${maxTokens} tok) → ${label}`);

  // The upstream SSE bytes go to the client UNTOUCHED — the Worker never parses
  // the stream. (Parsing every chunk used to exceed the free plan's 10 ms CPU
  // limit, and Cloudflare then cut replies off mid-way.) The extension parses it.
  let stream = upstream.body;
  if (cacheable && !gated) {
    const [toClient, toCache] = upstream.body.tee();
    stream = toClient;
    ctx.waitUntil(cacheWhenComplete(env, cacheKeys, toCache, kind, label));
  }

  // Which provider/model answered (names only) — for diagnosing slow replies
  return sseResponse(stream, kind, cors, { 'X-LeetHint-Cache': 'MISS', 'X-LeetHint-Model': label });
}

// Reads the copy of the stream natively (no per-chunk JS) and caches it only
// if the model finished normally and actually wrote an answer — a cut-off
// reply would otherwise be served forever.
async function cacheWhenComplete(env, cacheKeys, stream, kind, label) {
  try {
    const raw = await new Response(stream).text();
    if (!isCompleteReply(raw, kind)) return;
    for (const key of cacheKeys) {
      if (!cacheableFrom(key, label)) { console.log(`not cached (small model): ${label}`); continue; }
      rememberReply(key, { raw, kind });
      await writeCache(env, key, raw, kind);
    }
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


// Mock interview state from the extension — known fields only, all clipped.
// The transcript is the candidate's own conversation, so it's bounded here
// and trimmed again (oldest turns first) when the prompt is built.
const INTERVIEW_LIMITS = { turns: 150, text: 1500, code: 20000, refCode: 8000, refText: 1500, summary: 1500 };

function sanitizeInterview(iv) {
  if (!iv || typeof iv !== 'object') throw clientError(400, 'Missing interview state.');
  const num = (v, max) => Math.min(max, Math.max(0, Math.floor(Number(v) || 0)));
  const ref = iv.reference && typeof iv.reference === 'object' ? iv.reference : {};
  return {
    interviewId: UUID_RE.test(iv.interviewId || '') ? iv.interviewId.toLowerCase() : '',
    event:      INTERVIEW_EVENTS.includes(iv.event) ? iv.event : 'answer',
    stage:      INTERVIEW_STAGES.includes(iv.stage) ? iv.stage : 'intro',
    elapsedSec: num(iv.elapsedSec, 4 * 3600),
    durationMin: num(iv.durationMin, 120) || INTERVIEW_MINUTES,
    summary:    clip(iv.summary, INTERVIEW_LIMITS.summary),
    hintsGiven: num(iv.hintsGiven, 50),
    code:       clip(iv.code, INTERVIEW_LIMITS.code),
    history:    (Array.isArray(iv.history) ? iv.history : []).slice(-INTERVIEW_LIMITS.turns)
      .filter(h => h && (h.role === 'interviewer' || h.role === 'candidate'))
      .map(h => ({ role: h.role, text: clip(h.text, INTERVIEW_LIMITS.text) })),
    rejected: ['leak', 'repeat'].includes(iv.rejected?.reason)
      ? { reason: iv.rejected.reason, draft: clip(iv.rejected.draft, 600) } : null,
    reference: {
      approach: clip(ref.approach, INTERVIEW_LIMITS.refText),
      pattern:  clip(ref.pattern, 100),
      tc:       clip(ref.tc, 100),
      sc:       clip(ref.sc, 100),
      code:     clip(ref.code, INTERVIEW_LIMITS.refCode)
    }
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
    'Access-Control-Allow-Headers': 'Content-Type, X-LeetHint-Install',
    'Access-Control-Expose-Headers': 'X-LeetHint-Cache, X-LeetHint-Cache-Layer, X-LeetHint-Model, X-LeetHint-Format, Retry-After',
    'Vary': 'Origin'
  };
}

function clientError(status, message) {
  const e = new Error(message);
  e.status = status;
  e.expose = true;
  return e;
}

// An error answered with an exact JSON body (the shared contract's error shapes)
function replyError(status, body, headers = {}) {
  const e = new Error(body.error);
  e.status = status;
  e.body = body;
  e.headers = { 'X-LeetHint-Error': body.error, ...headers };
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

// Durable Object classes must be exported by the Worker's main module
export { QuotaKeeper } from './quota.js';
export { ProblemGate } from './gate.js';
