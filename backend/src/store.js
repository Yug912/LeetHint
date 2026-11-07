// backend/src/store.js — the shared reply cache.
// D1 (binding DB) is the main store; the old KV namespace (HINTS_CACHE) is
// still READ as a fallback for a month after the switch, then removed.
// Every function works with either binding missing (then nothing is shared).

const CACHE_TTL_MS = 30 * 24 * 3600 * 1000;   // replies older than 30 days are regenerated
const KV_TTL_SECONDS = 30 * 24 * 3600;
// D1 rows hold up to 2 MB; a reply is ~5-50 KB. Anything bigger isn't cached
// (R2 would need a payment method on the account — never add one)
const MAX_BODY_BYTES = 1_900_000;

export const hasCache = env => !!(env.DB || env.HINTS_CACHE);

// → { raw, kind, layer } or null
export async function readCache(env, key, now = Date.now()) {
  if (env.DB) {
    try {
      const row = await env.DB.prepare('SELECT kind, body, created FROM cache WHERE key = ?').bind(key).first();
      if (row && now - row.created < CACHE_TTL_MS) return { raw: row.body, kind: row.kind, layer: 'd1' };
    } catch (e) {
      console.warn('D1 cache read failed:', e.message);
    }
  }
  if (env.HINTS_CACHE) {
    const { value, metadata } = await env.HINTS_CACHE.getWithMetadata(key);
    if (value) return { raw: value, kind: metadata?.kind || 'openai', layer: 'kv' };
  }
  return null;
}

export async function writeCache(env, key, raw, kind, now = Date.now()) {
  if (env.DB) {
    if (new TextEncoder().encode(raw).length > MAX_BODY_BYTES) return console.warn('reply too large to cache:', key.slice(0, 80));
    await env.DB.prepare('INSERT OR REPLACE INTO cache (key, kind, body, created) VALUES (?, ?, ?, ?)')
      .bind(key, kind, raw, now).run();
    return;
  }
  if (env.HINTS_CACHE) await env.HINTS_CACHE.put(key, raw, { expirationTtl: KV_TTL_SECONDS, metadata: { kind } });
}
