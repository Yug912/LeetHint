// backend/src/index.js — LeetHint API (Cloudflare Worker)
//
//   POST /v1/generate   { action, problem, code? }  →  the provider's SSE stream, passed through
//   POST /v1/report     { slug, promptVersion, reason, note? }  →  204 (a wrong hint, for review)
//   GET  /config                                     →  feature flags + trial sizes (remote switch)
//   GET  /health                                     →  { ok, providers }
//   GET  /stats?token=<STATS_TOKEN>                  →  today's counters (private; 404 without the token)
//
// Every request may carry X-LeetHint-Install: a random ID made once per
// install (no account, no personal data), used only for fair rate limits.
//
// The extension sends PROBLEM DATA, never a prompt: prompts are built here
// from shared/prompts.js, so this endpoint can only produce LeetHint hints —
// it is useless as a free general-purpose AI proxy.
// API keys live only in Worker secrets (wrangler secret put ...).

import { ACTIONS, LANGUAGES, PROMPT_VERSION, buildPrompt,
         INTERVIEW_STAGES, INTERVIEW_EVENTS } from '../../shared/prompts.js';
import { configuredProviders, describeModels, openStream } from './providers.js';
import { listProblems, fetchProblem, runningContestSlugs } from '../../shared/leetcode.js';
// The Durable Object class must be exported from the Worker's main module
export { ProblemGate } from './gate.js';
export { QuotaKeeper } from './quota.js';
import { quotaClient } from './quota.js';
import { getCached, putCached, hasCache, isCompleteReply, saveReport, useTrial, isAdmittedInterview, admitInterview, isBlocked,
         dayPeriod, weekPeriod, periodResetsAt, bumpCounters, todaysStats } from './store.js';

// Input limits — real LeetCode problems fit comfortably inside these
const LIMITS = {
  slug: 200, title: 300, problemNumber: 10, difficulty: 10,
  description: 30000, cppSnippet: 6000, code: 30000,   // cppSnippet limit also applies to translate snippets
  tags: 30, tag: 60, hints: 10, hint: 1500, failure: 3000
};

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

    // Private stats page: opened in a normal browser tab, so before the
    // extension-only origin check. Without the right token it doesn't exist.
    if (url.pathname === '/stats' && request.method === 'GET') {
      const token = url.searchParams.get('token') || '';
      if (!env.STATS_TOKEN || token !== env.STATS_TOKEN) return json({ error: 'Not found' }, 404);
      return json({ ...(await todaysStats(env) || { note: 'Connect D1 (wrangler.toml) to collect stats.' }),
                    providers: configuredProviders(env).map(p => p.name), config: remoteConfig(env) });
    }

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
      // Answered from [vars]: flip a feature off in the dashboard, no new release
      return json(remoteConfig(env), 200, { ...cors, 'Cache-Control': 'public, max-age=3600' });
    }

    if ((url.pathname === '/v1/generate' || url.pathname === '/v1/report') && request.method === 'POST') {
      try {
        await checkRateLimits(request, env);
        if (url.pathname === '/v1/report') { track(env, ctx, 'report'); return await handleReport(request, env, cors); }
        return await handleGenerate(request, env, ctx, cors);
      } catch (e) {
        console.error(`${url.pathname} failed:`, e.message);
        track(env, ctx, e.code ? `refused:${e.code}${e.fields?.action ? ':' + e.fields.action : ''}` : `error:${e.status || 500}`);
        return errorResponse(e, cors);
      }
    }

    return json({ error: 'Not found' }, 404, cors);
  },

  // Cron (wrangler.toml [triggers]): generate the week's new problems before anyone asks
  async scheduled(event, env, ctx) {
    ctx.waitUntil(prefillNewProblems(env).catch(e => console.error('cron failed:', e.message)));
  }
};

// ─────────────────────────────────────────────
// RATE LIMITS — per install (fair: students on one college network don't
// block each other) with a looser per-IP limit as the backstop
// ─────────────────────────────────────────────
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// The install ID if it looks like one (crypto.randomUUID()), else '' — an old
// extension sends none and is limited by IP alone
export function installIdOf(request) {
  const id = (request.headers.get('X-LeetHint-Install') || '').trim();
  return UUID.test(id) ? id.toLowerCase() : '';
}

