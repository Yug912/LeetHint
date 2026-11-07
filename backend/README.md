# LeetHint API (Cloudflare Worker)

The extension sends problem data here; the Worker builds the prompt, calls an AI
provider with **server-side keys**, and streams the reply back. Users never
need — or see — an API key.

```
Extension ──POST /v1/generate {action, problem}──▶ Worker ──▶ Groq / Workers AI / Gemini / OpenRouter / Cerebras
          ◀──────── streamed text ─────────────── (keys = Worker secrets)
```

| Endpoint | What it does |
|---|---|
| `POST /v1/generate` | Hints, solution, fix, translation, interview turn / score / summary — streamed |
| `POST /v1/report` | "This hint is wrong" → stored for review (one per problem, install and day) |
| `GET /config` | Remote switch: feature flags and free-trial sizes from `[vars]`, cached 1 hour |
| `GET /health` | Providers configured (`?models` adds model names) |
| `GET /stats?token=…` | Private: today's counters and trial use (404 without `STATS_TOKEN`) |

Requests carry `X-LeetHint-Install`, a random ID made once per install (no account,
no personal data), used only for per-install rate limits and free-trial counts.

## Security model

| Concern | How it's handled |
|---|---|
| API keys | Stored only as encrypted Worker secrets. Never in the repo, the extension, or any response. `.dev.vars` is gitignored. |
| Misuse as a free AI proxy | The client can't send a prompt — only problem fields. Prompts are built server-side from [`shared/prompts.js`](../shared/prompts.js), so the endpoint only ever produces LeetHint output. |
| Abuse / cost | Per-install limit (20 req/min) + per-IP backstop (120 req/min), input size limits, action whitelist, D1 blocklist, free trials for personal AI (Fix 3/day, 1 interview/week). |
| Who can call it | `ALLOWED_ORIGINS` pins the API to your extension ID once published. |
| Error leaks | Upstream errors are logged server-side; clients only get generic messages. |
| Cache poisoning | Cache key = hash of the full prompt, so a fake statement can't overwrite a real problem's cached hints. |

## Deploy (one time, ~5 minutes)

