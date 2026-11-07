// A Cloudflare D1 binding backed by Node's built-in SQLite, with the real
// migrations applied — so tests run the Worker's actual SQL.
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';

process.removeAllListeners('warning');   // node:sqlite is "experimental" — keep test output clean

export function fakeD1() {
  const db = new DatabaseSync(':memory:');
  const dir = new URL('../../backend/migrations/', import.meta.url);
  for (const f of readdirSync(dir).filter(f => f.endsWith('.sql')).sort()) db.exec(readFileSync(new URL(f, dir), 'utf8'));
  const statement = (sql, args = []) => ({
    bind: (...a) => statement(sql, a),
    first: async col => { const row = db.prepare(sql).get(...args); return row ? (col ? row[col] : { ...row }) : null; },
    all: async () => ({ results: db.prepare(sql).all(...args).map(r => ({ ...r })) }),
    run: async () => { const r = db.prepare(sql).run(...args); return { meta: { changes: Number(r.changes) } }; }
  });
  return { prepare: sql => statement(sql), batch: async list => Promise.all(list.map(s => s.run())), db };
}
