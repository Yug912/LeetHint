#!/bin/bash
# tools/prefill-nightly.sh — one night of pre-filling, then publish it.
#
# Starts a local Worker (dev key in backend/.dev.vars), runs tools/prefill.mjs
# until the free AI limits stop it (3 rate-limited problems in a row), then
# commits ONLY cache-site/ and tools/needs-review.txt and pushes to main.
# Cloudflare Pages redeploys https://leethint.pages.dev on the push.
#
#   bash tools/prefill-nightly.sh            # by hand
#   bash tools/prefill-nightly.sh --limit 50 # extra flags go to prefill.mjs
#
# Nightly on a Mac: tools/com.leethint.prefill.plist (see tools/README.md).
# The log goes to tools/prefill.log (gitignored). Never prints an API key.

set -u
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
export PATH="$HOME/.local/node/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:$PATH"
cd "$ROOT" || exit 1
echo "=== $(date '+%Y-%m-%d %H:%M') prefill-nightly ==="

if [ ! -s backend/.dev.vars ]; then
  echo "backend/.dev.vars is missing — put a dev GROQ_API_KEY in it"; exit 1
fi

# Start from the latest main (the weekly sync Action also writes cache-site/)
git pull --rebase --autostash -q origin main || echo "git pull failed — continuing with the local copy"

# Local Worker on :8787, unless one is already running
STARTED=""
if ! curl -s -m 3 -o /dev/null http://localhost:8787/health; then
  (cd backend && npx wrangler dev --port 8787 > "$ROOT/tools/wrangler-dev.log" 2>&1) &
  STARTED=$!
  for _ in $(seq 1 60); do curl -s -m 3 -o /dev/null http://localhost:8787/health && break; sleep 2; done
fi
stop_worker() {
  [ -n "$STARTED" ] && { pkill -P "$STARTED" 2>/dev/null; kill "$STARTED" 2>/dev/null; pkill -f "wrangler dev --port 8787" 2>/dev/null; }
}
trap stop_worker EXIT

# Generation log lines from the client are noise here; keep the ✓ / ✗ lines
node tools/prefill.mjs "$@" 2>&1 | grep -v '^LeetHint:'
stop_worker; STARTED=""

# Publish: commit only the pre-fill output, whatever else is in the folder
PATHS=(cache-site); [ -e tools/needs-review.txt ] && PATHS+=(tools/needs-review.txt)
NEW=$(git status --porcelain -- "${PATHS[@]}" | wc -l | tr -d ' ')
if [ "$NEW" = "0" ]; then echo "Nothing new to publish."; exit 0; fi
git add -- "${PATHS[@]}"
COUNT=$(git diff --cached --name-only -- cache-site/cache | wc -l | tr -d ' ')
git commit -q -m "Pre-fill: $COUNT hint file(s) ($(date +%Y-%m-%d))" -- "${PATHS[@]}" \
  && git pull --rebase --autostash -q origin main \
  && git push -q origin main \
  && echo "Pushed $COUNT file(s) to main." \
  || echo "Commit/push failed — the files are still in cache-site/, run the script again or push by hand."
