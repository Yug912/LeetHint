#!/usr/bin/env node
// tools/prefill.mjs — generate hints for every LeetCode problem ONCE and save
// them as static files (cache/<slug>.json), so most users never trigger an AI
// call. Runs on your computer (Node 18+), against your local Worker
// (`npx wrangler dev` with a DEVELOPMENT key in backend/.dev.vars) so the live
// server's daily quota stays for users.
//
//   node tools/prefill.mjs                      all free problems, popular first
//   node tools/prefill.mjs --limit 20           stop after 20 new files
//   node tools/prefill.mjs --only two-sum --force   regenerate one problem
//   node tools/prefill.mjs --server https://leethint-api.yugthakral07.workers.dev   (live server — avoid)
//   options: --out <dir> (default prefill-out) · --delay <seconds> (default 20)
//
// Each file is checked before it's saved: 4 hints, TC/SC and code present,
// LeetCode's exact signature, and the C++ COMPILES (clang++/g++ on this
// computer). Problems that still fail after one fix go to needs-review.txt.

import { readFileSync, writeFileSync, existsSync, mkdirSync, appendFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateHints, translateSolution, validateSolutionCode, missingSignatureParts } from '../api/ai.js';
import { BACKEND_URL } from '../api/config.js';
import { PROMPT_VERSION } from '../shared/prompts.js';
import { parseFollowUps } from '../shared/followups.js';
import { listProblems, fetchProblem, compileCheck } from './leetcode.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const EXTRA_LANGUAGES = ['java', 'python3', 'javascript'];   // stored in the file; others are translated on demand
const STOP_AFTER_BUSY = 3;                                     // consecutive "providers at their limit" → stop for tonight


// ─────────────────────────────────────────────
// 1. OPTIONS
// ─────────────────────────────────────────────
function parseArgs(argv) {
  const opts = { server: 'http://localhost:8787', out: 'prefill-out', delay: 20, limit: Infinity, only: '', force: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i], next = () => argv[++i];
    if (a === '--server') opts.server = next().replace(/\/+$/, '');
    else if (a === '--out') opts.out = next();
    else if (a === '--delay') opts.delay = Number(next());
    else if (a === '--limit') opts.limit = Number(next());
    else if (a === '--only') opts.only = next();
    else if (a === '--force') opts.force = true;
    else throw new Error(`Unknown option ${a} — see the top of tools/prefill.mjs`);
  }
  return opts;
}


// ─────────────────────────────────────────────
// 2. SERVER ACCESS — the extension's own client (api/ai.js) does the work;
//    fetch is wrapped to point it at --server and to keep a copy of each
//    hints reply (its ---FOLLOWUPS--- section isn't part of the parsed hints)
// ─────────────────────────────────────────────
let lastHintsReply = Promise.resolve('');   // the latest hints reply's text, once fully read

// The answer text inside a stream of Server-Sent Events (the same three
// formats api/ai.js reads: OpenAI-style, Workers AI, Gemini)
export function sseAnswerText(sse, kind) {
  let text = '';
  for (const line of String(sse).split('\n')) {
    const data = line.trim().startsWith('data:') ? line.trim().slice(5).trim() : '';
    if (!data || data === '[DONE]') continue;
    let ev;
    try { ev = JSON.parse(data); } catch { continue; }
    text += kind === 'gemini'
      ? (ev.candidates?.[0]?.content?.parts || []).filter(p => !p.thought).map(p => p.text || '').join('')
      : (ev.choices?.[0]?.delta?.content ?? ev.response ?? '');
  }
  return text;
}

function pointClientAt(server) {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    if (!u.startsWith(BACKEND_URL)) return realFetch(url, init);
    const res = await realFetch(server + u.slice(BACKEND_URL.length),
      { ...init, headers: { ...init.headers, Origin: 'chrome-extension://leethint-prefill' } });
    let action = '';
    try { action = JSON.parse(init.body || '{}').action; } catch { /* not JSON */ }
    if (action !== 'hints' || !res.ok || !res.body) return res;
    const [mine, theirs] = res.body.tee();
    const kind = res.headers.get('X-LeetHint-Format') || 'openai';
    lastHintsReply = new Response(mine).text().then(sse => sseAnswerText(sse, kind)).catch(() => '');
    return new Response(theirs, { status: res.status, headers: res.headers });
  };
}


// ─────────────────────────────────────────────
// 3. ONE PROBLEM → the static file (shared contract, item 1)
// ─────────────────────────────────────────────
const codeOf = hint5 => String(hint5 || '').match(/```\w*\n([\s\S]*?)```/)?.[1]?.trim() || '';

// "Approach: <text> · TC O(n) · SC O(1)" (api/ai.js applyReference) → <text>
const approachOf = hint5 => (String(hint5 || '').match(/Approach:\s*([\s\S]*)$/)?.[1] || '')
  .split(' · ').filter(part => !/^(TC|SC) /.test(part)).join(' · ').trim();

