# tools/

Scripts that run on a developer's computer, never in the extension or the Worker.

## prefill.mjs — static hint files

Solves every free LeetCode algorithm problem (~3,160) once and writes
`cache/<slug>.json` (plus `index.json`) into `cache-site/`. Cloudflare Pages
(project `leethint`, Yug's account, connected to this GitHub repo) serves it at
`https://leethint.pages.dev`. The extension reads these files **by slug**
before asking the Worker, so a pre-filled problem costs no AI call.

It runs against a **local** Worker with a separate dev key. It never calls the
live Worker and never touches its quota, D1 or KV:

```sh
# once: your own free Groq key (console.groq.com, your own account/org, not Yug's)
echo "GROQ_API_KEY=gsk_..." > backend/.dev.vars

cd backend && npx wrangler dev --local --var PROVIDER_ORDER:groq   # terminal 1 (Groq only; no Cloudflare login)
node tools/prefill.mjs --dry-run                                  # terminal 2: what it would send
node tools/prefill.mjs --until 07:00                              # a run now, until 07:00 IST
```

Settings are in `tools/prefill.config.json`: run window, pace, token budgets,
languages and the hackathon date. State lives in `data/prefill-state.json`
(gitignored): done, failed with attempt counts, skipped, tokens per UTC day
and the last 60 runs. It is written after every problem, so a crash or a
sleeping laptop loses nothing. The log is `logs/prefill-YYYY-MM-DD.log`.

| Flag | Meaning |
| --- | --- |
| `--dry-run` | fetch problems and build the request bodies (`logs/dry-run-payloads.json`); no Worker calls |
| `--limit <n>` | at most n problems (default `maxProblemsPerRun`, 100) |
| `--only <slug>` | just this problem, any time (repeatable, regenerates) |
| `--mode backlog\|new\|backfill` | default: backlog; once it is empty, new problems + language backfill |
| `--until <HH:MM>` | end time for this run; also allows a run outside 05:00–06:00 |
| `--verify [--wait <s>]` | check that the files written are live on the cache site |
| `--force`, `--pace <s>`, `--worker <url>`, `--out <dir>`, `--no-compile`, `--ignore-live` | see `--help` |

**Order.** Blind 75, then NeetCode 150, then company problems (most reported
first, `data/company-problems.json`), then the rest by likes. The lists are in
`data/priority-lists.json`. Premium and database/shell problems are skipped.

**Languages, in phases.** The first `priority.count` (300) get C++ only, so
they finish first. Everything after that gets C++ plus `languages` (Java,
Python, JavaScript). Once the backlog is empty, the daily run adds the missing
languages to the first 300 (backfill) and to new problems.

**Per problem:**
1. Fetch the statement from LeetCode GraphQL with the extension's own query and mapping (`shared/problem-data.js`).
2. Generate hints and C++ with the extension's client (`api/ai.js`).
3. Compile-check the C++ with `clang++` and run it on LeetCode's examples. A failure gets one fix; if it still fails, the problem goes to `tools/needs-review.txt`.
4. Check the hints, TC/SC and the signature, then write the file.

**Stopping.** A run stops at the end of the window (after finishing the
current problem), after `maxProblemsPerRun` problems, after 5 busy/429/5xx
errors in a row, or when the token budget is used. A problem that fails 5
times is listed in the summary and not tried again.

**Token budgets.** These are per UTC day: `beforeReset` covers 05:00–05:30
IST (the old day's leftover) and `afterReset` covers after 05:30 IST (keep
about 20% of the dev key's daily quota). Measured on 2026-11-19: 4.0–5.4k real
tokens per hints reply on Groq `gpt-oss-120b`. The config estimates 6k.

**Safety check.** It refuses to start unless the local Worker runs this
repo's version (`backend/src/version.js`) and the live Worker
(`GET /health` → `version`) does too. Set `"requireLiveVersion": false` to
skip the live check.

### Every morning (Mac, launchd)

`tools/prefill-nightly.sh` does one morning:
1. Pull `main` and start the local Worker (`--local`, Groq only).
2. Run the pre-fill inside its window.
3. Commit **only** `cache-site/` and `tools/needs-review.txt`, and push to `main`. Pages redeploys on the push, about 1 minute.
4. Run `--verify` until every new file is live.

Needs on the Mac:
- `backend/.dev.vars` with the dev key.
- `git push` access to `Yug912/LeetHint`. Git uses HTTPS with the macOS keychain (`gh auth login`).
- No Cloudflare credentials.

```sh
# install (starts every day at 05:00 IST, wrapped in caffeinate -i)
sed "s|__ROOT__|$PWD|g" tools/com.leethint.prefill.plist > ~/Library/LaunchAgents/com.leethint.prefill.plist
launchctl load ~/Library/LaunchAgents/com.leethint.prefill.plist
# wake the Mac at 04:55 every day (it must be plugged in)
sudo pmset repeat wakeorpoweron MTWRFSU 04:55:00

launchctl list | grep leethint                 # status: PID (running) or "-", last exit code
launchctl start com.leethint.prefill           # run now (prefill.mjs exits if outside its window)
bash tools/prefill-nightly.sh --until 09:00    # a longer one-off run, by hand
tail -50 logs/launchd.log logs/prefill-$(date +%F).log   # did this morning's run happen?
launchctl unload ~/Library/LaunchAgents/com.leethint.prefill.plist   # pause
rm ~/Library/LaunchAgents/com.leethint.prefill.plist && sudo pmset repeat cancel   # uninstall (after unload)
```

**Weekly.** The Worker's Monday cron generates LeetCode's newest problems
into D1, and the `sync-cache` Action exports them into `cache-site/`
(`tools/export-d1.mjs`, only replies whose C++ passes LeetCode's examples).
The morning run counts those files as already cached.

## interview-tokens.mjs — what a mock interview costs

`node --no-warnings tools/interview-tokens.mjs [--slug trapping-rain-water]`
builds the exact prompts of one scripted interview (no AI calls) and totals
their tokens with the Worker's estimator: the old way (full transcript and
code every turn, 30 minutes, code events) vs the cheaper trial way (15
minutes, a summary every 6 interviewer turns + the last 4 turns, code only
when it changed). Result on 2026-11-07: **~36k tokens vs ~90k for today's
30-minute interview (41%)**; on the identical 15-minute script it is 75%, since
each turn's ~1.6k tokens of instructions stay. Request bodies after turn 10:
~3.3 KB. Run it again after changing the interview prompts.

## accuracy/

10 standard problems (`standard.mjs`, `ONLY=<slug,...>` for a few) and 5 very
hard ones (`hard/run.mjs`), against `BACKEND` (default the local Worker). Run them after any change to `shared/prompts.js` or model routing.
