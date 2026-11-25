#!/bin/bash
# tools/prefill-nightly.sh — one morning of pre-filling, then publish it.
#
# Starts a local Worker that uses ONLY the dev Groq key in backend/.dev.vars
# (--local --var PROVIDER_ORDER:groq: no Cloudflare login needed, and never
# Workers AI / Gemini on Yug's account, which live users share), runs tools/prefill.mjs inside its window (05:00–06:00 IST,
# tools/prefill.config.json), publishes ONLY the new hint files (and
# tools/needs-review.txt) to main with tools/publish-cache.mjs — Cloudflare Pages (project leethint)
# redeploys https://leethint.pages.dev on the push — and then checks that the
# new files are live (prefill.mjs --verify).
#
#   bash tools/prefill-nightly.sh                 # by hand (only inside the window)
#   bash tools/prefill-nightly.sh --until 09:00   # a longer one-off run; extra flags go to prefill.mjs
#
# Scheduled by ~/Library/LaunchAgents/com.leethint.prefill.plist (tools/README.md).
# Logs: logs/prefill-YYYY-MM-DD.log (prefill.mjs) and logs/launchd.log (this
# script). Never prints an API key.

set -u
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
export PATH="$HOME/.local/node/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:$PATH"
cd "$ROOT" || exit 1
mkdir -p logs
echo "=== $(date '+%Y-%m-%d %H:%M %Z') prefill-nightly $* ==="

if [ ! -s backend/.dev.vars ]; then
  echo "backend/.dev.vars is missing — put a dev GROQ_API_KEY in it"; exit 1
fi

# Another pre-fill (a long manual run) already going → leave it alone
if pgrep -f "node tools/prefill.mjs" > /dev/null; then
  echo "A pre-fill is already running — not starting a second one."; exit 0
fi

# Files the weekly sync Action published count as done (never touches the branch)
node tools/publish-cache.mjs --pull-only || echo "Could not fetch origin/main — continuing with the local files"

# Local Worker on :8787, unless one is already running
STARTED=""
if ! curl -s -m 3 -o /dev/null http://localhost:8787/health; then
  (cd backend && npx wrangler dev --local --port 8787 --var PROVIDER_ORDER:groq > "$ROOT/logs/wrangler-dev.log" 2>&1) &
  STARTED=$!
  for _ in $(seq 1 60); do curl -s -m 3 -o /dev/null http://localhost:8787/health && break; sleep 2; done
fi
stop_worker() {
  [ -n "$STARTED" ] && { pkill -P "$STARTED" 2>/dev/null; kill "$STARTED" 2>/dev/null; pkill -f "wrangler dev.*--port 8787" 2>/dev/null; }
}
trap stop_worker EXIT

# The client's own "LeetHint: ..." lines are noise here; the full log is in logs/
node tools/prefill.mjs "$@" 2>&1 | grep -v '^LeetHint:'
stop_worker; STARTED=""

# Publish: a commit of ONLY the new hint files on top of origin/main, made in a
# temporary worktree (tools/publish-cache.mjs) — local code changes are never pushed
if node tools/publish-cache.mjs; then
  # Pages takes ~1 min; wait up to 10 min for every new file to be live
  node tools/prefill.mjs --verify --wait 600 2>&1 | grep -v '^LeetHint:'
else
  echo "Publish failed — the files are still in cache-site/; run: node tools/publish-cache.mjs"
fi
