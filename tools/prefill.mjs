#!/usr/bin/env node
// tools/prefill.mjs — static hint files for every free LeetCode problem.
//
// Each problem is solved ONCE here (on your computer, against a LOCAL Worker
// with a dev key — never the live one), compile-checked, run on LeetCode's
// examples and written as cache-site/cache/<slug>.json. The extension reads
// those files first (by slug), so a pre-filled problem costs no AI call.
// tools/prefill-nightly.sh runs this every morning and publishes the files.
//
//   cd backend && npx wrangler dev --local --var PROVIDER_ORDER:groq   # terminal 1
//   node tools/prefill.mjs --until 07:00                       # terminal 2
//
// Settings: tools/prefill.config.json (window, pace, budgets, languages).
// State:    data/prefill-state.json (gitignored; resumable after a crash).
// Log:      logs/prefill-YYYY-MM-DD.log
//
// Flags:
//   --dry-run          fetch problems + build the request bodies, no Worker calls (shows --limit, default 5)
//   --limit <n>        at most n problems this run (default: maxProblemsPerRun)
//   --only <slug>      just this problem, any time, its usual languages (repeatable; implies --force)
//   --mode <m>         backlog | new | backfill (default: backlog, then new + backfill once the backlog is empty)
//   --until <HH:MM>    end time for this run (default: window.end); also allows a run outside the window
//   --verify [--wait <s>]  check that published files are live on the cache site (after a push)
//   --force            regenerate even if the file already has the current prompt version
//   --worker <url>     default http://localhost:8787   --pace <s>  fixed seconds between problems
//   --out <dir>        default cache-site/             --no-compile  skip the clang++ checks (not recommended)
//   --manual           don't count this run in the per-day rate (set automatically with --only/--until)
//   --ignore-live      start even if the live Worker isn't on this repo's version yet (local tests)
//   --max              no token budget, no per-run cap: run until --until or until Groq refuses (5 in a row)

