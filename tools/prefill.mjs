#!/usr/bin/env node
// tools/prefill.mjs — generate static hint files for every free LeetCode problem.
//
// Each problem is solved ONCE here (on your computer, against a local Worker
// with a dev key), compile-checked, and written as cache/<slug>.json into the
// cache site (the cache-site/ folder of this repo). The extension reads those files first, so hints for a
// pre-filled problem cost no AI call at all.
//
//   cd backend && npx wrangler dev           # terminal 1 (dev key in .dev.vars)
//   node tools/prefill.mjs --limit 20        # terminal 2
//
// Flags:
//   --only <slug>    just this problem (repeatable)       --force      regenerate even if current
//   --limit <n>      at most n problems this run          --out <dir>  default cache-site/
//   --worker <url>   default http://localhost:8787        --pace <s>   seconds between problems (default 20-30)
//   --no-compile     skip the clang++ check (not recommended)
// Resumable: problems whose file already has the current promptVersion are skipped.

import { readFileSync, writeFileSync, mkdirSync, existsSync, appendFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';
import { htmlToText } from '../shared/html-text.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const LANGS = ['java', 'python3', 'javascript'];   // translated besides C++
// Same keys as SNIPPET_LANGS in content/content.js
const SNIPPET_LANGS = ['cpp', 'java', 'python3', 'c', 'javascript', 'typescript', 'csharp', 'golang', 'kotlin', 'swift', 'rust'];

// ── arguments ──
function parseArgs(argv) {
  const a = { only: [], force: false, limit: Infinity, out: resolve(ROOT, 'cache-site'),
              worker: 'http://localhost:8787', pace: null, compile: true };
  for (let i = 0; i < argv.length; i++) {
    const f = argv[i], next = () => argv[++i];
    if (f === '--only') a.only.push(next());
    else if (f === '--force') a.force = true;
    else if (f === '--limit') a.limit = Number(next());
    else if (f === '--out') a.out = resolve(next());
    else if (f === '--worker') a.worker = next().replace(/\/$/, '');
    else if (f === '--pace') a.pace = Number(next());
    else if (f === '--no-compile') a.compile = false;
    else if (f === '--help' || f === '-h') { console.log(readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').slice(1, 19).join('\n')); process.exit(0); }
    else throw new Error(`Unknown flag ${f}`);
  }
  return a;
}

// ── LeetCode GraphQL ──
export async function leetcode(query, variables) {
  for (let attempt = 1; ; attempt++) {
    const res = await fetch('https://leetcode.com/graphql', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Referer: 'https://leetcode.com/problemset/', 'User-Agent': 'LeetHint-prefill' },
      body: JSON.stringify({ query, variables })
    });
    if (res.ok) return (await res.json()).data;
    if (attempt >= 3) throw new Error(`LeetCode GraphQL HTTP ${res.status}`);
    await sleep(5000 * attempt);
  }
}

async function listProblems() {
  const query = `query list($limit: Int, $skip: Int, $filters: QuestionListFilterInput) {
    questionList(categorySlug: "", limit: $limit, skip: $skip, filters: $filters) {
      totalNum data { questionFrontendId titleSlug isPaidOnly }
    }
  }`;
  const all = [];
  for (let skip = 0; ; skip += 100) {
    const page = (await leetcode(query, { limit: 100, skip, filters: {} })).questionList;
    all.push(...page.data);
    if (!page.data.length || all.length >= page.totalNum) break;
  }
  return all.filter(q => !q.isPaidOnly);
}

// The same query and field mapping as getEnrichedProblemData() in content/content.js
export async function problemData(slug) {
  const query = `query questionData($titleSlug: String!) {
    question(titleSlug: $titleSlug) {
      questionFrontendId title difficulty content hints
      topicTags { name }
      codeSnippets { langSlug code }
    }
  }`;
  const q = (await leetcode(query, { titleSlug: slug })).question;
  if (!q?.content) return null;   // premium or gone
  const codeSnippets = {};
  for (const s of q.codeSnippets || []) if (SNIPPET_LANGS.includes(s.langSlug)) codeSnippets[s.langSlug] = s.code;
  return {
    slug, title: q.title, difficulty: q.difficulty, problemNumber: q.questionFrontendId,
    description: htmlToText(q.content),
    topicTags: (q.topicTags || []).map(t => t.name),
    officialHints: (q.hints || []).map(htmlToText),
    cppSnippet: codeSnippets.cpp || '',
    codeSnippets
  };
}

// ── the extension's own client, pointed at the local Worker ──
async function loadClient(workerUrl) {
  const { BACKEND_URL } = await import('../api/config.js');
  const { CACHE_URL } = await import('../api/config.js').catch(() => ({}));
  const realFetch = globalThis.fetch;
  globalThis.fetch = (url, init = {}) => {
    const u = String(url);
    // Never read our own static files back — this script is what writes them
    if (CACHE_URL && u.startsWith(CACHE_URL)) return Promise.resolve(new Response('', { status: 404 }));
    if (u.startsWith(BACKEND_URL)) {
      return realFetch(workerUrl + u.slice(BACKEND_URL.length),
        { ...init, headers: { ...init.headers, Origin: 'chrome-extension://prefill' } });
    }
    return realFetch(url, init);
  };
  return import('../api/ai.js');
}

// ── compile check (free: your own clang) ──
export function compileError(code) {
  const dir = join(tmpdir(), 'leethint-prefill');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, 'solution.cpp');
  writeFileSync(file, `#include "leetcode-prelude.h"\n${code}\n`);
  const cxx = process.env.CXX || 'clang++';
  try {
    execFileSync(cxx, ['-std=c++17', '-fsyntax-only', '-I', join(ROOT, 'tools/cpp'), file], { stdio: 'pipe' });
    return '';
  } catch (e) {
    if (e.code === 'ENOENT') throw new Error(`${cxx} not found — install a compiler (xcode-select --install) or pass --no-compile`);
    return String(e.stderr || e.message).replaceAll(file, 'solution.cpp').split('\n').filter(l => /error/.test(l)).slice(0, 8).join('\n');
  }
}