Requires [Node.js](https://nodejs.org) 18+ and a free [Cloudflare account](https://dash.cloudflare.com/sign-up).

```bash
cd backend
npm install
npx wrangler login

# Add at least one key — each extra one adds free quota.
npx wrangler secret put GROQ_API_KEY         # free: https://console.groq.com/keys
npx wrangler secret put CEREBRAS_API_KEY     # https://cloud.cerebras.ai
npx wrangler secret put OPENROUTER_API_KEY   # https://openrouter.ai/keys
npx wrangler secret put GEMINI_API_KEY       # free: https://aistudio.google.com/apikey

# Recommended: shared cache — popular problems load instantly for everyone
npx wrangler kv namespace create HINTS_CACHE
#   → paste the printed id into wrangler.toml and uncomment the [[kv_namespaces]] block

npm run deploy
```

`deploy` prints your URL, e.g. `https://leethint-api.<you>.workers.dev`. Then:

1. Put it in [`api/config.js`](../api/config.js) → `BACKEND_URL`.
2. Reload the extension at `chrome://extensions`.
3. Check: the **Stats → Settings** card should say **✅ Connected**.

After publishing the extension, set `ALLOWED_ORIGINS = "chrome-extension://<id>"` in
`wrangler.toml`, narrow `https://*.workers.dev/*` in `manifest.json` to your exact
Worker URL, and redeploy.

## Local development

```bash
cd backend
cp .dev.vars.example .dev.vars   # fill in at least one key — never commit this file
npm run dev                      # http://localhost:8787
```

Set `BACKEND_URL` in `api/config.js` to `http://localhost:8787` while testing.

Quick check:

```bash
curl http://localhost:8787/health -H "Origin: chrome-extension://test"
# → {"ok":true,"providers":["Groq", ...]}
```

## Configuration

| Setting | Where | Default |
|---|---|---|
| `PROVIDER_ORDER` | `wrangler.toml` `[vars]` | `cerebras,groq,workersai,openrouter,gemini` (fastest first) |
| `WORKERSAI_MODELS` | `wrangler.toml` `[vars]` | unset = `gpt-oss-120b`, then `gpt-oss-20b` |
| `ALLOWED_ORIGINS` | `wrangler.toml` `[vars]` | empty = any `chrome-extension://` origin |
| Rate limits | `wrangler.toml` `[[ratelimits]]` | 20 / 60 s per install, 120 / 60 s per IP |
| Remote switch | `CONFIG_INTERVIEW`, `CONFIG_FIX`, `TRIAL_*`, `CONFIG_MESSAGE` in `[vars]` | everything on, 1 interview/week (15 min), 3 fixes/day |
| Shared quota | `DAILY_TOKENS`, `TRIAL_DAILY_TOKENS`, `MAX_TRIAL_INTERVIEWS` in `[vars]` | 1.5M tokens, 25% for trials, 3 interviews at once |
| New problems cron | `[triggers] crons` | Mondays 06:00–09:40 UTC, 2 problems per run |
| Models per provider | `src/providers.js` | see `PROVIDERS` |

Free-tier limits change often — check each provider's dashboard.

### How it stays fast on free tiers

- **Model discovery** — each provider's `/models` list decides which models are tried, so retired models are skipped. See them with `GET /health?models`.
- **Per-model token budgets** — Groq's free tier allows ~8,000 tokens/minute *per model* and counts the requested maximum up front. The Worker tracks each model's remaining budget from the response headers and sends every request to a model with room (e.g. `gpt-oss-120b` → `gpt-oss-20b` → `qwen`), instead of failing.
- **Right-sized requests** — each action asks only for the tokens it needs; translations go to a smaller model first.
- **Short limits are waited out** (up to 8 s) rather than returned as errors.
- **Daily limits pause a model.** Groq's free tier also caps each model at ~200,000 tokens/day (≈ 50 questions on `gpt-oss-120b`). When a model reports its daily limit, it's skipped until the reset time Groq gives, instead of being retried on every request. Budgets are tracked only from refusals — on success Groq's "remaining" header still counts the request's full `max_tokens` reservation.
- Every refused attempt is logged (`refused: <model> <status> <reason>`) — watch with `npx wrangler tail`.
- **The reply stream is passed through untouched.** The Worker never parses the provider's Server-Sent Events — the extension does. Parsing every chunk in the Worker exceeded the free plan's 10 ms CPU limit, and Cloudflare cut replies off mid-way (missing code, missing languages). Caching uses a native stream copy (`tee()` + `Response.text()`), which costs almost no CPU.

- **Cloudflare Workers AI as free overflow** — the `[ai]` binding in `wrangler.toml` gives the Worker the account's free daily Workers AI allowance with **no API key**. On the free plan only `gpt-oss-120b` / `gpt-oss-20b` are available (others answer `5035: not available on the Workers Free plan`), and they're slower (~10–20 s), so they are used only when Groq is busy. When the daily allowance runs out, Workers AI is paused until midnight UTC. `WORKERSAI_MODELS` in `[vars]` overrides its model order.

Each extra provider key (`GEMINI_API_KEY`, `CEREBRAS_API_KEY`, ...) adds its own budgets — the easiest way to stay fast with many users.

## Scaling features (switch on one at a time)

All are free-plan features and are **off until their block in `wrangler.toml` is
uncommented**; without them the Worker behaves exactly as before.

1. **D1 database** — the shared cache (≈100,000 writes/day instead of KV's ≈1,000),
   free-trial counters, reports, the blocklist and `/stats` counters:
   ```bash
   npx wrangler d1 create leethint                      # paste database_id into wrangler.toml
   npx wrangler d1 migrations apply leethint --remote   # creates the tables
   ```
   Uncomment `[[d1_databases]]` and deploy. KV is still read as a fallback, so
   existing cached replies keep working while D1 fills up.
2. **ProblemGate** (`src/gate.js`) — when many users open the same brand-new
   problem at once, one AI call serves them all. Uncomment its Durable Object blocks.
3. **QuotaKeeper** (`src/quota.js`) — one shared quota counter for every Worker copy,
   with a daily share kept for free trials. Uncomment its blocks.
4. **Stats page** — `npx wrangler secret put STATS_TOKEN` (any long random string), then
   open `https://<worker>/stats?token=<it>`.
5. **Block an install** — `npx wrangler d1 execute leethint --remote --command
   "INSERT INTO blocked (install_id, reason, created) VALUES ('<id>', 'abuse', unixepoch())"`.

Static hint files come from `tools/prefill.mjs` (see `tools/README.md`) and are served
from the `leethint-cache` Pages site, so most users never reach this Worker for hints.
