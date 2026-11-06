// api/config.js
// Where the extension sends AI requests. This is a PUBLIC URL, not a secret —
// all API keys live on the server (see backend/README.md).
//
// After `npm run deploy` in backend/, paste your Worker URL here. While
// developing locally with `npm run dev`, use 'http://localhost:8787'.
// The URL must also match a host_permissions entry in manifest.json.
export const BACKEND_URL = 'https://leethint-api.yugthakral07.workers.dev';

// Pre-generated, verified hint files (one JSON per problem) — read before the
// Worker is asked, so cached problems cost no AI call. Also a PUBLIC URL;
// it must match a host_permissions entry in manifest.json too.
export const CACHE_URL = 'https://leethint-cache.pages.dev';