// ── one problem ──
async function generate(client, problem, { compile, promptVersion }) {
  const result = await client.generateHints(problem, { language: 'cpp' });
  let sol = result.solution;
  if (!sol?.code) throw new Error('no code in the reply');
  let compiled = null;
  if (compile) {
    let err = compileError(sol.code);
    if (err) {
      console.log(`  compile error → asking for a fix:\n    ${err.split('\n')[0]}`);
      const fixed = await client.validateSolutionCode(sol.code, problem, `Compile error:\n${err}`);
      err = compileError(fixed.code);
      if (err) throw Object.assign(new Error(`still does not compile: ${err.split('\n')[0]}`), { review: true });
      sol = { ...sol, code: fixed.code, tc: fixed.tc || sol.tc, sc: fixed.sc || sol.sc };
      result.sc_breakdown = fixed.scBreakdown || result.sc_breakdown;
    }
    compiled = true;
  }
  const hints = [result.hint1, result.hint2, result.hint3, result.hint4].map(h => (h || '').trim());
  const problems = [];
  if (hints.some(h => !h)) problems.push('fewer than 4 hints');
  if (!sol.tc || !sol.sc) problems.push('missing TC/SC');
  const missing = problem.cppSnippet ? client.missingSignatureParts(sol.code, problem.cppSnippet) : [];
  if (missing.length) problems.push(`signature: missing ${missing.join(', ')}`);
  if (problems.length) throw Object.assign(new Error(problems.join('; ')), { review: true });

  const code = { cpp: sol.code };
  for (const lang of LANGS) {
    if (!problem.codeSnippets[lang]) continue;
    try { code[lang] = await client.translateSolution(sol.code, problem, lang); }
    catch (e) { console.log(`  ${lang} translation failed (${e.message}) — the extension translates it on demand`); }
  }
  return {
    slug: problem.slug, title: problem.title, difficulty: problem.difficulty,
    promptVersion, generatedAt: new Date().toISOString().slice(0, 10),
    pattern: result.pattern || '', tc: sol.tc, sc: sol.sc, spaceBreakdown: result.sc_breakdown || '',
    approach: sol.approach || '',
    hints,
    followUps: result.followUps || [],
    code,
    verified: { compiled: compiled === true }
  };
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const client = await loadClient(args.worker);
  const { PROMPT_VERSION } = await import('../shared/prompts.js');
  args.promptVersion = PROMPT_VERSION;
  const cacheDir = join(args.out, 'cache');
  mkdirSync(cacheDir, { recursive: true });
  const indexFile = join(args.out, 'index.json');
  const index = existsSync(indexFile) ? JSON.parse(readFileSync(indexFile, 'utf8')) : { promptVersion: PROMPT_VERSION, slugs: {} };
  index.promptVersion = PROMPT_VERSION;
  const reviewFile = join(ROOT, 'tools', 'needs-review.txt');

  // Check the Worker is up before spending time on the problem list
  try {
    const h = await (await fetch(`${args.worker}/health`, { headers: { Origin: 'chrome-extension://prefill' } })).json();
    console.log(`Worker at ${args.worker}: providers ${h.providers?.join(', ') || 'none'}`);
    if (!h.providers?.length) throw new Error('no AI provider configured — put a dev key in backend/.dev.vars');
  } catch (e) {
    throw new Error(`Local Worker not reachable at ${args.worker} (${e.message}). Start it: cd backend && npx wrangler dev`);
  }

  let slugs = args.only;
  if (!slugs.length) {
    const companies = JSON.parse(readFileSync(join(ROOT, 'data/companies.json'), 'utf8'));
    const list = (await listProblems()).sort((a, b) => Number(a.questionFrontendId) - Number(b.questionFrontendId));
    const free = new Set(list.map(q => q.titleSlug));
    // Popular first: problems with company tags, then everything else by number
    slugs = [...Object.keys(companies).filter(s => free.has(s)), ...list.map(q => q.titleSlug).filter(s => !companies[s])];
    console.log(`${list.length} free problems, ${Object.keys(companies).filter(s => free.has(s)).length} with company tags first`);
  }

  let done = 0, limited = 0;
  for (const slug of slugs) {
    if (done >= args.limit) break;
    const file = join(cacheDir, `${slug}.json`);
    if (!args.force && existsSync(file)) {
      try { if (JSON.parse(readFileSync(file, 'utf8')).promptVersion === PROMPT_VERSION) continue; } catch {}
    }
    const started = Date.now();
    try {
      const problem = await problemData(slug);
      if (!problem) { console.log(`- ${slug}: premium or unavailable, skipped`); continue; }
      console.log(`→ ${problem.problemNumber}. ${problem.title} (${problem.difficulty})`);
      const out = await generate(client, problem, args);
      writeFileSync(file, JSON.stringify(out, null, 2) + '\n');
      index.slugs[slug] = out.promptVersion;
      writeFileSync(indexFile, JSON.stringify(index, null, 2) + '\n');
      console.log(`  ✓ ${slug}.json  ${out.pattern} · TC ${out.tc} · SC ${out.sc} · ${Object.keys(out.code).join(', ')} (${Math.round((Date.now() - started) / 1000)} s)`);
      done++;
      limited = 0;
    } catch (e) {
      if (e.status === 429) {
        console.log(`  ✗ ${slug}: AI providers at their limit (${e.message})`);
        if (++limited >= 3) { console.log('Stopping: 3 rate-limited problems in a row — all AI providers are at their limit. Run again later.'); break; }
        await sleep(60000);
        continue;
      }
      console.log(`  ✗ ${slug}: ${e.message}${e.review ? ' → tools/needs-review.txt' : ''}`);
      if (e.review) appendFileSync(reviewFile, `${slug}\t${new Date().toISOString().slice(0, 10)}\t${e.message.replace(/\s+/g, ' ')}\n`);
    }
    // Pace: one problem every 20-30 s keeps inside free per-minute limits
    const pace = args.pace != null ? args.pace * 1000 : 20000 + Math.random() * 10000;
    await sleep(Math.max(0, pace - (Date.now() - started)));
  }
  console.log(`Done: ${done} new file${done === 1 ? '' : 's'} in ${cacheDir}`);
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  main().catch(e => { console.error(e.message); process.exit(1); });
}
