# LeetHint — Yug's remaining tasks (after S1–S33)

As of 2026-11-08. Live copy (may be newer): https://claude.ai/artifact/3KwpkfYKssALJ8GoAvSqSi
Anushka's side: [HANDOFF-ANUSHKA.md](HANDOFF-ANUSHKA.md). The full build plan (S1–S33, Interfaces): https://claude.ai/artifact/EfUNCTZhmRG4gUdsyn88UH

## Context

All code for S1–S33 is on `main` of `Yug912/LeetHint` and tested (`node --test tests/*.test.mjs`: 123 pass, 0 fail, 1 skipped live test). It is deployed: the live Worker runs `main` as of commit `2fb752e` (deployed 2026-11-08 01:14 UTC). Tasks 0–4 are done; what is left waits on a date or on the store listings (table below).

### Status on 2026-11-08

| Task | State |
| --- | --- |
| 0 — secrets, dev setup | Done. `STATS_TOKEN` kept at Anushka's original value (live, and saved in `~/.leethint-stats-token`). Live `GROQ_API_KEY` replaced with a new key on 2026-11-08; delete the old one in the Groq console if not done yet. Yug's `backend/.dev.vars` holds Yug's own dev Groq key (not the live one) and `ALLOWED_ORIGINS=` empty. |
| 1 — deploy | Done 2026-11-08 01:14 UTC. Durable Objects `QuotaKeeper` and `ProblemGate` created (migration `v1`), Monday cron set. `KV_FALLBACK_UNTIL` kept at `2026-12-15`. |
| 2 — live checks | Passed, test rows cleaned. Notes: check 5's tail had no `gate hints` line, but D1 held exactly one row; the per-install limit started at request 22, not 21 (Cloudflare counts approximately). Optional trial check skipped. |
| 2 — S30 cron | **Open:** check after Monday 2026-11-09 06:00 UTC for `refresh: N generated, M already cached, K skipped`. |
| 3 — sync secrets | Done. Repo secrets set, workflow permissions Read and write, `main` unprotected. Run #1 green with no commit: the test slugs aren't real LeetCode problems, so the export skips them. The two `deploy-check-*` rows were deleted from D1. |
| 4 — contest query | Done. Confirmed during Weekly Contest 527 (2026-11-08 02:35 UTC, 4 problems); comment updated in `backend/src/refresh.js` (`de98945`). |
| 5 — ALLOWED_ORIGINS | **Open:** waits for the store listings to show the Chrome and Edge extension IDs. |
| 6 — follow-ups | **Open:** remove KV after 2026-12-15; watch `/stats` after launch. OpenRouter `:free` ids in `providers.js` / `direct.js` checked 2026-11-08: all 3 still exist. 0 reports so far. |
| Hint test + accuracy fixes | 35-problem live test on 2026-11-08: 34/35 right on LeetCode's examples; the wrong one came from a small fallback model and had been cached. Fixed: hints/solve/fix use large models only (`backend/src/providers.js`), small-model replies are never cached (`cacheableFrom()` in `backend/src/store.js`), prompt p8 forbids describing the method in Hint 1, and static files must pass LeetCode's examples (`tools/examples.mjs`, used by the pre-fill and the weekly sync). Trade-off: when every large model is at its free limit, users wait in line instead of getting a weaker answer. |

**How to use this doc with an AI assistant:** give it this file plus the repo. Every task lists the exact commands, the expected result and what to do if it differs. The project rules at the end of this section apply to every change.

### What is already done (no work needed)