export async function buildFile(problem, { today = new Date().toISOString().slice(0, 10) } = {}) {
  lastHintsReply = Promise.resolve('');
  const h = await generateHints(problem);
  const reply = await lastHintsReply;
  let cpp = codeOf(h.hint5), tc = h.optimal_tc, sc = h.optimal_sc;
  const problems = [];

  // Compile, and give the model ONE chance to fix what the compiler found
  let compiled = compileCheck(cpp, problem.cppSnippet);
  if (cpp && !compiled.ok) {
    const fixed = await validateSolutionCode(cpp, problem, `Compile error:\n${compiled.error}`);
    if (fixed.code) {
      cpp = fixed.code;
      tc = fixed.tc || tc;
      sc = fixed.sc || sc;
      compiled = compileCheck(cpp, problem.cppSnippet);
    }
  }

  const hints = [h.hint1, h.hint2, h.hint3, h.hint4].map(x => String(x || '').trim());
  if (hints.some(x => x.length < 20)) problems.push('missing hints');
  if (!tc || !sc) problems.push('missing TC/SC');
  if (!cpp) problems.push('missing code');
  else if (!compiled.ok) problems.push(`does not compile: ${compiled.error.split('\n')[0]}`);
  const missing = cpp && problem.cppSnippet ? missingSignatureParts(cpp, problem.cppSnippet) : [];
  if (missing.length) problems.push(`signature mismatch: ${missing.join(', ')}`);
  if (problems.length) return { problems };

  const code = { cpp };
  for (const lang of EXTRA_LANGUAGES) {
    if (problem.codeSnippets && !problem.codeSnippets[lang]) continue;   // LeetCode doesn't offer it here
    try { code[lang] = await translateSolution(cpp, problem, lang); }
    catch (e) { console.warn(`   ${lang} translation skipped: ${e.message}`); }
  }

  return { file: {
    slug: problem.slug, title: problem.title, difficulty: problem.difficulty,
    promptVersion: PROMPT_VERSION, generatedAt: today,
    pattern: h.pattern || '', tc, sc, spaceBreakdown: h.sc_breakdown || '',
    approach: approachOf(h.hint5),
    hints,
    followUps: parseFollowUps(reply),
    code,
    verified: { compiled: compiled.skipped ? 'skipped' : true }
  } };
}


// ─────────────────────────────────────────────
// 4. THE RUN — popular problems first, resumable, paced, stops when quota ends
// ─────────────────────────────────────────────
function readJSON(path, fallback) {
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return fallback; }
}

// Company-tagged problems first (most companies first), then LeetCode's order
function popularFirst(problems) {
  const companies = readJSON(join(ROOT, 'data', 'companies.json'), {});
  const weight = p => (companies[p.slug]?.length || 0);
  return [...problems].sort((a, b) => weight(b) - weight(a) || a.id - b.id);
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  pointClientAt(opts.server);
  const dir = join(opts.out, 'cache');
  mkdirSync(dir, { recursive: true });
  const indexPath = join(opts.out, 'index.json');
  const index = readJSON(indexPath, { promptVersion: PROMPT_VERSION, slugs: {} });
  const saveIndex = () => writeFileSync(indexPath, JSON.stringify({ ...index, promptVersion: PROMPT_VERSION }, null, 1));

  const slugs = opts.only ? [opts.only]
    : popularFirst((await listProblems()).filter(p => !p.paid)).map(p => p.slug);
  console.log(`${slugs.length} problems · prompt ${PROMPT_VERSION} · server ${opts.server} · output ${opts.out}`);

  let made = 0, busyInARow = 0;
  for (const slug of slugs) {
    if (made >= opts.limit) break;
    const path = join(dir, `${slug}.json`);
    if (!opts.force && existsSync(path) && readJSON(path, {}).promptVersion === PROMPT_VERSION) continue;

    const problem = await fetchProblem(slug).catch(e => { console.warn(`${slug}: ${e.message}`); return null; });
    if (!problem) { console.log(`skip ${slug} (premium or unavailable)`); continue; }

    const t0 = Date.now();
    try {
      const { file, problems } = await buildFile(problem);
      busyInARow = 0;
      if (problems) {
        appendFileSync(join(opts.out, 'needs-review.txt'), `${slug}\t${problems.join('; ')}\n`);
        console.log(`✗ ${slug}: ${problems.join('; ')}`);
      } else {
        writeFileSync(path, JSON.stringify(file, null, 1));
        index.slugs[slug] = PROMPT_VERSION;
        saveIndex();
        made++;
        console.log(`✓ ${slug} (${((Date.now() - t0) / 1000).toFixed(0)} s, ${Object.keys(file.code).join('/')}, ${file.followUps.length} follow-ups)`);
      }
    } catch (e) {
      console.log(`✗ ${slug}: ${e.message}`);
      if (e.status === 429 && ++busyInARow >= STOP_AFTER_BUSY) {
        console.log('The AI providers are at their limit — stopping for now. Run again later; finished files are kept.');
        break;
      }
    }
    await new Promise(r => setTimeout(r, opts.delay * 1000));
  }
  console.log(`Done: ${made} new file(s) in ${dir}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(e => { console.error(e.message); process.exit(1); });
}
