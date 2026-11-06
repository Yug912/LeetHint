#!/usr/bin/env bash
# store/build.sh — makes the Chrome Web Store / Edge Add-ons zip.
#
#   bash store/build.sh            → store/dist/leethint-<version>.zip
#
# It zips a COPY of only the files the extension runs (no backend/, tests/,
# tools/, screenshots/ or build scripts), with the development-only
# http://localhost:8787/* host permission removed from manifest.json.
# Your working folder is never changed. Needs Node 18+ (already required).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="$ROOT/store/dist"
STAGE="$OUT/stage"

# What the extension needs at runtime — anything else stays out of the zip
INCLUDE=(manifest.json api background content data/companies.json icons shared sidepanel)

rm -rf "$STAGE"
mkdir -p "$STAGE/data"
for item in "${INCLUDE[@]}"; do
  cp -R "$ROOT/$item" "$STAGE/$item"
done

# Store manifest: drop localhost, keep everything else exactly as it is
node -e '
  const fs = require("fs");
  const file = process.argv[1];
  const m = JSON.parse(fs.readFileSync(file, "utf8"));
  m.host_permissions = (m.host_permissions || []).filter(h => !/^https?:\/\/(localhost|127\.0\.0\.1)/.test(h));
  fs.writeFileSync(file, JSON.stringify(m, null, 2) + "\n");
  console.log("host_permissions:", m.host_permissions.join(", "));
' "$STAGE/manifest.json"

# Never ship a key: fail if anything that looks like one slipped in
if grep -rEn '(gsk_[A-Za-z0-9]{20,}|AIza[0-9A-Za-z_-]{30,}|sk-or-[A-Za-z0-9-]{20,}|csk-[A-Za-z0-9]{20,})' "$STAGE"; then
  echo "✗ Something that looks like an API key is in the build — remove it first." >&2
  exit 1
fi

VERSION="$(node -p 'require(process.argv[1]).version' "$STAGE/manifest.json")"
ZIP="$OUT/leethint-$VERSION.zip"
rm -f "$ZIP"

# zip is not installed everywhere (e.g. Git Bash on Windows) — Node's own
# zlib can't write zips, so use Python's zipfile or PowerShell as fallbacks
( cd "$STAGE" && {
  if command -v zip >/dev/null 2>&1; then
    zip -qr "$ZIP" .
  elif command -v python3 >/dev/null 2>&1 && python3 -c 'import zipfile' 2>/dev/null; then
    python3 -m zipfile -c "$ZIP" ./*
  elif command -v python >/dev/null 2>&1; then
    python -m zipfile -c "$ZIP" ./*
  else
    powershell.exe -NoProfile -Command "Compress-Archive -Path * -DestinationPath '$(cygpath -w "$ZIP" 2>/dev/null || echo "$ZIP")'"
  fi
} )

rm -rf "$STAGE"
echo "✓ $ZIP"
