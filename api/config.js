// api/config.js
// Where the extension sends AI requests. These are PUBLIC URLs, not secrets —
// all of LeetHint's API keys live on the server (see backend/README.md).
//
// After `npm run deploy` in backend/, paste your Worker URL here. While
// developing locally with `npm run dev`, use 'http://localhost:8787'.
// Each URL must also match a host_permissions entry in manifest.json.
export const BACKEND_URL = 'https://leethint-api.yugthakral07.workers.dev';

// Static, pre-generated hint files (the leethint-cache repo on Cloudflare
// Pages). Read before the server, so most problems cost no AI call at all.
export const CACHE_URL = 'https://leethint-cache.pages.dev';
