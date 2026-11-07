// backend/src/providers.js
// AI providers, called with SERVER-SIDE keys (Worker secrets — never sent to
// the extension).
//
// Staying fast under free-tier limits:
//  • Model discovery — each provider's /models list says which models this
//    key can actually use, so retired models are never tried.
//  • Per-model token buckets — free tiers limit tokens/minute PER MODEL
//    (Groq: ~8,000, and it counts max_tokens up front). The rate-limit headers
//    of every reply are tracked, and each request goes to a model that still
//    has room, instead of hitting a 429 first.
//  • Right-sized requests — each action asks only for the tokens it needs, so
//    more requests fit in a minute.
//  • A short limit (a few seconds) is waited out instead of failing.

const TEMPERATURE = 0.1;

// Fastest first: Cerebras and Groq run these models at hundreds-to-thousands
// of tokens/s. Override with PROVIDER_ORDER.
const DEFAULT_ORDER = ['cerebras', 'groq', 'workersai', 'openrouter', 'gemini'];

// Never pick these from a /models list (speech, safety, embedding models...)
const NOT_CHAT = /whisper|tts|guard|playai|orpheus|compound|embed|vision|audio|transcri|moderation|allam|image/i;

// prefer.main: solving + hints (accuracy first). prefer.fast: translation of
// verified code (a smaller model is enough — and it keeps the big model's
// token budget free for the next problem). prefer.interview: mock interview
// turns, prefer.judge: the scorecard — large models only (small ones leak the
// solution). Each feature starts on a DIFFERENT model where it can, so a busy
// interview never takes the per-minute budget that hints need, and vice versa.
// prefer.hard: Hard problems' hints/solutions/fixes — large models only, and
// ones that can use the full thinking budget come first.
const PROVIDERS = {
  cerebras: {
    name: 'Cerebras',
    secret: 'CEREBRAS_API_KEY',
    kind: 'openai',
    endpoint: 'https://api.cerebras.ai/v1/chat/completions',
    modelsUrl: 'https://api.cerebras.ai/v1/models',
    prefer: {
      main: [/gpt-oss-120b/, /qwen-3-235b.*thinking/, /qwen-3-235b/, /qwen-3-coder/, /llama-4-maverick/, /llama-3\.3-70b/],
      fast: [/llama-4-scout/, /llama-3\.3-70b/, /qwen-3-coder/, /gpt-oss-120b/, /qwen-3/],
      interview: [/qwen-3-235b/, /gpt-oss-120b/],
      judge: [/gpt-oss-120b/, /qwen-3-235b/],
      hard: [/gpt-oss-120b/, /qwen-3-235b.*thinking/, /qwen-3-235b/]
    },
    fallback: ['gpt-oss-120b']
  },
  groq: {
    name: 'Groq',
    secret: 'GROQ_API_KEY',
    kind: 'openai',
    endpoint: 'https://api.groq.com/openai/v1/chat/completions',
    modelsUrl: 'https://api.groq.com/openai/v1/models',
    prefer: {
      main: [/gpt-oss-120b/, /gpt-oss-20b/, /kimi-k2/, /qwen3/, /deepseek-r1/, /llama-4-maverick/, /llama-3\.3-70b/, /llama-4-scout/],
      fast: [/gpt-oss-20b/, /llama-4-scout/, /llama-4-maverick/, /llama-3\.3-70b/, /kimi-k2/, /gpt-oss-120b/, /qwen3/],
      interview: [/qwen3/, /kimi-k2/, /gpt-oss-120b/],
      judge: [/gpt-oss-120b/, /kimi-k2/, /qwen3/],
      hard: [/gpt-oss-120b/, /kimi-k2/]
    },
    fallback: ['openai/gpt-oss-120b', 'openai/gpt-oss-20b'],
    tokensPerMinute: 8000   // free tier, per model; refined from response headers
  },
  openrouter: {
    name: 'OpenRouter',
    secret: 'OPENROUTER_API_KEY',
    kind: 'openai',
    endpoint: 'https://openrouter.ai/api/v1/chat/completions',
    headers: { 'HTTP-Referer': 'https://github.com/Yug912/AlgoMentor', 'X-Title': 'LeetHint' },
    // Paid model first; the :free variants keep working when credits run out
    fallback: ['deepseek/deepseek-r1', 'openai/gpt-oss-120b:free', 'deepseek/deepseek-r1:free', 'qwen/qwen3-coder:free']
  },
  // Cloudflare Workers AI — FREE with the Cloudflare account (daily allowance),
  // no API key: it's reached through the Worker's AI binding (wrangler.toml).
  // Its per-minute limits are generous, so it takes over when Groq is busy.
  workersai: {
    name: 'Workers AI',
    binding: 'AI',
    kind: 'workersai',
    // Free-plan models only — others (DeepSeek V4, Kimi, GLM) answer
    // 5035 "not available on the Workers Free plan". Slower than Groq
    // (~10-20 s), so it's the overflow when Groq is busy, not the first choice.
    tiers: {
      main: ['@cf/openai/gpt-oss-120b', '@cf/openai/gpt-oss-20b'],
      fast: ['@cf/openai/gpt-oss-20b', '@cf/openai/gpt-oss-120b'],
      interview: ['@cf/openai/gpt-oss-120b'],
      judge: ['@cf/openai/gpt-oss-120b'],
      hard: ['@cf/openai/gpt-oss-120b']
    }
  },
  gemini: {
    name: 'Gemini',
    secret: 'GEMINI_API_KEY',
    kind: 'gemini',
    // Each Gemini model has its OWN free quota — the lite model often still has room
    fallback: ['gemini-3.8-flash', 'gemini-flash-latest', 'gemini-flash-lite-latest']
  }
};