async function checkRateLimits(request, env) {
  const installId = installIdOf(request);
  if (await isBlocked(env, installId)) {
    const e = clientError(403, 'This install has been blocked.');
    e.code = 'blocked';
    throw e;
  }
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

function rateLimited() {
  const e = clientError(429, 'Too many requests — wait a minute and try again.');
  e.code = 'rate_limited';
  e.retryAfter = 60;
  return e;
}


// ─────────────────────────────────────────────
// REMOTE SWITCH — GET /config
// ─────────────────────────────────────────────
const flag = (v, fallback) => v === undefined || v === '' ? fallback : !/^(false|0|off|no)$/i.test(String(v));
const count = (v, fallback) => Number.isFinite(Number(v)) && String(v) !== '' ? Math.max(0, Math.floor(Number(v))) : fallback;

export function remoteConfig(env) {
  return {
    interview: flag(env.CONFIG_INTERVIEW, true),
    fix: flag(env.CONFIG_FIX, true),
    trialInterviewsPerWeek: count(env.TRIAL_INTERVIEWS_PER_WEEK, 1),
    trialInterviewMinutes: count(env.TRIAL_INTERVIEW_MINUTES, 15),
    trialFixesPerDay: count(env.TRIAL_FIXES_PER_DAY, 3),
    message: String(env.CONFIG_MESSAGE || '').slice(0, 300)
  };
}


// ─────────────────────────────────────────────
// REPORTS — POST /v1/report: "this hint/solution is wrong", for review
// One report per problem, install and day; kept 90 days
// ─────────────────────────────────────────────
const REPORT_REASONS = ['wrong_solution', 'wrong_hint', 'other'];

async function handleReport(request, env, cors) {
  let body;
  try { body = JSON.parse((await request.text()).slice(0, 5000)); } catch { throw clientError(400, 'Invalid JSON.'); }
  const slug = clip(body?.slug, LIMITS.slug).toLowerCase();
  if (!/^[a-z0-9-]+$/.test(slug)) throw clientError(400, 'Invalid problem slug.');
  const report = {
    slug,
    promptVersion: clip(body.promptVersion, 20),
    reason: REPORT_REASONS.includes(body.reason) ? body.reason : 'other',
    note: clip(body.note, 500),
    at: new Date().toISOString()
  };
  // Who reported only matters for de-duplication: the install ID, or a hash of the IP
  const who = installIdOf(request) || (await sha256(request.headers.get('CF-Connecting-IP') || 'unknown')).slice(0, 16);
  await saveReport(env, { ...report, day: report.at.slice(0, 10), reporter: who });
  console.log(`report ${slug} ${report.reason}`);
  return new Response(null, { status: 204, headers: cors });
}


// ─────────────────────────────────────────────
// GENERATE — POST /v1/generate
// ─────────────────────────────────────────────

// Requests waiting for an AI provider right now (this Worker copy) — the
// "position in line" a busy reply reports
let waiting = 0;

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

  // Trial interviews (every interview that reaches this server — own-key users
  // call their provider directly) skip the separate code-check turns: the
  // interviewer stays silent, and no AI call is made
  if (action === 'interview_turn' && extra.interview.event === 'code' && installIdOf(request)) {
    return silentInterviewTurn(extra.interview.stage, cors);
  }

  const prompt = buildPrompt(action, problem, code, extra);
  const signatureFix = action === 'fix' && body.reason === 'signature' && !extra.failure;
  await checkTrial(env, installIdOf(request), action, extra, signatureFix);
  track(env, ctx, `action:${action}`);

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
    interview_turn: 1200, interview_score: 2500, interview_summary: 600
  }[action] + (extra.language && !translating ? 400 : 0);

  // Translations go to a smaller/faster model first, keeping the big model's
  // budget free for the next problem's hints
  // Interview code checks and "think out loud" nudges are low-stakes, so they
  // too use the small model and leave the accurate one's daily budget for answers
  const quickTurn = action === 'interview_summary' ||
                    (action === 'interview_turn' && (extra.interview.event === 'code' || extra.interview.event === 'nudge'));
  // Real interviewer turns and the scorecard need the strongest models: small
  // ones leak the solution and lose track of the conversation. Each starts on
  // a different model than hints do, so they don't share a per-minute budget
  // Hard hints/solutions/fixes: strong models only, with their full thinking
  // budget (small models and cut-off replies produced the wrong Hard solutions)
  const tier = translating || quickTurn ? 'fast'
             : action === 'interview_score' ? 'judge'
             : interviewing ? 'interview'
             : hard ? 'hard' : 'main';

  // ── Shared cache: same problem + prompt → instant reply for every user ──
  // Keyed by a hash of the FULL prompt, so a client sending a fake statement
  // for a real slug only ever gets (and caches) its own fake result.
  // Interviews are personal conversations — never cached or shared.
  // Fix is the user's own code — except the automatic signature fix: its code
  // came from this same shared cache, so every user sends the same prompt and
  // the fix is made once. (Other code only ever fills its own key.)
  const cacheable = (action !== 'fix' || signatureFix) && !interviewing && hasCache(env);
  const keyFor = (act, lang, p) => cacheKeyFor(act, lang, problem.slug, p);
  const cacheKey = cacheable ? await keyFor(signatureFix ? 'fix-signature' : action, extra.language, prompt) : '';
  // Hints/solution in a user's language also count as the problem's SHARED
  // copy (the plain C++ reply): a later user in any other language gets these
  // hints instantly and only needs a small translation, not a full re-solve.
  // The extra language section is simply ignored by everyone else.
  const sharedKey = cacheable && extra.language && (action === 'hints' || action === 'solve')
    ? await keyFor(action, '', buildPrompt(action, problem, '', {})) : '';
  const cacheKeys = [cacheKey, sharedKey].filter(Boolean);
  for (const key of cacheKeys) {
    const fromMemory = memoryCache.get(key);
    if (fromMemory) track(env, ctx, 'cache:hit:memory');
    if (fromMemory) return sseResponse(fromMemory.raw, fromMemory.kind, cors, { 'X-LeetHint-Cache': 'HIT', 'X-LeetHint-Cache-Layer': 'memory' });
    const stored = await getCached(env, key);
    if (stored) {
      track(env, ctx, `cache:hit:${stored.layer}`);
      rememberReply(key, { raw: stored.raw, kind: stored.kind });
      const layer = stored.layer + (key === cacheKey ? '' : '-shared');
      return sseResponse(stored.raw, stored.kind, cors, { 'X-LeetHint-Cache': 'HIT', 'X-LeetHint-Cache-Layer': layer });
    }
  }

  // ── Stream from the first provider/model that accepts the request ──
  // (logs never include the interview transcript — only the action and slug)
  const tag = `${action}${extra.language ? '-' + extra.language : ''}${interviewing ? '-' + extra.interview.event : ''} ${problem.slug}`;
  const easy = /easy/i.test(problem.difficulty);
  // LeetCode forbids AI help during a live contest: nothing new is generated
  // for a problem whose contest is still running (cached replies can't exist yet)
  if ((await contestSlugs()).has(problem.slug)) {
    const e = clientError(403, 'This problem is in a contest that is running now — hints open when it ends.');
    e.code = 'contest_running';
    throw e;
  }

  // Personal AI (Fix on the user's own code, interviews) counts against the
  // day's trial share in the QuotaKeeper, so hints always keep the rest
  const trial = Boolean(installIdOf(request)) && ((action === 'fix' && !signatureFix) || interviewing);
  const opts = { effort, maxTokens, tier, easy, trial };
  waiting++;
  try {
    // A shareable reply goes through its problem's gate when there is one:
    // everyone opening this problem right now shares ONE AI call
    if (cacheable && env.GATE) {
      const { stream, kind, label, shared } = await throughGate(env, cacheKey, prompt, opts, cacheKeys);
      console.log(`${tag} (${effort}, ${maxTokens} tok) → ${label}${shared ? ' (shared)' : ''}`);
      track(env, ctx, shared ? 'cache:shared' : `ai:${providerOf(label)}`);
      return sseResponse(stream, kind, cors, { 'X-LeetHint-Cache': shared ? 'SHARED' : 'MISS', 'X-LeetHint-Model': label });
    }

    const { upstream, kind, label } = await openStream(env, prompt, opts);
    console.log(`${tag} (${effort}, ${maxTokens} tok) → ${label}`);
    track(env, ctx, `ai:${providerOf(label)}`);

    // The upstream SSE bytes go to the client UNTOUCHED — the Worker never parses
    // the stream. (Parsing every chunk used to exceed the free plan's 10 ms CPU
    // limit, and Cloudflare then cut replies off mid-way.) The extension parses it.
    let stream = upstream.body;
    if (cacheable) {
      const [toClient, toCache] = upstream.body.tee();
      stream = toClient;
      ctx.waitUntil(cacheWhenComplete(env, cacheKeys, toCache, kind));
    }

    // Which provider/model answered (names only) — for diagnosing slow replies
    return sseResponse(stream, kind, cors, { 'X-LeetHint-Cache': 'MISS', 'X-LeetHint-Model': label });
  } catch (e) {
    if (e.trialFull) throw trialUsed(action === 'fix' ? 'fix' : 'interview', 'day');
    // Every provider is at its per-minute limit: a place in line, not an error
    if (e.status === 429) {
      e.code = 'busy';
      e.retryAfter = Math.min(60, Math.max(5, Math.ceil((e.retryAfterMs || 20000) / 1000)));
      e.position = waiting;
    }
    throw e;
  } finally {
    waiting--;
  }
}

