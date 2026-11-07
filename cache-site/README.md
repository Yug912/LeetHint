# leethint-cache

Static hint files for the [LeetHint](https://github.com/Yug912/LeetHint) Chrome
extension, served by Cloudflare Pages at `https://leethint-cache.pages.dev`.
The extension reads `cache/<slug>.json` before asking the AI server, so a
problem with a file here costs no AI call.

| Path | What |
| --- | --- |
| `cache/<slug>.json` | one problem: hints, approach, TC/SC, follow-ups, code (format below) |
| `index.json` | `{ "promptVersion": "p7", "slugs": { "two-sum": "p7", ... } }` |
| `companies.json` | company tags per slug (same format as LeetHint's `data/companies.json`) |
| `privacy.html` | the extension's privacy policy (linked from the store listing) |

Files are written by `node tools/prefill.mjs` in the LeetHint repo (see its
`tools/README.md`) and, weekly, by the **sync-cache** GitHub Action, which
exports hints the Worker generated for new problems.

## File format (shared contract item 1)

```json
{
  "slug": "two-sum", "title": "Two Sum", "difficulty": "Easy",
  "promptVersion": "p7", "generatedAt": "2026-11-20",
  "pattern": "Hash Map", "tc": "O(n)", "sc": "O(n)", "spaceBreakdown": "...",
  "approach": "one-paragraph approach",
  "hints": ["hint 1", "hint 2", "hint 3", "hint 4"],
  "followUps": [{ "q": "...", "a": "..." }, { "q": "...", "a": "..." }, { "q": "...", "a": "..." }],
  "code": { "cpp": "...", "java": "...", "python3": "...", "javascript": "..." },
  "verified": { "compiled": true }
}
```

## Cloudflare Pages setup (once)

Dashboard → Workers & Pages → Create → Pages → Connect to Git → this repo.
Free plan, **no build command**, output folder `/`. Every push redeploys.

## Weekly sync (`.github/workflows/sync-cache.yml`)

Repo → Settings → Secrets and variables → Actions → add:

- `CF_ACCOUNT_ID` — Cloudflare account ID (dashboard sidebar)
- `CF_API_TOKEN` — a token with only **Account → D1 → Read**
- `D1_DATABASE_ID` — from `npx wrangler d1 create leethint`

## Handoff (S6) — what's left

This folder is a copy of the `leethint-cache` site, kept in the LeetHint repo
so it isn't only on one laptop. The three sample files (`two-sum`, `3sum`,
`trapping-rain-water`, prompt p7, C++ compile-checked) were made with
`node tools/prefill.mjs --only <slug>`. To put it live:

1. Create an empty GitHub repo `Yug912/leethint-cache` (no README).
2. Push this folder's contents to it as `main`
   (`cd cache-site && git init -b main && git add -A && git commit -m init &&
   git remote add origin git@github.com:Yug912/leethint-cache.git && git push -u origin main`).
3. Cloudflare → Workers & Pages → Create → Pages → **Connect to Git** →
   `leethint-cache`. Free plan, no build command, output folder `/`.
   (Not direct upload: the weekly sync Action publishes by pushing.)
4. Add the three Action secrets above.
5. Check `https://leethint-cache.pages.dev/cache/two-sum.json` returns the file.
   If the name was taken, put the real host in `api/config.js` (`CACHE_URL`),
   `manifest.json` host_permissions and the plan doc's Interfaces item 1.
