#!/usr/bin/env bash
# Builds the Chrome Web Store / Edge Add-ons zip: a copy of the extension
# without development-only parts (localhost permission, server, tools, tests).
#   bash store/build.sh   →   store/leethint-<version>.zip
set -euo pipefail
cd "$(dirname "$0")/.."

version=$(node -p "require('./manifest.json').version")
out="store/leethint-$version.zip"
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

# Only what the extension loads
cp -R manifest.json api background content data icons shared sidepanel "$tmp/"
rm -f "$tmp/data/build_companies.py"

# Store build: no localhost permission; the extension must point at the live server
node -e "
  const fs = require('fs'); const f = '$tmp/manifest.json';
  const m = JSON.parse(fs.readFileSync(f, 'utf8'));
  m.host_permissions = m.host_permissions.filter(h => !h.startsWith('http://localhost'));
  fs.writeFileSync(f, JSON.stringify(m, null, 2) + '\n');
"
if grep -v '^[[:space:]]*//' "$tmp/api/config.js" | grep -q "localhost"; then
  echo "api/config.js still points at localhost — set BACKEND_URL to the live Worker first" >&2
  exit 1
fi

# Tests must pass before anything ships
node --test tests/*.test.mjs > /dev/null

rm -f "$out"
(cd "$tmp" && zip -qr - .) > "$out"
echo "Built $out ($(du -h "$out" | cut -f1))"
