# cache-site

Static hint files for the [LeetHint](https://github.com/Yug912/LeetHint) Chrome
extension, served by Cloudflare Pages at `https://leethint.pages.dev`.
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

Dashboard → Workers & Pages → Create → Pages → Connect to Git → the
**LeetHint** repo. Project name `leethint`, framework preset None,
**no build command**, build output directory `cache-site`. Free plan, no
card. Every push to `main` redeploys. (Not direct upload: the weekly sync
publishes by pushing.)

## Weekly sync (`.github/workflows/sync-cache.yml` in the repo root)

LeetHint repo → Settings → Secrets and variables → Actions → add:

- `CF_ACCOUNT_ID` — Cloudflare account ID (dashboard sidebar)
- `CF_API_TOKEN` — a token with only **Account → D1 → Read**
- `D1_DATABASE_ID` — `f811f082-7749-4111-b771-31bcb4eb800b` (the `database_id` in `backend/wrangler.toml`)

Then check `https://leethint.pages.dev/cache/two-sum.json` returns the
file. If the name was taken, put the real host in `api/config.js`
(`CACHE_URL`), `manifest.json` host_permissions and the plan doc's
Interfaces item 1.
