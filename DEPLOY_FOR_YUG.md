# Deploy for Yug: Worker 2026-11-19

This deploy is needed before the morning pre-fill starts. `tools/prefill.mjs` won't start until the live Worker is on this version.

## What changes

- **Hints and solutions in D1 are kept forever.** They used to expire after 30 days. Translations and fixes still expire after 30 days. The cache key already contains the prompt version and the statement's hash, so a changed prompt or problem still gets a new key.
- **Descriptions are normalised before the prompt is hashed** (`shared/problem-data.js`, applied in `shared/prompts.js`). Line endings, odd or repeated spaces and runs of blank lines no longer cause cache misses. A cached reply whose statement had such differences will miss once and be regenerated.
- **`GET /health` returns `version` and `promptVersion`.** Example: `{ ok, version: "2026-11-19", promptVersion: "p9", providers }`.
- **`backend/src/refresh.js`** (the Monday cron) uses the same shared problem mapping as the extension.

Not changing: no new secrets, no new bindings, no `wrangler.toml` change. The pre-fill runs on a teammate's Mac against a local `wrangler dev --local` with their own dev Groq key. It never calls the live Worker and uses no quota on this account.

## Commands

```sh
git pull origin main
cd backend
npm install
node --test ../tests/*.test.mjs        # must say: fail 0
npx wrangler deploy
```

Check it:

```sh
curl -s https://leethint-api.yugthakral07.workers.dev/health -H "Origin: chrome-extension://check"
# → {"ok":true,"version":"2026-11-19","promptVersion":"p9","providers":[...]}
```

When `version` says `2026-11-19`, tell the teammate. The next 05:00 IST run will start on its own.

The extension also changed: content scripts now load `shared/problem-data.js` first. This ships with the next store build (`sh store/build.sh` includes it). Reload the unpacked extension to test it.