import { readFileSync, writeFileSync, mkdirSync, existsSync, appendFileSync, renameSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';
import { htmlToText } from '../shared/html-text.js';
import '../shared/problem-data.js';
import { runExamples, describeFailure } from './examples.mjs';
import { windowStatus, clock, tokensLeft, spendTokens, estimateTokens, companyFrequency, orderProblems, planTasks,
         emptyState, recordDone, recordFailure, isTransient, perDay, daysLeft, hackathonWarning, hm } from './prefill-lib.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const { QUESTION_QUERY, problemFromQuestion } = globalThis.LeetHintProblem;
const STATE_FILE = join(ROOT, 'data', 'prefill-state.json');
const ORIGIN = 'chrome-extension://prefill';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const readJson = (f, dflt) => { try { return JSON.parse(readFileSync(f, 'utf8')); } catch { return dflt; } };

// ── arguments ──
function parseArgs(argv) {
  const a = { only: [], force: false, limit: null, out: resolve(ROOT, 'cache-site'), worker: 'http://localhost:8787',
              pace: null, compile: true, dryRun: false, mode: 'auto', until: null, verify: false, wait: 0, manual: false, ignoreLive: false, max: false };
  for (let i = 0; i < argv.length; i++) {
    const f = argv[i], next = () => { if (i + 1 >= argv.length) throw new Error(`${f} needs a value`); return argv[++i]; };
    if (f === '--only') { a.only.push(next()); a.force = true; a.manual = true; }
    else if (f === '--force') a.force = true;
    else if (f === '--limit') a.limit = Number(next());
    else if (f === '--out') a.out = resolve(next());
    else if (f === '--worker') a.worker = next().replace(/\/$/, '');
    else if (f === '--pace') a.pace = Number(next());
    else if (f === '--no-compile') a.compile = false;
    else if (f === '--dry-run') a.dryRun = true;
    else if (f === '--mode') a.mode = next();
    else if (f === '--until') { a.until = next(); hm(a.until); a.manual = true; }
    else if (f === '--verify') a.verify = true;
    else if (f === '--wait') a.wait = Number(next());
    else if (f === '--manual') a.manual = true;
    else if (f === '--ignore-live') a.ignoreLive = true;
    else if (f === '--max') a.max = true;
    else if (f === '--help' || f === '-h') { console.log(readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').slice(1, 33).join('\n')); process.exit(0); }
    else throw new Error(`Unknown flag ${f}`);
  }
  if (!['auto', 'backlog', 'new', 'backfill'].includes(a.mode)) throw new Error(`--mode must be backlog, new or backfill`);
  return a;
}

// ── log: console + logs/prefill-YYYY-MM-DD.log ──
let logFile = null;
function log(...parts) {
  const line = parts.join(' ');
  console.log(line);
  if (logFile) try { appendFileSync(logFile, `${new Date().toISOString().slice(11, 19)} ${line}\n`); } catch {}
}

// ── LeetCode GraphQL ──
export async function leetcode(query, variables) {
  for (let attempt = 1; ; attempt++) {
    try {
      const res = await fetch('https://leetcode.com/graphql', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Referer: 'https://leetcode.com/problemset/', 'User-Agent': 'LeetHint-prefill' },
        body: JSON.stringify({ query, variables }),
        signal: AbortSignal.timeout(20000)
      });
      if (res.ok) return (await res.json()).data;
      if (attempt >= 3) throw new Error(`LeetCode GraphQL HTTP ${res.status}`);
    } catch (e) {
      if (attempt >= 3) throw e;
    }
    await sleep(5000 * attempt);
  }
}

// Every algorithm (+ concurrency) problem: { questionFrontendId, titleSlug, isPaidOnly, likes, difficulty }.
// Database / shell / pandas problems have no C++ and are left out.
export async function listProblems() {
  const query = `query list($categorySlug: String, $limit: Int, $skip: Int) {
    questionList(categorySlug: $categorySlug, limit: $limit, skip: $skip, filters: {}) {
      totalNum data { questionFrontendId titleSlug isPaidOnly likes difficulty }
    }
  }`;
  const all = [];
  for (const categorySlug of ['algorithms', 'concurrency']) {
    for (let skip = 0, got = 0; ; skip += 100) {
      const page = (await leetcode(query, { categorySlug, limit: 100, skip })).questionList;
      all.push(...page.data);
      got += page.data.length;
      if (!page.data.length || got >= page.totalNum) break;
    }
  }
  return all;
}

// The same query and mapping as content/content.js (shared/problem-data.js)
export async function problemData(slug) {
  const q = (await leetcode(QUESTION_QUERY, { titleSlug: slug })).question;
  if (!q?.content) return null;   // premium or gone
  return problemFromQuestion(q, { slug, htmlToText });
}

// ── the extension's own client, pointed at the local Worker ──
async function loadClient(workerUrl) {
  const { BACKEND_URL, CACHE_URL } = await import('../api/config.js');
  const realFetch = globalThis.fetch;
  globalThis.fetch = (url, init = {}) => {
    const u = String(url);
    // Never read our own static files back — this script is what writes them
    if (CACHE_URL && u.startsWith(CACHE_URL)) return Promise.resolve(new Response('', { status: 404 }));
    if (u.startsWith(BACKEND_URL)) {
      return realFetch(workerUrl + u.slice(BACKEND_URL.length), { ...init, headers: { ...init.headers, Origin: ORIGIN } });
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

// ── one problem: hints + C++ (+ langs) → the static file object ──
// usage.tokens is increased by the estimated cost of every AI call made
async function generate(client, problem, { compile, promptVersion, langs, tokens, usage }) {
  const spend = n => { usage.tokens += n; };
  spend(tokens.hints);
  const result = await client.generateHints(problem, { language: 'cpp' });
  let sol = result.solution;
  if (!sol?.code) throw new Error('no code in the reply');
  let compiled = null;
  if (compile) {
    let err = compileError(sol.code);
    if (err) {
      log(`  compile error → asking for a fix:\n    ${err.split('\n')[0]}`);
      spend(tokens.fix);
      const fixed = await client.validateSolutionCode(sol.code, problem, `Compile error:\n${err}`);
      err = compileError(fixed.code);
      if (err) throw Object.assign(new Error(`still does not compile: ${err.split('\n')[0]}`), { review: true });
      sol = { ...sol, code: fixed.code, tc: fixed.tc || sol.tc, sc: fixed.sc || sol.sc };
      result.sc_breakdown = fixed.scBreakdown || result.sc_breakdown;
    }
    compiled = true;
  }
  // LeetCode's own examples: a wrong answer gets one fix with the failing case
  // as the reason; still wrong → needs review, never a static file
  let examples = null;
  if (compile) {
    let ex = await runExamples(problem.slug, sol.code, { leetcode });
    if (!ex.ok && ex.failures) {
      const why = ex.failures.map(describeFailure).join('\n');
      log(`  examples ${ex.passed}/${ex.total} → asking for a fix:\n    ${why.split('\n')[0]}`);
      spend(tokens.fix);
      const fixed = await client.validateSolutionCode(sol.code, problem, `Wrong Answer on LeetCode's examples:\n${why}`);
      if (fixed?.code && !compileError(fixed.code)) {
        ex = await runExamples(problem.slug, fixed.code, { leetcode });
        if (ex.ok) sol = { ...sol, code: fixed.code, tc: fixed.tc || sol.tc, sc: fixed.sc || sol.sc };
      }
      if (!ex.ok) throw Object.assign(new Error(`wrong on LeetCode's examples (${ex.passed ?? 0}/${ex.total ?? '?'}): ${describeFailure(ex.failures?.[0] || {})}`), { review: true });
    }
    if (ex.ok) examples = `${ex.passed}/${ex.total}`;
    else log(`  examples not run: ${ex.skipped}`);
  }
  const hints = [result.hint1, result.hint2, result.hint3, result.hint4].map(h => (h || '').trim());
  const problems = [];
  if (hints.some(h => !h)) problems.push('fewer than 4 hints');
  if (!sol.tc || !sol.sc) problems.push('missing TC/SC');
  const missing = problem.cppSnippet ? client.missingSignatureParts(sol.code, problem.cppSnippet) : [];
  if (missing.length) problems.push(`signature: missing ${missing.join(', ')}`);
  if (problems.length) throw Object.assign(new Error(problems.join('; ')), { review: true });

  const file = {
    slug: problem.slug, title: problem.title, difficulty: problem.difficulty,
    promptVersion, generatedAt: new Date().toISOString().slice(0, 10),
    pattern: result.pattern || '', tc: sol.tc, sc: sol.sc, spaceBreakdown: result.sc_breakdown || '',
    approach: sol.approach || '',
    hints,
    followUps: result.followUps || [],
    code: { cpp: sol.code },
    verified: { compiled: compiled === true, ...(examples ? { examples } : {}) }
  };
  await translate(client, problem, file, langs, { tokens, usage });
  return file;
}

// Adds translations of the verified C++ (missing ones are translated on demand
// by the extension later, so a failure here never fails the problem)
async function translate(client, problem, file, langs, { tokens, usage }) {
  for (const lang of langs) {
    if (file.code[lang] || !problem.codeSnippets[lang]) continue;
    usage.tokens += tokens.translation;
    try { file.code[lang] = await client.translateSolution(file.code.cpp, problem, lang); }
    catch (e) {
      if (isTransient(e)) throw e;
      log(`  ${lang} translation failed (${e.message}) — the extension translates it on demand`);
    }
  }
}

// ── state (written atomically after every problem: safe after a crash or sleep) ──
function loadState() {
  const s = readJson(STATE_FILE, null);
  return s && s.version === 1 ? { ...emptyState(), ...s } : emptyState();
}
function saveState(state) {
  mkdirSync(dirname(STATE_FILE), { recursive: true });
  writeFileSync(STATE_FILE + '.tmp', JSON.stringify(state, null, 1) + '\n');
  renameSync(STATE_FILE + '.tmp', STATE_FILE);
}

const fileOf = (out, slug) => join(out, 'cache', `${slug}.json`);
function fileInfoFor(out) {
  return slug => {
    const f = readJson(fileOf(out, slug), null);
    return f ? { promptVersion: f.promptVersion, langs: Object.keys(f.code || {}) } : null;
  };
}

// The Worker code version (backend/src/version.js)
function sourceWorkerVersion() {
  return /WORKER_VERSION\s*=\s*'([^']+)'/.exec(readFileSync(join(ROOT, 'backend/src/version.js'), 'utf8'))?.[1] || '';
}
async function health(url) {
  const res = await fetch(`${url}/health`, { headers: { Origin: ORIGIN }, signal: AbortSignal.timeout(8000) });
  return res.json();
}

// ── --verify: are the files we wrote live on the cache site? ──
async function verifyPublished(state, { wait }) {
  const { CACHE_URL } = await import('../api/config.js');
  const { mapStaticFile } = await import('../api/ai.js');
  const deadline = Date.now() + wait * 1000;
  for (;;) {
    const pending = Object.entries(state.done).filter(([, d]) => !d.published).map(([s]) => s);
    let ok = 0;
    for (const slug of pending) {
      try {
        const res = await fetch(`${CACHE_URL}/cache/${slug}.json?v=${Date.now()}`, { signal: AbortSignal.timeout(8000) });
        const file = res.ok ? await res.json() : null;
        if (mapStaticFile(file) && file.promptVersion === state.done[slug].promptVersion) {
          state.done[slug].published = true; ok++;
        }
      } catch {}
    }
    saveState(state);
    const left = pending.length - ok;
    if (pending.length) log(`Published check: ${ok}/${pending.length} live on ${CACHE_URL}${left ? `, ${left} not yet` : ''}`);
    else log('Published check: nothing waiting.');
    if (!left || Date.now() >= deadline) return left;
    await sleep(30000);
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const cfg = JSON.parse(readFileSync(join(ROOT, 'tools/prefill.config.json'), 'utf8'));
  const startedAt = Date.now();
  mkdirSync(join(ROOT, 'logs'), { recursive: true });
  logFile = join(ROOT, 'logs', `prefill-${clock(new Date(), cfg.timeZone).date}.log`);
  const state = loadState();
  log(`=== ${new Date().toLocaleString('en-GB', { timeZone: cfg.timeZone })} IST · prefill ${process.argv.slice(2).join(' ')}`);

  if (args.verify) { const left = await verifyPublished(state, args); process.exitCode = left ? 2 : 0; return; }

  const { PROMPT_VERSION } = await import('../shared/prompts.js');
  const win = { timeZone: cfg.timeZone, start: args.until ? '00:00' : cfg.window.start, end: args.until || cfg.window.end, quotaReset: cfg.window.quotaReset };
  if (!args.dryRun && !args.only.length && !windowStatus(new Date(), win).inside) {
    log(`Outside the run window ${win.start}–${win.end} (${cfg.timeZone}). Nothing done. For a run now: --until HH:MM`);
    return;
  }

  let client = null;
  if (!args.dryRun) {
    // The local Worker must run this repo's code; the live one should too
    const want = sourceWorkerVersion();
    let h;
    try { h = await health(args.worker); }
    catch (e) { throw new Error(`Local Worker not reachable at ${args.worker} (${e.message}). Start it: cd backend && npx wrangler dev --local --var PROVIDER_ORDER:groq`); }
    if (!h.providers?.length) throw new Error('Local Worker has no AI provider — put the dev GROQ_API_KEY in backend/.dev.vars');
    if (h.version !== want) throw new Error(`Local Worker runs version ${h.version || '(none)'}, this repo is ${want}. Restart wrangler dev.`);
    if (h.providers.some(p => p !== 'Groq')) log(`⚠ Local Worker also uses ${h.providers.filter(p => p !== 'Groq').join(', ')} — start it with --var PROVIDER_ORDER:groq so Yug's account quota (live users) is never used.`);
    const { BACKEND_URL } = await import('../api/config.js');
    const live = await health(BACKEND_URL).catch(() => ({}));
    if (live.version !== want) {
      const msg = `The live Worker (${BACKEND_URL}) runs ${live.version || 'an older version'}, not ${want}: Yug has not deployed DEPLOY_FOR_YUG.md yet.`;
      if (cfg.requireLiveVersion !== false && !args.ignoreLive) throw new Error(`${msg} Refusing to start (set "requireLiveVersion": false in tools/prefill.config.json to pre-fill anyway — static files don't depend on it).`);
      log(`⚠ ${msg}`);
    }
    log(`Local Worker ${args.worker}: ${h.providers.join(', ')} · version ${h.version} (live: ${live.version})`);
    client = await loadClient(args.worker);
  }

  // ── what to do ──
  const lists = readJson(join(ROOT, 'data/priority-lists.json'), {});
  const freq = companyFrequency(readJson(join(ROOT, 'data/company-problems.json'), {}), readJson(join(ROOT, 'data/companies.json'), {}));
  const all = await listProblems();
  const free = all.filter(q => !q.isPaidOnly);
  const ids = Object.fromEntries(free.map(q => [q.titleSlug, q.questionFrontendId]));
  if (!state.backlogMaxId) state.backlogMaxId = Math.max(0, ...free.map(q => Number(q.questionFrontendId) || 0));
  const ordered = orderProblems(free, lists, freq);
  const plan = planTasks({ ordered, ids, state, cfg, mode: args.mode, promptVersion: PROMPT_VERSION,
                           fileInfo: args.force ? () => null : fileInfoFor(args.out), only: args.only });
  const unknownListed = [...(lists.blind75 || []), ...(lists.neetcode150 || [])].filter(s => !all.some(q => q.titleSlug === s));
  if (unknownListed.length) log(`Note: not on LeetCode's list: ${[...new Set(unknownListed)].join(', ')}`);
  log(`${free.length} free problems · mode ${plan.mode} · ${plan.remaining} left in the backlog (${plan.priorityRemaining} of the first ${cfg.priority.count})` +
      (plan.backfillLeft ? ` · ${plan.backfillLeft} to backfill` : ''));

  // Files already there (the weekly sync, an earlier crashed run) count as done
  let alreadyCached = 0;
  for (const slug of plan.cachedNow) {
    const f = fileInfoFor(args.out)(slug);
    recordDone(state, slug, { promptVersion: f.promptVersion, langs: f.langs, at: new Date().toISOString() });
    state.done[slug].published = true;   // came from git: it is on the site already
    alreadyCached++;
  }

  const limit = args.limit ?? (args.dryRun ? 5 : args.max ? Infinity : cfg.maxProblemsPerRun);

  if (args.dryRun) {
    const { problemPayload } = await import('../api/ai.js');
    const out = [];
    for (const task of plan.tasks.slice(0, limit)) {
      const problem = await problemData(task.slug);
      if (!problem) { log(`- ${task.slug}: premium or unavailable`); continue; }
      const body = { action: task.kind === 'translate' ? 'translate' : 'hints', problem: problemPayload(problem), code: '', lowEffort: false };
      out.push({ task, headers: { 'Content-Type': 'application/json', Origin: ORIGIN }, body });
      log(`→ ${problem.problemNumber}. ${problem.title} (${problem.difficulty}) · ${task.kind}${task.priority ? ' · priority' : ''} · ` +
          `langs: cpp${task.langs.length ? ', ' + task.langs.join(', ') : ''} · ~${estimateTokens(task, cfg.tokens)} tokens · description ${problem.description.length} chars`);
    }
    const file = join(ROOT, 'logs', 'dry-run-payloads.json');
    writeFileSync(file, JSON.stringify(out, null, 2) + '\n');
    log(`Dry run: ${out.length} request bodies → ${file} (no Worker calls, state not changed)`);
    return;
  }

  // ── run ──
  const run = { at: new Date().toISOString(), mode: plan.mode, manual: args.manual, newCached: 0, alreadyCached, failed: 0, tokens: 0, seconds: 0, stopped: '' };
  const usage = { tokens: 0 };
  let transientInARow = 0, done = 0;
  for (const [i, task] of plan.tasks.entries()) {
    if (done >= limit) { run.stopped = `limit of ${limit} problems`; break; }
    let w = windowStatus(new Date(), win);
    if (!args.only.length && !w.inside) { run.stopped = `end of the window (${win.end})`; break; }
    // Token budget of this phase; the old day's budget gone → wait for the reset
    const cost = estimateTokens(task, cfg.tokens);
    if (!args.only.length && !args.max && tokensLeft(state, new Date(), w.phase, cfg.tokens) < cost) {
      if (w.phase === 'before' && w.msToReset < w.msLeft) {
        log(`Old day's token budget used — waiting ${Math.ceil(w.msToReset / 60000)} min for the ${cfg.window.quotaReset} reset`);
        await sleep(w.msToReset + 5000);
        w = windowStatus(new Date(), win);
        if (tokensLeft(state, new Date(), w.phase, cfg.tokens) < cost) { run.stopped = 'token budget'; break; }
      } else { run.stopped = `token budget (${w.phase} ${cfg.window.quotaReset})`; break; }
    }

    const started = Date.now();
    const phase = w.phase;
    const before = usage.tokens;
    try {
      const problem = await problemData(task.slug);
      const skip = !problem ? 'premium or unavailable' : !problem.cppSnippet ? 'no C++ starter code' : '';
      if (skip) { log(`- ${task.slug}: ${skip}, skipped for good`); state.skipped[task.slug] = skip; saveState(state); continue; }
      log(`→ ${problem.problemNumber}. ${problem.title} (${problem.difficulty}) · ${task.kind}${task.priority ? ' · priority' : ''} · cpp${task.langs.length ? ', ' + task.langs.join(', ') : ''}`);
      let file;
      if (task.kind === 'translate') {
        file = readJson(fileOf(args.out, task.slug), null);
        if (!file?.code?.cpp) throw Object.assign(new Error('no file to add languages to'), { review: true });
        await translate(client, problem, file, task.langs, { tokens: cfg.tokens, usage });
      } else {
        file = await generate(client, problem, { compile: args.compile, promptVersion: PROMPT_VERSION, langs: task.langs, tokens: cfg.tokens, usage });
      }
      mkdirSync(join(args.out, 'cache'), { recursive: true });
      writeFileSync(fileOf(args.out, task.slug), JSON.stringify(file, null, 2) + '\n');
      const indexFile = join(args.out, 'index.json');
      const index = readJson(indexFile, { promptVersion: PROMPT_VERSION, slugs: {} });
      index.promptVersion = PROMPT_VERSION;
      index.slugs[task.slug] = file.promptVersion;
      writeFileSync(indexFile, JSON.stringify(index, null, 2) + '\n');
      // Languages asked for count as done even when the problem has no snippet for one
      recordDone(state, task.slug, { promptVersion: file.promptVersion, langs: ['cpp', ...task.langs], at: new Date().toISOString() });
      log(`  ✓ ${task.slug}.json  ${file.pattern} · TC ${file.tc} · SC ${file.sc} · ${Object.keys(file.code).join(', ')} (${Math.round((Date.now() - started) / 1000)} s, ~${usage.tokens - before} tokens)`);
      run.newCached++; done++;
      transientInARow = 0;
    } catch (e) {
      const transient = isTransient(e);
      recordFailure(state, task.slug, e.message, { at: run.at, countsAsAttempt: !transient });
      run.failed++;
      log(`  ✗ ${task.slug}: ${e.message}${transient ? ' (AI/network busy)' : ` (attempt ${state.failed[task.slug].attempts}/${cfg.maxAttempts})`}`);
      if (e.review) appendFileSync(join(ROOT, 'tools', 'needs-review.txt'), `${task.slug}\t${new Date().toISOString().slice(0, 10)}\t${e.message.replace(/\s+/g, ' ')}\n`);
      if (transient && ++transientInARow >= cfg.stopAfterErrors) { run.stopped = `${cfg.stopAfterErrors} busy/429/5xx errors in a row`; spendTokens(state, new Date(), phase, usage.tokens - before); saveState(state); break; }
      if (!transient) transientInARow = 0;
    }
    spendTokens(state, new Date(), phase, usage.tokens - before);
    saveState(state);

    // Pace between problems, never past the end of the window
    if (i < plan.tasks.length - 1 && done < limit) {
      const pace = args.pace != null ? args.pace * 1000 : (cfg.paceSeconds.min + Math.random() * (cfg.paceSeconds.max - cfg.paceSeconds.min)) * 1000;
      const left = args.only.length ? Infinity : windowStatus(new Date(), win).msLeft;
      await sleep(Math.min(pace, left));
    }
  }
  if (!run.stopped) run.stopped = 'queue empty';

  // ── summary ──
  run.tokens = usage.tokens;
  run.seconds = Math.round((Date.now() - startedAt) / 1000);
  state.runs = [...(state.runs || []), run].slice(-60);
  state.lastRun = run.at;
  state.totals.newCached += run.newCached; state.totals.alreadyCached += alreadyCached; state.totals.failed += run.failed;
  const after = planTasks({ ordered, ids, state, cfg, mode: 'auto', promptVersion: PROMPT_VERSION, fileInfo: fileInfoFor(args.out) });
  saveState(state);
  const rate = perDay(state, cfg.defaultProblemsPerDay);
  const doneTotal = Object.keys(state.done).length;
  log('');
  log(`Summary (${run.stopped}, ${Math.round(run.seconds / 60)} min, ~${run.tokens} tokens):`);
  log(`  new cached ${run.newCached} · already cached ${alreadyCached} · failed ${run.failed} · done in total ${doneTotal}`);
  log(`  remaining ${after.remaining} (first ${cfg.priority.count}: ${after.priorityRemaining} left) · ~${Math.round(rate)}/day → ~${daysLeft(after.remaining, rate)} day(s) left` +
      (after.priorityRemaining ? `, first ${cfg.priority.count} in ~${daysLeft(after.priorityRemaining, rate)}` : '') +
      (after.backfillLeft ? ` · then ${after.backfillLeft} to backfill (${cfg.languages.join(', ')})` : ''));
  if (after.exhausted.length) log(`  gave up after ${cfg.maxAttempts} attempts (${after.exhausted.length}): ${after.exhausted.slice(0, 30).join(', ')}${after.exhausted.length > 30 ? ' …' : ''}`);
  if (!after.remaining) log(`  Backlog finished — the daily run now adds only new problems (--mode new) and backfills languages.`);
  const warn = hackathonWarning({ priorityRemaining: after.priorityRemaining, rate, hackathon: cfg.hackathon, today: clock(new Date(), cfg.timeZone).date, count: cfg.priority.count });
  if (warn) log(`  ${warn}`);
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  main().catch(e => { log(`✗ ${e.message}`); process.exit(1); });
}