// The problem's ProblemGate (Durable Object, one per cache key) makes the AI
// call or lets this request join one already running, and stores the reply
async function throughGate(env, cacheKey, prompt, opts, cacheKeys) {
  const gate = env.GATE.get(env.GATE.idFromName(cacheKey));
  const res = await gate.fetch('https://gate/open', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt, opts, cacheKeys })
  });
  if (!res.ok) {
    const info = await res.json().catch(() => ({}));
    const e = new Error(info.message || 'gate failed');
    e.status = info.status || res.status;
    e.retryAfterMs = info.retryAfterMs;
    throw e;
  }
  return { stream: res.body, kind: res.headers.get('X-LeetHint-Format') || 'openai',
           label: res.headers.get('X-LeetHint-Model') || '?', shared: res.headers.get('X-LeetHint-Shared') === '1' };
}

// ─────────────────────────────────────────────
// MONITORING — daily counters in D1 (GET /stats) and, when bound, an
// Analytics Engine event per counter for the Cloudflare dashboard.
// Written after the reply is sent, so they never slow a user down.
// ─────────────────────────────────────────────
const providerOf = label => String(label).split(' (')[0];   // "Groq (openai/gpt-oss-120b)" → "Groq"

function track(env, ctx, ...names) {
  try { env.EVENTS?.writeDataPoint({ blobs: names, indexes: [names[0]] }); } catch { /* monitoring never breaks a request */ }
  if (env.DB) ctx.waitUntil(bumpCounters(env, names).catch(e => console.warn('stats write skipped:', e.message)));
}