// Errors that only concern ONE model — the provider's next model may still work.
// Server errors count too: Gemini's models each fail (and time out) on their own
const MODEL_SPECIFIC_STATUS = [402, 404, 413, 429, 500, 502, 503, 504, 524];

// A model that hasn't started answering by now is given up on (it was seen
// hanging ~2 minutes before a 524). Only the wait for the FIRST byte is
// limited — once a reply streams, it may take as long as it needs.
const FIRST_BYTE_MS = 45000;

// Longest wait for a rate limit before giving up — beats showing an error
const MAX_WAIT_MS = 8000;

export function configuredProviders(env) {
  workersAiOverride = (env.WORKERSAI_MODELS || '').split(',').map(s => s.trim()).filter(Boolean);
  const order = (env.PROVIDER_ORDER || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
  return (order.length ? order : DEFAULT_ORDER)
    .map(id => PROVIDERS[id])
    .filter(cfg => cfg && (cfg.binding ? env[cfg.binding] : env[cfg.secret]))
    .filter(cfg => !(pausedUntil.get(cfg.name) > Date.now()));
}

// A provider whose DAILY allowance is used up is skipped until it resets
// (Workers AI: midnight UTC) — no point asking it on every request
const pausedUntil = new Map();
// Same for one model ("Provider/model") — e.g. Groq's 200,000 tokens/day per model
const modelPausedUntil = new Map();
const nextUtcMidnight = () => { const d = new Date(); d.setUTCHours(24, 0, 0, 0); return d.getTime(); };

function apiError(label, status, msg, retryAfterMs) {
  const e = new Error(`${label}: ${msg}`);
  e.status = status;
  e.retryAfterMs = retryAfterMs;   // NaN if unknown
  return e;
}

// Rough count (~3.5 chars per token) — only used to plan around tokens/minute caps
const estimateTokens = text => Math.ceil(String(text).length / 3.5);

// "7.66s", "1m2.5s", "450ms" → milliseconds
function parseDuration(s) {
  let ms = 0;
  for (const [, v, unit] of String(s || '').matchAll(/([\d.]+)\s*(ms|h|m|s)/g)) {
    ms += parseFloat(v) * ({ ms: 1, s: 1000, m: 60000, h: 3600000 })[unit];
  }
  return ms || NaN;
}


// ─────────────────────────────────────────────
// MODEL DISCOVERY — cached per Worker isolate for 30 minutes
// ─────────────────────────────────────────────
const discovered = new Map();   // provider name → { ids, at }

async function availableModels(cfg, apiKey) {
  if (!cfg.modelsUrl) return null;
  const hit = discovered.get(cfg.name);
  if (hit && Date.now() - hit.at < 30 * 60 * 1000) return hit.ids;
  try {
    const res = await fetch(cfg.modelsUrl, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(4000)
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const ids = ((await res.json()).data || []).map(m => m.id).filter(id => id && !NOT_CHAT.test(id));
    discovered.set(cfg.name, { ids, at: Date.now() });
    return ids;
  } catch (e) {
    console.warn(`${cfg.name}: model list unavailable (${e.message}) — using defaults`);
    return null;
  }
}

// Available models ranked by this provider's preference for the tier
// WORKERSAI_MODELS (wrangler.toml [vars], comma-separated) overrides the
// Workers AI model order for solving — handy when its catalog changes
let workersAiOverride = [];

async function modelsFor(cfg, apiKey, tier) {
  if (cfg.tiers) {
    if (cfg.kind === 'workersai' && tier === 'main' && workersAiOverride.length) return [...workersAiOverride];
    return [...(cfg.tiers[tier] || cfg.tiers.main)];
  }
  const prefs = cfg.prefer?.[tier] || cfg.prefer?.main;
  const ids = prefs ? await availableModels(cfg, apiKey) : null;
  if (!ids) return [...cfg.fallback];
  const ranked = [];
  for (const re of prefs) for (const id of ids) if (re.test(id) && !ranked.includes(id)) ranked.push(id);
  return ranked.length ? ranked : [...cfg.fallback];
}

// For /health — names of the models each provider can use (no keys involved)
export async function describeModels(env) {
  const out = {};
  for (const cfg of configuredProviders(env)) {
    out[cfg.name] = await modelsFor(cfg, env[cfg.secret], 'main');
  }
  return out;
}


// ─────────────────────────────────────────────
// TOKEN BUCKETS — tokens/minute left per model, from rate-limit headers
// ─────────────────────────────────────────────
const buckets = new Map();   // "Provider/model" → { remaining, limit, at }

function recordBucket(key, remaining, limit) {
  if (!Number.isFinite(remaining)) return;
  const prev = buckets.get(key);
  buckets.set(key, { remaining, limit: Number.isFinite(limit) ? limit : prev?.limit, at: Date.now() });
}

function recordFromHeaders(key, headers) {
  recordBucket(key, parseFloat(headers.get('x-ratelimit-remaining-tokens')),
                    parseFloat(headers.get('x-ratelimit-limit-tokens')));
}

// The 429 text says exactly where the bucket stands: "Limit 8000, Used 3990"
function recordFromMessage(key, msg) {
  const m = msg.match(/Limit\s+(\d+),\s*Used\s+(\d+)/i);
  if (m) recordBucket(key, Number(m[1]) - Number(m[2]), Number(m[1]));
}

// Tokens available now, assuming the bucket refills evenly over a minute
function availableTokens(key, cfg) {
  const b = buckets.get(key);
  if (!b) return Infinity;
  const limit = b.limit || cfg.tokensPerMinute;
  if (!limit) return b.remaining;
  return Math.min(limit, b.remaining + (Date.now() - b.at) / 60000 * limit);
}

// How long until a model's bucket holds `need` tokens again (Infinity if unknown)
function refillWaitMs(key, cfg, need) {
  const b = buckets.get(key);
  const limit = b?.limit || cfg.tokensPerMinute;
  if (!b || !limit || need > limit) return Infinity;
  return Math.max(0, (need - availableTokens(key, cfg)) / limit * 60000);
}

function maxTokensFor(cfg, prompt, wanted) {
  if (!cfg.tokensPerMinute) return wanted;
  // A request larger than the whole per-minute budget is rejected outright
  const cap = cfg.tokensPerMinute - estimateTokens(prompt) - 300;
  return Math.max(1024, Math.min(wanted, cap));
}


// ─────────────────────────────────────────────
// REQUESTS
// ─────────────────────────────────────────────

// Reasoning effort ('low' | 'medium' | 'high') — only GPT-OSS models take the
// parameter; sending it to others can get the request rejected
function reasoningParams(cfg, model, effort, easy = false) {
  if (!effort || !/gpt-oss/i.test(model)) return {};
  // Under a tight tokens/minute cap, "high" thinking can use up the whole
  // token budget before a single word of the answer is written
  if (cfg.tokensPerMinute && effort === 'high') effort = 'medium';
  // The small model overthinks easy problems: on "medium" it spent 4,000+
  // tokens reasoning about an Easy one and never wrote an answer
  if (/gpt-oss-20b/i.test(model) && easy) effort = 'low';
  return cfg.name === 'OpenRouter' ? { reasoning: { effort } } : { reasoning_effort: effort };
}

// Groq streams a model's private reasoning by default — it only makes the
// reply bigger, so ask for the answer alone
function hideReasoningParams(cfg, model) {
  if (cfg.name !== 'Groq') return {};
  if (/gpt-oss/i.test(model)) return { include_reasoning: false };
  if (/qwen/i.test(model)) return { reasoning_format: 'hidden' };
  return {};
}

// plain: send no optional parameters (used if a model rejects one of them)
function buildRequest(cfg, apiKey, model, prompt, { effort, maxTokens, easy }, plain = false) {
  if (cfg.kind === 'gemini') {
    return {
      url: `https://generativelanguage.googleapis.com/v1beta/models/${model}:streamGenerateContent?alt=sse`,
      init: {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          // Gemini counts thinking inside maxOutputTokens — give it room
          generationConfig: { temperature: TEMPERATURE, maxOutputTokens: Math.max(maxTokens, 12000) }
        })
      }
    };
  }
  return {
    url: cfg.endpoint,
    init: {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json', ...cfg.headers },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: prompt }],
        temperature: TEMPERATURE,
        max_tokens: maxTokensFor(cfg, prompt, maxTokens),
        stream: true,
        ...(plain ? {} : { ...reasoningParams(cfg, model, effort, easy), ...hideReasoningParams(cfg, model) })
      })
    }
  };
}

