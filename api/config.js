// api/config.js
// Where the extension sends AI requests. These are PUBLIC URLs, not secrets —
// all API keys live on the server (see backend/README.md).
//
// After `npm run deploy` in backend/, paste your Worker URL here. While
// developing locally with `npm run dev`, use 'http://localhost:8787'.
// Each URL must also match a host_permissions entry in manifest.json.
export const BACKEND_URL = 'https://leethint-api.yugthakral07.workers.dev';

// Static hint files (the leethint-cache repo on Cloudflare Pages), read
// before the server: a problem with a file costs no AI call at all
export const CACHE_URL = 'https://leethint-cache.pages.dev';
