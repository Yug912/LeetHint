// A real SQLite database (node:sqlite) running the real migration, wrapped in
// Cloudflare D1's prepare().bind().first()/run()/all() API — for tests
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

export function fakeD1() {
  const db = new DatabaseSync(':memory:');
  for (const m of ['0001_init.sql', '0002_stats.sql']) {
    db.exec(readFileSync(new URL(`../../backend/migrations/${m}`, import.meta.url), 'utf8'));
  }
  return {
    db,
    prepare: sql => ({
      bind: (...args) => ({
        first: async () => db.prepare(sql).get(...args) ?? null,
        run: async () => { db.prepare(sql).run(...args); return { success: true }; },
        all: async () => ({ results: db.prepare(sql).all(...args) })
      })
    })
  };
}
