#!/usr/bin/env node
// tools/publish-cache.mjs — publish pre-filled hint files without touching
// the local branch or any uncommitted work.
//
//   node tools/publish-cache.mjs              # bring origin's files in, then publish ours
//   node tools/publish-cache.mjs --pull-only  # only bring origin's files in (start of a run)
//   node tools/publish-cache.mjs --dry-run    # say what would happen
//
// 1. Pull in: every cache-site/cache/<slug>.json on origin/main that is
//    missing here, or older than the current prompt version here, is written
//    into the working tree, so the pre-fill counts it as done (the weekly
//    sync Action publishes some).
// 2. Publish: in a temporary worktree at origin/main, copy every local file
//    at the current prompt version that origin lacks or has at an older
//    version, merge index.json and tools/needs-review.txt, commit ONLY those
//    paths and push to main. Cloudflare Pages redeploys on the push.
// The local branch, its commits and uncommitted changes are never used, so a
// dirty or out-of-date checkout can't cause conflicts or push code by mistake.

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync, readdirSync, mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { PROMPT_VERSION } from '../shared/prompts.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CACHE = 'cache-site/cache';
const args = new Set(process.argv.slice(2));
const dry = args.has('--dry-run');
const git = (cwd, ...a) => execFileSync('git', a, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const versionOf = text => { try { return JSON.parse(text).promptVersion || ''; } catch { return ''; } };

git(ROOT, 'fetch', '-q', 'origin', 'main');

// ── 1. pull in ──
const remoteFiles = git(ROOT, 'ls-tree', '--name-only', 'origin/main', `${CACHE}/`).split('\n').filter(f => f.endsWith('.json'));
let pulled = 0;
for (const f of remoteFiles) {
  const local = join(ROOT, f);
  const mine = existsSync(local) ? versionOf(readFileSync(local, 'utf8')) : null;
  if (mine === PROMPT_VERSION) continue;
  const theirs = git(ROOT, 'show', `origin/main:${f}`);
  if (mine !== null && versionOf(theirs) !== PROMPT_VERSION) continue;   // neither is current: keep ours
  if (!dry) writeFileSync(local, theirs);
  pulled++;
}
console.log(`Pulled in ${pulled} file(s) from origin/main${dry ? ' (dry run)' : ''}.`);
if (args.has('--pull-only')) process.exit(0);

// ── 2. publish ──
const remote = new Map(remoteFiles.map(f => [f, null]));
const toPublish = readdirSync(join(ROOT, CACHE)).filter(n => n.endsWith('.json')).map(n => `${CACHE}/${n}`).filter(f => {
  const text = readFileSync(join(ROOT, f), 'utf8');
  if (versionOf(text) !== PROMPT_VERSION) return false;
  if (!remote.has(f)) return true;
  const theirs = git(ROOT, 'show', `origin/main:${f}`);
  return versionOf(theirs) !== PROMPT_VERSION;   // origin has it at the current version → it's live already
});
if (!toPublish.length) { console.log('Nothing new to publish.'); process.exit(0); }
console.log(`${toPublish.length} file(s) to publish${dry ? ' (dry run): ' + toPublish.slice(0, 10).join(', ') + (toPublish.length > 10 ? ' …' : '') : ''}`);
if (dry) process.exit(0);

for (let attempt = 1; ; attempt++) {
  const dir = mkdtempSync(join(tmpdir(), 'leethint-publish-'));
  try {
    git(ROOT, 'fetch', '-q', 'origin', 'main');
    git(ROOT, 'worktree', 'add', '-q', '--detach', dir, 'origin/main');
    for (const f of toPublish) { mkdirSync(dirname(join(dir, f)), { recursive: true }); writeFileSync(join(dir, f), readFileSync(join(ROOT, f))); }
    // index.json: origin's entries + ours
    const idxPath = join(dir, 'cache-site/index.json');
    const index = existsSync(idxPath) ? JSON.parse(readFileSync(idxPath, 'utf8')) : { slugs: {} };
    index.promptVersion = PROMPT_VERSION;
    index.slugs ||= {};
    for (const f of toPublish) index.slugs[f.slice(CACHE.length + 1, -5)] = PROMPT_VERSION;
    writeFileSync(idxPath, JSON.stringify(index, null, 2) + '\n');
    const paths = [...toPublish, 'cache-site/index.json'];
    // needs-review.txt: add our lines that origin doesn't have
    const review = join(ROOT, 'tools/needs-review.txt');
    if (existsSync(review)) {
      const target = join(dir, 'tools/needs-review.txt');
      const have = new Set(existsSync(target) ? readFileSync(target, 'utf8').split('\n') : []);
      const add = readFileSync(review, 'utf8').split('\n').filter(l => l && !have.has(l));
      if (add.length) { writeFileSync(target, [...have].filter(Boolean).concat(add).join('\n') + '\n'); paths.push('tools/needs-review.txt'); }
    }
    git(dir, 'add', '--', ...paths);
    git(dir, 'commit', '-q', '-m', `Pre-fill: ${toPublish.length} hint file(s) (${new Date().toISOString().slice(0, 10)})`);
    git(dir, 'push', '-q', 'origin', 'HEAD:refs/heads/main');
    console.log(`Pushed ${toPublish.length} file(s) to main — Pages is redeploying.`);
    break;
  } catch (e) {
    const msg = String(e.stderr || e.message).trim().split('\n').slice(-2).join(' ');
    if (attempt >= 3) { console.error(`Publish failed: ${msg}`); process.exitCode = 1; break; }
    console.log(`Publish attempt ${attempt} failed (${msg}) — retrying on the latest main`);
  } finally {
    try { git(ROOT, 'worktree', 'remove', '--force', dir); } catch { rmSync(dir, { recursive: true, force: true }); }
  }
}
