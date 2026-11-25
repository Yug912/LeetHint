// backend/src/version.js — the Worker code version, reported by GET /health so
// a script (tools/prefill.mjs) or a person can see which code is live.
// Bump on every deploy that changes behaviour. (Not in index.js: the Workers
// runtime refuses non-handler exports such as a string from the entry module.)
// 2026-11-19: hints/solve cached forever, descriptions normalised before hashing.
export const WORKER_VERSION = '2026-11-19';