| Area | State |
| --- | --- |
| Cache site | Live at https://leethint.pages.dev (Pages project `leethint`, builds the `cache-site/` folder of this repo on every push to `main`). 24 pre-filled problems so far; Anushka's Mac adds more nightly. |
| Privacy policy | Live at https://leethint.pages.dev/privacy (linked in `store/listing.md`). |
| D1 database | `leethint`, id `f811f082-7749-4111-b771-31bcb4eb800b`. All tables exist remotely: `cache`, `reports`, `usage`, `trial_interviews`, `blocked`. |
| Analytics Engine | Enabled, dataset `leethint_events`. |
| Worker secrets (live) | `GROQ_API_KEY` (new key, 2026-11-08), `GEMINI_API_KEY`, `STATS_TOKEN` (Anushka's original value, kept). Never paste them in chat or commit them. |
| Durable Objects | Created by the 2026-11-08 deploy: `QuotaKeeper` and `ProblemGate` (migration tag `v1`). || Store package | `sh store/build.sh` → `dist/leethint-1.2.0.zip` (148 KB, no localhost host). Submission is Anushka's. |
| Accuracy (prompt p8, 2026-11-08) | 10/10 standard, 4/5 very hard (twice). No re-run needed unless prompts or model routing change. |

### Account facts

- Cloudflare account id `5ccfb4fce004de671a6b03f84dc40c66` (pinned in `backend/wrangler.toml`). You own it; Anushka is an invited member.
- Worker: `leethint-api` → https://leethint-api.yugthakral07.workers.dev
- Repo: `git@github.com:Yug912/LeetHint.git`, branch `main` only (no feature branches).

### Rules for every change

1. Free tiers only: never add a payment method, paid plan or paid model. Never print, log or commit an API key or `STATS_TOKEN`.
2. Server first and backward compatible: the extension hides a feature when its endpoint is missing, never shows an error.
3. Follow the plan doc's Interfaces section exactly (field names, status codes, headers).
4. Worker CPU stays tiny (10 ms): AI streams pass through untouched, no per-chunk parsing.
5. The content script is read-only on LeetCode.
6. A user's own API key stays in `chrome.storage.local` and goes only to that provider, never to the Worker.
7. Wrap every `chrome.storage` and `fetch` call so a failure falls back to today's behaviour.
8. `node --test tests/*.test.mjs` must pass before every `npx wrangler deploy` (run from `backend/`).
9. Re-measure accuracy after any change to `shared/prompts.js`, model routing or what is sent to the server.
10. Commit and push straight to `main`.

## Task 0 — Work without waiting for Anushka

Everything in this doc can be done alone. Where an older note says "ask Anushka", do this instead:

| Item | Do it yourself |
| --- | --- |
| `STATS_TOKEN` | Set your own value; it replaces the one Anushka set and only you need it: `cd backend && openssl rand -hex 24 \| tee ~/.leethint-stats-token \| npx wrangler secret put STATS_TOKEN` (saved in your home folder, not the repo). Read it back later with `cat ~/.leethint-stats-token`. |
| Live `GROQ_API_KEY` | The dev key in Anushka's `.dev.vars` was pasted in a chat. If the live secret might be the same key, replace it now: make a new key at https://console.groq.com/keys, run `npx wrangler secret put GROQ_API_KEY`, paste it. Never echo it. |
| Local dev for you | Create your own `backend/.dev.vars` (gitignored) with your own free dev Groq key and the dev `ALLOWED_ORIGINS` from Task 5. Never reuse a live key for dev. |
| Store extension IDs (S33) | They are public: the Chrome ID is the last part of the extension's Chrome Web Store URL (`chromewebstore.google.com/detail/leethint/<id>`), the Edge ID the last part of its Edge Add-ons URL. Once the listings are live, do Task 5 without asking. |
| Pre-fill / regenerating a reported problem | Run it on your machine: `cd backend && npx wrangler dev` in one terminal, `node tools/prefill.mjs --only <slug> --force` in another, then commit and push `cache-site/`. Anushka's Mac also runs it nightly (`tools/prefill-nightly.sh`); both push to `main`, so `git pull` first. |
| Own-key real checks (Gemini, OpenRouter) | Anyone can do them with free keys: see S17 in [HANDOFF-ANUSHKA.md](HANDOFF-ANUSHKA.md). |

Only two things need Anushka: her store developer accounts (S32 submission) and her Chrome profile tests.

## Task 1 — Deploy the Worker

One deploy puts every server step (S1–S30) live at once. It is free: everything it uses is on the Workers Free plan. If any dashboard screen asks for a card, stop: never add one.

1. Get the latest code and dependencies:
   ```sh
   cd LeetHint && git pull origin main
   cd backend && npm install
   ```
2. Run the tests from the repo root. All must pass (expect 123 pass, 0 fail, 1 skipped):
   ```sh
   cd .. && node --test tests/*.test.mjs
   ```
3. Check the KV fallback date. In `backend/wrangler.toml`, `KV_FALLBACK_UNTIL = "2026-12-15"` assumes a deploy around mid-November 2026. If you deploy later, set it to about one month after your deploy date, then commit and push.
4. Make sure the remote D1 schema is current (it should print "No migrations to apply"):
   ```sh
   cd backend && npx wrangler d1 migrations apply leethint --remote
   ```
5. Deploy:
   ```sh
   npx wrangler deploy
   ```

What the first deploy creates or changes:

- Durable Objects `QuotaKeeper` (binding `QUOTA`) and `ProblemGate` (binding `GATE`) through migration `v1` (`new_sqlite_classes`, free plan).
- The Monday cron `0 6 * * 1` (new problems).
- Bindings: D1 `DB`, KV `HINTS_CACHE` (read-only fallback), Analytics Engine `EVENTS`, rate limiters, Workers AI `AI`.
- `[vars]` from `wrangler.toml`: `PROVIDER_ORDER`, `QUOTA_DAILY_TOKENS`, `KV_FALLBACK_UNTIL`, the `CONFIG_*` switches for `/config`, and `ALLOWED_ORIGINS = ""` (any extension origin allowed until S33).

If the deploy fails:

| Error | Fix |
| --- | --- |
| "You need to enable Analytics Engine" (code 10089) | Already enabled 2026-11-07; if it reappears, enable it under Workers → Analytics Engine (free). |
| More than one account / wrong account | `account_id` is pinned in `wrangler.toml`; run `npx wrangler login` with the account owner's login. |
| Durable Object migration error | Give your AI assistant the exact message plus `backend/wrangler.toml`. Do not rename the `v1` tag or delete classes. |

## Task 2 — Check the live server after the deploy

Run these right after Task 1. Set shell variables first (any UUID works as a test install ID; read `STATS_TOKEN` from `~/.leethint-stats-token` after Task 0, don't type it into a shared terminal log):

```sh
API=https://leethint-api.yugthakral07.workers.dev
ID=11111111-2222-4333-8444-555555555555
H=(-H 'Origin: chrome-extension://test' -H 'Content-Type: application/json')   # an array: works in bash and zsh
```

In a second terminal, watch the live logs the whole time: `cd backend && npx wrangler tail`.

| Step | Command | Expected |
| --- | --- | --- |
| Health | `curl -s "${H[@]}" $API/health` | `{"ok":true,"providers":["Groq","Gemini","Workers AI"...]}` |
| S4 `/config` | `curl -s -D - "${H[@]}" $API/config` | JSON with `interview`, `fix`, trial minutes; header `Cache-Control: public, max-age=3600` |
| S9 D1 cache miss → hit | the `/v1/generate` call below, twice | 1st response header `X-LeetHint-Cache: MISS`, 2nd `HIT` with `X-LeetHint-Cache-Layer` = `memory` or `d1` |
| S10 report + duplicate | the `/v1/report` call below, twice | both `204`; then the D1 query below shows ONE row |
| S14 merged requests | 10 parallel `/v1/generate` for a slug never requested | `wrangler tail` shows ONE `gate hints <slug> → <model>` line; 9 replies carry `[joined]` in `X-LeetHint-Model` |
| S2 rate limit | 25 `/v1/report` calls from one install (below) | `1:204` … `20:204`, then `21:429` onward (limit 20/min per install) |
| S29 `/stats` | `curl -s -o /dev/null -w '%{http_code}' $API/stats` then with `?token=$(cat ~/.leethint-stats-token)` | `404` without the token; JSON with `day`, `tokensUsedByShare`, `trialShareLeftPercent`, `cachedReplies` with it |
| S29 blocked | insert the test ID into `blocked`, call `/v1/generate`, delete it again (below) | `403 {"error":"blocked"}` while listed |
| S30 cron | after the first Monday 06:00 UTC, check `wrangler tail` or the dashboard logs | `refresh: N generated, M already cached, K skipped` |

The calls used above:

```sh
# S9 / S14 — hints for one problem (change the slug for S14)
curl -s -D - -o /dev/null -X POST $API/v1/generate "${H[@]}" -H "X-LeetHint-Install: $ID" \
  -d '{"action":"hints","problem":{"slug":"deploy-check-1","title":"Deploy Check","difficulty":"Easy","description":"Return the sum of two integers a and b."}}' | grep -i x-leethint

# S14 — ten at once for a brand-new slug
for i in $(seq 1 10); do curl -s -o /dev/null -D - -X POST $API/v1/generate "${H[@]}" -H "X-LeetHint-Install: $ID" \
  -d '{"action":"hints","problem":{"slug":"deploy-check-gate","title":"Gate Check","difficulty":"Easy","description":"Return a times b."}}' | grep -i x-leethint-model & done; wait

# S10 — run the report twice, then look in D1 (expect ONE row)
curl -s -o /dev/null -w '%{http_code}\n' -X POST $API/v1/report "${H[@]}" -H "X-LeetHint-Install: $ID" -d '{"slug":"two-sum","promptVersion":"p8","reason":"wrong_hint"}'
npx wrangler d1 execute leethint --remote --command "SELECT install_id, slug, day, reason FROM reports WHERE install_id='$ID'"

# S2 — rate limit: 25 requests from one install
for i in $(seq 1 25); do curl -s -o /dev/null -w "$i:%{http_code} " -X POST $API/v1/report "${H[@]}" \
  -H "X-LeetHint-Install: 22222222-2222-4333-8444-555555555555" -d '{"slug":"two-sum","promptVersion":"p8","reason":"other"}'; done; echo

# S29 — blocked install: insert, call /v1/generate (expect 403 blocked), delete
npx wrangler d1 execute leethint --remote --command "INSERT INTO blocked (install_id, reason, created) VALUES ('$ID','deploy test',0)"
npx wrangler d1 execute leethint --remote --command "DELETE FROM blocked WHERE install_id='$ID'"
```

Clean up afterwards so the test rows don't count in real numbers:

```sh
npx wrangler d1 execute leethint --remote --command "DELETE FROM reports WHERE install_id IN ('$ID','22222222-2222-4333-8444-555555555555'); DELETE FROM usage WHERE install_id='$ID'"
```

Older-server check: before your deploy, the extension on `main` must behave as today against the old live server (missing `/config`, `/v1/report` or `interview_summary` only hides that feature, never shows an error). Anushka runs it in Chrome before you deploy; nothing for you to do unless she reports a problem.

Not checked by hand on the server (covered by unit tests, and tested in the extension): S13 busy waiting line (needs every provider at its limit), S16 trials, S19 extension messages. Optional live trial check: send 4 `"action":"fix"` requests with the same install ID and a `code` field; the 4th returns HTTP `403` with `{"error":"trial_used","action":"fix","resetsAt":"<next UTC midnight>"}`.

## Task 3 — GitHub Action secrets for the weekly sync

The workflow `.github/workflows/sync-cache.yml` (repo root) runs every Monday 09:00 UTC, three hours after the Worker's cron. It exports hints the Worker generated into D1 (cron + live cache misses, last 8 days) as `cache-site/cache/<slug>.json` with `tools/export-d1.mjs`, copies `data/companies.json` to `cache-site/`, then commits and pushes to `main`. Pages redeploys on that push. It needs three repo secrets.

1. Create a Cloudflare API token that can only read D1:
   1. Cloudflare dashboard → My Profile → API Tokens → Create Token → Create Custom Token.
   2. Permissions: **Account → D1 → Read**. Nothing else.
   3. Account Resources: Include → the LeetHint account (`5ccfb4fce004de671a6b03f84dc40c66`).
   4. Create it and copy the token once. Don't save it anywhere else.
2. Add the secrets: GitHub → `Yug912/LeetHint` → Settings → Secrets and variables → Actions → New repository secret.

   | Secret | Value |
   | --- | --- |
   | `CF_ACCOUNT_ID` | `5ccfb4fce004de671a6b03f84dc40c66` |
   | `CF_API_TOKEN` | the D1-read token from step 1 |
   | `D1_DATABASE_ID` | `f811f082-7749-4111-b771-31bcb4eb800b` |
3. Let the workflow push: Settings → Actions → General → Workflow permissions → **Read and write permissions** → Save. (A branch protection rule on `main` that blocks bots would stop the push.)
4. Test it once by hand: Actions tab → **sync-cache** → Run workflow (branch `main`).

Expected: the run is green. If the Worker has generated anything since the deploy (Task 2's test slugs count), a commit "Weekly sync: new problems and company tags" appears on `main` and `https://leethint.pages.dev/cache/<slug>.json` serves the file a minute later. With nothing new it ends with no commit, which is also correct.

Only SELECT queries run, so the read-only token is enough ([D1 query API](https://developers.cloudflare.com/api/resources/d1/subresources/database/methods/query/)). If the run fails with Cloudflare error `10000`, the token is missing the D1 Read scope or the account resource ([Debug D1](https://developers.cloudflare.com/d1/observability/debug-d1/)).

After test slugs like `deploy-check-1` are exported, delete their files from `cache-site/cache/` and their lines from `cache-site/index.json`, then push.

## Task 4 — Confirm the contest query during a live contest

One question from S30 is still open: does `contestQuestionList` return the problems while a contest is running? It takes 2 minutes during any LeetCode contest (weekly: Sunday 02:30–04:00 UTC; biweekly: every other Saturday 14:30–16:00 UTC). `topTwoContests` lists the next two with start times.

What is known (checked 2026-11-07): `topTwoContests` returns the next contests with `startTime` and `duration`; `contestQuestionList` returns the problems of a finished contest. `backend/src/refresh.js` already skips the whole Monday run if a live contest's list errors or comes back empty, and the Monday 06:00 UTC cron never overlaps a weekend contest, so this is a confirmation, not a fix.

During a contest, run (put that contest's slug, e.g. `weekly-contest-527`):

```sh
curl -s https://leetcode.com/graphql -H 'Content-Type: application/json' -H 'Referer: https://leetcode.com/contest/' \
  -d '{"query":"query q($s: String!) { contestQuestionList(contestSlug: $s) { titleSlug title } }","variables":{"s":"weekly-contest-527"}}'
```

| Result during the contest | Meaning | Action |
| --- | --- | --- |
| A list of 4 problems | The query works live | Update the comment above `liveContestSlugs()` in `backend/src/refresh.js` to say "confirmed during a live contest". |
| `[]`, `null` or an error | Problems are hidden while live | Nothing to change: the code already treats this as unknown and skips the run. Note it in the same comment. |

Commit the comment change to `main` (it goes out with the next deploy).

## Task 5 — S33: lock the server to the published extension

Do this only after the store listings are live (see Task 0 for reading the IDs). Until then `ALLOWED_ORIGINS = ""` accepts any `chrome-extension://` origin, which is what the unpacked dev builds need.

How the Worker reads it (`corsHeaders()` in `backend/src/index.js`): a comma-separated list; when set, only those exact origins get answers, everything else is refused. Chrome Web Store and Edge Add-ons assign **different** IDs, so list both.

1. In `backend/wrangler.toml` `[vars]`:
   ```toml
   ALLOWED_ORIGINS = "chrome-extension://<chrome-store-id>,chrome-extension://<edge-store-id>"
   ```
2. Keep development working locally: in `backend/.dev.vars` (gitignored, each developer's own) add the origins used with `npx wrangler dev`. `.dev.vars` overrides `wrangler.toml` locally:
   ```sh
   ALLOWED_ORIGINS=chrome-extension://<chrome-store-id>,chrome-extension://<your-unpacked-id>,chrome-extension://prefill,chrome-extension://test
   ```
   `chrome-extension://prefill` is what `tools/prefill.mjs` and the nightly pre-fill send; keep it or the pre-fill stops working. Tell Anushka to add the same line to her `.dev.vars` (her nightly pre-fill runs against a local Worker).
3. Run the tests, commit, push, deploy (Task 1 steps 2 and 5).
4. Check:

| Request | Expected |
| --- | --- |
| The store-installed extension opens a problem | Hints load as before |
| `curl -s -o /dev/null -w '%{http_code}' -H 'Origin: chrome-extension://test' $API/health` | Refused (not 200) |
| `curl ... -H 'Origin: chrome-extension://<chrome-store-id>' $API/health` | `200` |

After this, an unpacked dev build can't use the live server; point `api/config.js` `BACKEND_URL` at `http://localhost:8787` while developing. Origins can be faked outside a browser, so the per-install and per-IP rate limits stay the real abuse protection.

## Task 6 — Follow-ups after the deploy

### Remove the old KV cache (after 2026-12-15)

From that day the Worker no longer reads KV (`kvFallbackOpen()` in `backend/src/store.js`), and KV entries expire after 30 days anyway. Then remove it fully, in one commit:

1. `backend/wrangler.toml`: delete the `[[kv_namespaces]]` block (`HINTS_CACHE`) and the `KV_FALLBACK_UNTIL` var.
2. `backend/src/store.js`: delete the `HINTS_CACHE` branches in `readCache`, `writeCache` and `saveReport`, and `kvFallbackOpen` with its use. `hasCache` becomes `!!env.DB`.
3. Tests: remove or rewrite the KV cases in `tests/d1.test.mjs`, `tests/cache.test.mjs` (it simulates KV; switch it to `fakeD1()` from `tests/helpers/fake-d1.mjs`) and `tests/trials.test.mjs` ("reports without D1 go to KV").
4. Run the tests, deploy, then (optional) delete the namespace: `npx wrangler kv namespace delete --namespace-id c944b3f551cc4cfab1d5bf292ffd9206`.

### Keep the AI providers free

- OpenRouter retires `:free` models often. Before adding an `OPENROUTER_API_KEY` secret, check that the ids in `backend/src/providers.js` (`openrouter.fallback`) and `api/direct.js` (`OWN_KEY_PROVIDERS.openrouter.model`) still exist: `curl -s https://openrouter.ai/api/v1/models` and look for ids ending in `:free`. Never add a model without `:free`.
- More free capacity, if limits bite: add a free Cerebras or OpenRouter key with `npx wrangler secret put CEREBRAS_API_KEY` (or `OPENROUTER_API_KEY`). `PROVIDER_ORDER` already lists them. Adding a provider changes routing, so re-run the accuracy check afterwards.

### Accuracy check (whenever prompts or routing change)

Against a local Worker (`cd backend && npx wrangler dev`, dev key in `backend/.dev.vars`): `node tools/accuracy/standard.mjs` (pass mark 10/10) and, after `python3 tools/accuracy/hard/gen.py` once, `node tools/accuracy/hard/run.mjs` (pass mark 4/5). Current p8 result (2026-11-08): 10/10 and 4/5.

### Ongoing

- Reported wrong hints: look at `SELECT slug, reason, COUNT(*) FROM reports GROUP BY slug, reason ORDER BY 3 DESC` weekly (`npx wrangler d1 execute leethint --remote --command "..."`), then regenerate with `node tools/prefill.mjs --only <slug> --force` and push `cache-site/`.
- Watch `/stats` for a few days after launch: `trialShareLeftPercent` near 0 early in the day means trials need a lower limit (`CONFIG_TRIAL_*` vars, no code change).
- Cloudflare Pages builds on every push to `main` (free plan: 500 builds a month). Nightly pre-fill pushes plus code pushes stay far below that.

## Reference

### Endpoints (`backend/src/index.js`)

| Endpoint | Body / query | Answer |
| --- | --- | --- |
| `POST /v1/generate` | `{ action, problem, code?, language?, interview?, reason? }` | the provider's SSE stream, passed through untouched; headers `X-LeetHint-Cache`, `X-LeetHint-Model`, `X-LeetHint-Format` |
| `GET /health` | — | `{ ok, providers }` |
| `GET /config` | — | feature switches from the `CONFIG_*` vars, cached 1 hour |
| `POST /v1/report` | `{ slug, promptVersion, reason, note? }` | `204`; one per install, problem and UTC day |
| `GET /stats` | `?token=<STATS_TOKEN>` | today's numbers; `404` without the right token |

Error replies the extension understands: `429 {"error":"busy","retryAfter","position"}` + `Retry-After` (every provider at its limit), `429 {"error":"rate_limited","retryAfter":60}`, `403 {"error":"trial_used","action","resetsAt"}`, `403 {"error":"blocked"}`. Every `/v1` request needs an allowed `Origin` and should carry `X-LeetHint-Install: <uuid>`.

### Bindings (`backend/wrangler.toml`)

| Binding | What | Free-plan note |
| --- | --- | --- |
| `DB` | D1 `leethint`: cache, reports, usage, trial_interviews, blocked | rows up to 2 MB; replies over 1.9 MB aren't cached |
| `HINTS_CACHE` | old KV cache, read-only until `KV_FALLBACK_UNTIL` | remove after 2026-12-15 (Task 6) |
| `QUOTA` | Durable Object `QuotaKeeper`: one global token budget, 70% hints / 25% trials / 5% reserve | SQLite-backed (free plan) |
| `GATE` | Durable Object `ProblemGate`: identical cache misses share one AI call | 100,000 requests and 13,000 GB-s a day; if it fails, the Worker calls the AI directly |
| `EVENTS` | Analytics Engine dataset `leethint_events`, one event per `/v1` request | free |
| `INSTALL_LIMITER`, `RATE_LIMITER` | 20 requests/min per install, 120/min per IP | free |
| `AI` | Workers AI (no key) | daily allowance, then paused until 00:00 UTC |

### Where things live

| Path | What |
| --- | --- |
| `backend/src/index.js` | routes, trials, cache flow, `/stats`, `scheduled()` |
| `backend/src/providers.js` | provider list, models per task, routing |
| `backend/src/quota.js`, `gate.js`, `store.js`, `refresh.js` | QuotaKeeper, ProblemGate, D1/KV cache + reports + trials, Monday cron |
| `backend/migrations/0001_init.sql` | D1 schema |
| `shared/prompts.js` | every prompt; `PROMPT_VERSION = 'p8'` is part of every cache key |
| `cache-site/` | the Pages site: `cache/<slug>.json`, `index.json`, `companies.json`, `privacy.html` |
| `tools/prefill.mjs`, `tools/prefill-nightly.sh` | static-file generator and its nightly wrapper (runs on Anushka's Mac) |
| `tools/export-d1.mjs`, `.github/workflows/sync-cache.yml` | weekly D1 → static files |
| `tools/accuracy/` | accuracy checks |
| `tools/interview-tokens.mjs` | interview token cost, old vs new (trial = 41% of today's interview) |
| `store/build.sh`, `store/listing.md` | store zip and listing text |

### Troubleshooting

| Symptom | Likely cause | Fix |
| --- | --- | --- |
| `{"error":"Origin not allowed"}` | request without an extension `Origin`, or one not in `ALLOWED_ORIGINS` | add `-H 'Origin: chrome-extension://test'` (before S33) or the store ID (after) |
| Every reply is `busy` | all free quotas used for the day | wait for 00:00 UTC; check `/stats`; add another free key (Task 6) |
| Hints cut off mid-way | per-chunk work in the Worker exceeded 10 ms CPU | never parse the stream in the Worker; keep passing bytes through |
| `wrangler dev` can't use Workers AI | not logged in | `npx wrangler login` |
| Sync Action error `10000` | token lacks D1 Read on the account | recreate the token (Task 3) |