// key = <promptVersion>:<action>[-<language>]:<slug>:<sha256 of the full prompt>
// (hashing the prompt means a fake statement for a real slug only ever fills its own key)
async function cacheKeyFor(action, language, slug, prompt) {
  return `${PROMPT_VERSION}:${action}${language ? '-' + language : ''}:${slug}:${await sha256(prompt)}`.slice(0, 500);
}


// ─────────────────────────────────────────────
// CONTESTS — problems of a running contest, refreshed every 5 minutes per
// Worker copy. If LeetCode can't be reached, the last known list is kept.
// ─────────────────────────────────────────────
const CONTEST_REFRESH_MS = 5 * 60 * 1000;
let contestCache = { at: 0, slugs: new Set() };

async function contestSlugs() {
  if (Date.now() - contestCache.at < CONTEST_REFRESH_MS) return contestCache.slugs;
  contestCache.at = Date.now();   // one refresh at a time, even if it fails
  try {
    contestCache.slugs = await runningContestSlugs();
  } catch (e) {
    console.warn('contest check failed (keeping the last list):', e.message);
  }
  return contestCache.slugs;
}


// ─────────────────────────────────────────────
// CRON — LeetCode adds ~6–8 problems a week (weekend contests). Every run
// takes the newest problems and generates hints for at most a couple that
// aren't cached yet, so each run stays small; several runs on Monday morning
// (wrangler.toml) cover the week. The static-file sync then picks them up.
// ─────────────────────────────────────────────
const CRON_NEWEST = 20;
const CRON_PER_RUN = 2;

