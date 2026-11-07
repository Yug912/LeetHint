#!/usr/bin/env node
// tools/export-d1.mjs — turn hints the Worker cached in D1 (the Monday cron,
// and live cache misses) into static files for the leethint-cache site.
// Run weekly by .github/workflows/sync-cache.yml in the leethint-cache repo.
//
//   CF_ACCOUNT_ID=... CF_API_TOKEN=... D1_DATABASE_ID=... \
//     node tools/export-d1.mjs --out ../leethint-cache [--days 8]
//
// The API token needs only "D1: Read" on the account. Problems that already
// have a file with the current prompt version are left alone (the pre-fill's
// files are richer: they carry translations and a compile check). Exported
// files carry C++ only; the extension translates other languages on demand.

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { PROMPT_VERSION } from '../shared/prompts.js';
import { readAnswerStream, parseHintsReply, missingSignatureParts } from '../api/ai.js';
import { problemData } from './prefill.mjs';

function args(argv) {
  const a = { out: resolve('../leethint-cache'), days: 8 };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--out') a.out = resolve(argv[++i]);
    else if (argv[i] === '--days') a.days = Number(argv[++i]);
  }
  return a;
}

async function d1(sql, params) {
  const { CF_ACCOUNT_ID, CF_API_TOKEN, D1_DATABASE_ID } = process.env;
  if (!CF_ACCOUNT_ID || !CF_API_TOKEN || !D1_DATABASE_ID) throw new Error('Set CF_ACCOUNT_ID, CF_API_TOKEN and D1_DATABASE_ID');
  const res = await fetch(`https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT_ID}/d1/database/${D1_DATABASE_ID}/query`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${CF_API_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ sql, params })
  });
  const body = await res.json();
  if (!body.success) throw new Error(`D1 query failed: ${JSON.stringify(body.errors)}`);
  return body.result[0].results;
}

// Plain C++ hints replies only ("p7:hints:<slug>:<hash>", no language suffix)
export function slugOfKey(key) {
  const m = key.match(/^(p\d+):hints:([a-z0-9-]+):[0-9a-f]{64}$/);
  return m && m[1] === PROMPT_VERSION ? m[2] : '';
}

export function toStaticFile(problem, parsed, generatedAt) {
  const s = parsed.solution || {};
  return {
    slug: problem.slug, title: problem.title, difficulty: problem.difficulty,
    promptVersion: PROMPT_VERSION, generatedAt,
    pattern: parsed.pattern || '', tc: s.tc || parsed.optimal_tc, sc: s.sc || parsed.optimal_sc,
    spaceBreakdown: parsed.sc_breakdown || '', approach: s.approach || '',
    hints: [parsed.hint1, parsed.hint2, parsed.hint3, parsed.hint4].map(h => (h || '').trim()),
    followUps: parsed.followUps || [],
    code: { cpp: s.code },
    verified: { compiled: false }
  };
}

async function main() {
  const a = args(process.argv.slice(2));
  const since = Date.now() - a.days * 864e5;
  const rows = await d1('SELECT key, kind, body, created FROM cache WHERE key LIKE ? AND created > ? ORDER BY created',
                        [`${PROMPT_VERSION}:hints:%`, since]);
  mkdirSync(join(a.out, 'cache'), { recursive: true });
  const indexFile = join(a.out, 'index.json');
  const index = existsSync(indexFile) ? JSON.parse(readFileSync(indexFile, 'utf8')) : { promptVersion: PROMPT_VERSION, slugs: {} };
  index.promptVersion = PROMPT_VERSION;
  let written = 0;
  for (const row of rows) {
    const slug = slugOfKey(row.key);
    if (!slug || index.slugs[slug] === PROMPT_VERSION) continue;
    try {
      const text = await readAnswerStream(new Response(row.body), row.kind);
      const parsed = parseHintsReply(text);
      const problem = await problemData(slug);
      if (!problem || !parsed.solution?.code) continue;
      if (problem.cppSnippet && missingSignatureParts(parsed.solution.code, problem.cppSnippet).length) continue;
      const file = toStaticFile(problem, parsed, new Date(row.created).toISOString().slice(0, 10));
      if (file.hints.some(h => !h) || !file.tc || !file.sc) continue;
      writeFileSync(join(a.out, 'cache', `${slug}.json`), JSON.stringify(file, null, 2) + '\n');
      index.slugs[slug] = PROMPT_VERSION;
      written++;
      console.log(`✓ ${slug}`);
    } catch (e) {
      console.log(`✗ ${slug}: ${e.message}`);
    }
  }
  writeFileSync(indexFile, JSON.stringify(index, null, 2) + '\n');
  console.log(`${written} new file(s) from ${rows.length} cached repl${rows.length === 1 ? 'y' : 'ies'}`);
}

if (process.argv[1]?.endsWith('export-d1.mjs')) main().catch(e => { console.error(e.message); process.exit(1); });
