#!/bin/sh
# store/build.sh — the Chrome Web Store / Edge Add-ons package.
# Copies only what the extension needs into dist/store/, removes the
# local-development host (http://localhost:8787/*) from the manifest, and zips
# it as dist/leethint-<version>.zip. Run from anywhere: sh store/build.sh
set -eu
ROOT=$(cd "$(dirname "$0")/.." && pwd)
OUT="$ROOT/dist/store"
rm -rf "$OUT"
mkdir -p "$OUT"
cd "$ROOT"
cp -R manifest.json background content sidepanel api data icons "$OUT/"
mkdir -p "$OUT/shared"
# Only the shared modules the extension imports (html-text.js is for tools/ and the Worker)
cp shared/prompts.js shared/revision.js shared/patterns.js shared/complexity.js shared/insights.js "$OUT/shared/"
rm -f "$OUT/data/build_companies.py" "$OUT/data/build_company_lists.py"
find "$OUT" -name '.DS_Store' -delete
node -e '
  const fs = require("fs"), f = process.argv[1];
  const m = JSON.parse(fs.readFileSync(f, "utf8"));
  m.host_permissions = m.host_permissions.filter(h => !h.startsWith("http://localhost"));
  fs.writeFileSync(f, JSON.stringify(m, null, 2) + "\n");
  console.log("version", m.version, "· hosts:", m.host_permissions.join(" "));
' "$OUT/manifest.json"
VERSION=$(node -p 'require(process.argv[1]).version' "$OUT/manifest.json")
ZIP="$ROOT/dist/leethint-$VERSION.zip"
rm -f "$ZIP"
(cd "$OUT" && zip -qr "$ZIP" .)
echo "Built $ZIP ($(du -h "$ZIP" | cut -f1))"