export async function prefillNewProblems(env) {
  if (!hasCache(env)) return { generated: [] };
  const inContest = await contestSlugs();
  const newest = (await listProblems({ filters: { orderBy: 'FRONTEND_ID', sortOrder: 'DESCENDING' }, max: CRON_NEWEST }))
    .filter(p => !p.paid && !inContest.has(p.slug));
  const generated = [];
  for (const { slug } of newest) {
    if (generated.length >= CRON_PER_RUN) break;
    const problem = await fetchProblem(slug).catch(() => null);
    if (!problem) continue;
    const prompt = buildPrompt('hints', problem);
    const key = await cacheKeyFor('hints', '', slug, prompt);
    if (await getCached(env, key)) continue;
    const hard = /hard/i.test(problem.difficulty);
    let opened;
    try {
      opened = await openStream(env, prompt, { effort: hard ? 'high' : 'medium', maxTokens: hard ? 8000 : 4500,
                                               tier: hard ? 'hard' : 'main', easy: /easy/i.test(problem.difficulty) });
    } catch (e) {
      console.warn(`cron: ${slug} — ${e.message}`);
      if (e.status === 429) break;   // providers busy: the next run tries again
      continue;
    }
    const raw = await new Response(opened.upstream.body).text();   // read natively, no per-chunk JS
    if (isCompleteReply(raw, opened.kind)) {
      await putCached(env, key, raw, opened.kind);
      generated.push(slug);
      console.log(`cron: ${slug} → ${opened.label}`);
    }
  }
  return { generated };
}


// ─────────────────────────────────────────────
// FREE TRIALS — Fix and the mock interview make a fresh AI call per user, so
// each install gets a small fair share (sizes from /config). A user's own
// key never reaches this server. Without an install ID (old extension) or
// without D1, nothing is counted.
// ─────────────────────────────────────────────
const TRIAL_INTERVIEW_TOKENS = 60_000;   // a 15-minute trial interview, reserved up front

async function checkTrial(env, installId, action, extra, signatureFix) {
  if (!installId) return;
  const config = remoteConfig(env);
  if (action === 'fix' && !signatureFix) {
    if (!await useTrial(env, installId, dayPeriod(), 'fix', config.trialFixesPerDay)) throw trialUsed('fix', 'day');
  }
  // An interview counts once, on the first turn that names it
  const iv = extra.interview;
  if (action === 'interview_turn' && iv?.interviewId && !await isAdmittedInterview(env, iv.interviewId)) {
    if (!await useTrial(env, installId, weekPeriod(), 'interview', config.trialInterviewsPerWeek)) throw trialUsed('interview', 'week');
    // A slot among the few trial interviews allowed at once, with the whole
    // interview's tokens reserved now — so it never dies halfway
    const quota = quotaClient(env);
    if (quota) {
      const room = await quota.admitInterview(iv.interviewId, TRIAL_INTERVIEW_TOKENS).catch(() => ({ ok: true }));
      if (room.reason === 'trialFull') throw trialUsed('interview', 'day');
      if (!room.ok) {
        const e = clientError(429, 'Mock interviews are full right now — try again in a minute.');
        e.code = 'busy';
        e.retryAfter = 60;
        e.position = 1;
        throw e;
      }
    }
    await admitInterview(env, iv.interviewId, installId);
  }
}