// Opens a streaming reply from the first provider/model that accepts the
// request. Returns { upstream: Response, kind, label }. Nothing has been sent
// to the client yet, so falling through to the next model is invisible.
//
// opts: { effort, maxTokens, tier: 'main' | 'fast' | 'interview' | 'judge' | 'hard' }
export async function openStream(env, prompt, opts = {}) {
  const { tier = 'main', maxTokens = 6000 } = opts;
  const providers = configuredProviders(env);
  if (!providers.length) throw apiError('LeetHint server', 503, 'no AI provider is configured');

  // Every (provider, model) pair, in preference order — minus models whose
  // daily limit is used up
  const candidatesFor = async t => {
    const out = [];
    for (const cfg of providers) {
      for (const model of await modelsFor(cfg, env[cfg.secret], t)) {
        if (!(modelPausedUntil.get(`${cfg.name}/${model}`) > Date.now())) out.push({ cfg, model });
      }
    }
    return out;
  };
  const candidates = await candidatesFor(tier);
  // Interview: every strong model is tried (even one that looks busy) before
  // the smaller main-tier models, which are only a last resort
  const backup = tier === 'interview' || tier === 'judge' || tier === 'hard'
    ? (await candidatesFor('main')).filter(b => !candidates.some(c => c.cfg === b.cfg && c.model === b.model))
    : [];

  // Models with enough tokens left this minute go first — no wasted 429s
  const need = c => estimateTokens(prompt) + maxTokensFor(c.cfg, prompt, maxTokens);
  const hasRoom = c => availableTokens(`${c.cfg.name}/${c.model}`, c.cfg) >= need(c);
  const byRoom = list => [...list.filter(hasRoom), ...list.filter(c => !hasRoom(c))];
  // Hard: a model that must cut the reply short to fit its tokens/minute cap
  // (Groq's free tier) goes after the ones that can think as long as asked
  const fullBudget = c => maxTokensFor(c.cfg, prompt, maxTokens) >= maxTokens;
  const byBudget = list => tier === 'hard' ? [...list.filter(fullBudget), ...list.filter(c => !fullBudget(c))] : list;
  let ordered = [...byBudget(byRoom(candidates)), ...byRoom(backup)];

  // Accuracy: for solving and grading, the best model is worth a short wait —
  // if its budget refills within ~5 s, wait for it instead of using a smaller
  // model. Interview turns are a live conversation: they move straight on to
  // the next free model instead.
  const best = candidates[0];
  if ((tier === 'main' || tier === 'judge') && best && !hasRoom(best)) {
    const waitMs = refillWaitMs(`${best.cfg.name}/${best.model}`, best.cfg, need(best));
    if (waitMs <= 5000) {
      await new Promise(r => setTimeout(r, waitMs + 100));
      ordered = [best, ...ordered.filter(c => c !== best)];
    }
  }

  const errors = [];
  const limited = [];   // { c, waitMs } — rate-limited, may be worth waiting for
  const deadProviders = new Set();

  const attempt = async (c, plain = false) => {
    const key = `${c.cfg.name}/${c.model}`;
    const label = `${c.cfg.name} (${c.model})`;
    if (c.cfg.kind === 'workersai') return attemptWorkersAI(c, label);
    const { url, init } = buildRequest(c.cfg, env[c.cfg.secret], c.model, prompt, opts, plain);
    let res;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), FIRST_BYTE_MS);
    try {
      res = await fetch(url, { ...init, signal: ctrl.signal });
    } catch (e) {
      if (ctrl.signal.aborted) {
        // Too slow to start — this model only; the provider's next one may be fine
        errors.push(apiError(label, 504, `no response in ${FIRST_BYTE_MS / 1000} s`));
        console.log(`refused: ${label} no response in ${FIRST_BYTE_MS / 1000} s`);
      } else {
        deadProviders.add(c.cfg.name);   // network failure → skip the rest of this provider
        errors.push(apiError(label, 0, e.message));
      }
      return null;
    } finally {
      clearTimeout(timer);   // headers arrived (or failed): the stream itself is never cut
    }
    // Only a refusal tells the truth about a model's budget: on success Groq's
    // "remaining" header still counts this request's FULL max_tokens
    // reservation (refunded later), which made the best model look busy for
    // ~35 s after every question. A refused attempt costs only ~0.3 s.
    if (res.ok) return { upstream: res, kind: c.cfg.kind, label };
    recordFromHeaders(key, res.headers);

    const body = await res.json().catch(() => ({}));
    const msg = body.error?.message || `HTTP ${res.status}`;
    // An optional parameter (reasoning_effort, include_reasoning...) was rejected → once without
    if (res.status === 400 && !plain && /reasoning|include_|parameter/i.test(msg)) return attempt(c, true);
    const perDay = /per day|\bTPD\b|\bRPD\b/i.test(msg);
    if (res.status === 429 && !perDay) recordFromMessage(key, msg);
    const waitMs = parseFloat(res.headers.get('retry-after')) * 1000 ||
                   parseDuration(msg.match(/try again in ([\dhms.]+)/i)?.[1]);
    const err = apiError(label, res.status, msg, perDay ? NaN : waitMs);
    errors.push(err);
    console.log(`refused: ${label} ${res.status} ${msg.replace(/org_\w+/g, 'org').slice(0, 160)}`);

    // DAILY limit (Groq: "tokens per day (TPD)") — don't ask again until it resets
    if (res.status === 429 && /per day|\bTPD\b|\bRPD\b/i.test(msg)) {
      modelPausedUntil.set(key, Date.now() + (waitMs > 0 ? waitMs : 3600000));
      console.warn(`${label}: daily limit reached — skipped for ${Math.round((waitMs > 0 ? waitMs : 3600000) / 60000)} min`);
      return null;
    }
    if (res.status === 429) limited.push({ c, waitMs });

    const modelSpecific = MODEL_SPECIFIC_STATUS.includes(res.status) ||
                          (res.status === 400 && /model/i.test(msg));
    if (!modelSpecific) deadProviders.add(c.cfg.name);   // bad key / server error
    return null;
  };

  // Workers AI is called through the binding, not fetch(); its stream is
  // passed through untouched like every other provider's
  async function attemptWorkersAI(c, label) {
    try {
      const stream = await env[c.cfg.binding].run(c.model, {
        messages: [{ role: 'user', content: prompt }],
        stream: true,
        temperature: TEMPERATURE,
        // No tokens/minute cap here — leave room for the model's thinking
        max_tokens: maxTokens + 2000
      });
      return { upstream: new Response(stream), kind: 'workersai', label };
    } catch (e) {
      const msg = String(e?.message || e);
      const daily = /4006|daily free allocation|neurons/i.test(msg);
      errors.push(apiError(label, daily || /429|rate limit|capacity/i.test(msg) ? 429 : 500, msg));
      if (daily) {
        pausedUntil.set(c.cfg.name, nextUtcMidnight());
        deadProviders.add(c.cfg.name);
        console.warn('Workers AI daily allowance used up — paused until midnight UTC');
      }
      return null;   // otherwise: try its next model
    }
  }

  for (const c of ordered) {
    if (deadProviders.has(c.cfg.name)) continue;
    const opened = await attempt(c);
    if (opened) return opened;
  }

  // Everything is rate-limited, but one model frees up within a few seconds:
  // waiting is much better than showing an error
  const soonest = limited.filter(l => l.waitMs > 0).sort((a, b) => a.waitMs - b.waitMs)[0];
  if (soonest && soonest.waitMs <= MAX_WAIT_MS) {
    console.log(`All models busy — waiting ${Math.round(soonest.waitMs)} ms for ${soonest.c.model}`);
    await new Promise(r => setTimeout(r, soonest.waitMs + 250));
    const opened = await attempt(soonest.c);
    if (opened) return opened;
  }

  // Log the details server-side; the client only gets a generic message
  console.warn('All providers failed:', errors.map(e => e.message).join(' | '));
  const allLimited = errors.length && errors.every(e => e.status === 429 || e.status === 402);
  // When every model is busy, say how long until the first one frees up, so
  // the extension can wait in line instead of showing an error
  const err = apiError('LeetHint server', allLimited ? 429 : 502,
    allLimited ? 'all AI providers are at their limit right now' : 'no AI provider could answer',
    soonest?.waitMs);
  err.busy = !!allLimited;
  throw err;
}