function trialUsed(action, period) {
  const e = clientError(403, action === 'fix'
    ? 'Free fixes are used up for today. Add your own free key for unlimited use, or come back tomorrow.'
    : 'Your free mock interview for this week is used. Add your own free key for unlimited interviews.');
  e.code = 'trial_used';
  e.fields = { action, resetsAt: periodResetsAt(period) };
  return e;
}

// Reads the copy of the stream natively (no per-chunk JS) and caches it only
// if the model finished normally and actually wrote an answer — a cut-off
// reply would otherwise be served forever.
async function cacheWhenComplete(env, cacheKeys, stream, kind) {
  try {
    const raw = await new Response(stream).text();
    if (!isCompleteReply(raw, kind)) return;
    for (const key of cacheKeys) {
      rememberReply(key, { raw, kind });
      await putCached(env, key, raw, kind);
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
const INTERVIEW_LIMITS = { turns: 150, text: 1500, code: 20000, refCode: 8000, refText: 1500 };

function sanitizeInterview(iv) {
  if (!iv || typeof iv !== 'object') throw clientError(400, 'Missing interview state.');
  const num = (v, max) => Math.min(max, Math.max(0, Math.floor(Number(v) || 0)));
  const ref = iv.reference && typeof iv.reference === 'object' ? iv.reference : {};
  return {
    event:      INTERVIEW_EVENTS.includes(iv.event) ? iv.event : 'answer',
    stage:      INTERVIEW_STAGES.includes(iv.stage) ? iv.stage : 'intro',
    elapsedSec: num(iv.elapsedSec, 4 * 3600),
    hintsGiven: num(iv.hintsGiven, 50),
    code:       clip(iv.code, INTERVIEW_LIMITS.code),
    history:    (Array.isArray(iv.history) ? iv.history : []).slice(-INTERVIEW_LIMITS.turns)
      .filter(h => h && (h.role === 'interviewer' || h.role === 'candidate'))
      .map(h => ({ role: h.role, text: clip(h.text, INTERVIEW_LIMITS.text) })),
    interviewId: UUID.test(String(iv.interviewId || '')) ? String(iv.interviewId).toLowerCase() : '',
    summary:     clip(iv.summary, 1500),
    durationMin: Number(iv.durationMin) > 0 ? Math.min(60, Math.max(5, Math.floor(Number(iv.durationMin)))) : 0,   // 0 = default length
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

// Errors as JSON. Known conditions carry a machine-readable `error` code
// (rate_limited, busy, …) plus a human `message`; anything else only ever
// shows our own generic message — never upstream details
function errorResponse(e, cors) {
  const status = e.status >= 400 && e.status < 600 ? e.status : 500;
  const message = e.expose ? e.message : publicMessage(status);
  if (e.code === 'busy') {
    return json({ error: 'busy', retryAfter: e.retryAfter, position: e.position, message: publicMessage(429) },
                429, { ...cors, 'Retry-After': String(e.retryAfter) });
  }
  if (e.code) {
    const extra = e.retryAfter ? { 'Retry-After': String(e.retryAfter) } : {};
    return json({ error: e.code, ...(e.retryAfter ? { retryAfter: e.retryAfter } : {}), ...(e.fields || {}), message },
                status, { ...cors, ...extra });
  }
  return json({ error: message }, status, cors);
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

// An interviewer turn that says nothing, in the stream format the extension
// already reads — no AI call needed
function silentInterviewTurn(stage, cors) {
  const content = JSON.stringify({ reply: '', stage, hintGiven: false });
  const chunk = JSON.stringify({ choices: [{ delta: { content }, finish_reason: 'stop' }] });
  return sseResponse(`data: ${chunk}\n\ndata: [DONE]\n\n`, 'openai', cors, { 'X-LeetHint-Cache': 'SKIP' });
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
