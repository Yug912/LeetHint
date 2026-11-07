// tools/leetcode.mjs — helpers for the pre-fill and accuracy scripts (Node
// 18+, run on your computer): LeetCode data (re-exported from
// shared/leetcode.js, shared with the Worker) and a local C++ compile check.

import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export { htmlToText, decodeEntities, listProblems, fetchProblem, runningContestSlugs } from '../shared/leetcode.js';


// ─────────────────────────────────────────────
// 3. C++ COMPILE CHECK — catches what the AI can't see (undeclared names,
//    functions defined inside functions, missing members). Syntax and types
//    only: nothing is run.
// ─────────────────────────────────────────────

// macOS's clang has no <bits/stdc++.h> — a stand-in with what LeetCode includes
const STDCPP = ['algorithm', 'array', 'bitset', 'cassert', 'climits', 'cmath', 'cstdio', 'cstdlib', 'cstring',
  'deque', 'functional', 'iostream', 'iterator', 'limits', 'list', 'map', 'numeric', 'optional', 'queue',
  'random', 'set', 'sstream', 'stack', 'string', 'tuple', 'unordered_map', 'unordered_set', 'utility', 'vector',
  'chrono', 'cstdint', 'memory', 'climits', 'regex', 'iomanip'].map(h => `#include <${h}>`).join('\n');

// LeetCode's starter code keeps helper types (ListNode, TreeNode, Node,
// NestedInteger, …) in a comment: un-comment them so the solution compiles
export function helperTypes(cppSnippet) {
  // Every comment's text, comment markers removed
  const comments = [
    ...(String(cppSnippet || '').match(/\/\*[\s\S]*?\*\//g) || []).map(b => b.replace(/^\/\*+|\*+\/$/g, '')
      .split('\n').map(l => l.replace(/^\s*\*(?!\/)\s?/, '')).join('\n')),
    (String(cppSnippet || '').match(/^\s*\/\/.*$/gm) || []).map(l => l.replace(/^\s*\/\/\s?/, '')).join('\n')
  ].join('\n');
  // Only the struct/class definitions themselves (prose lines dropped), by brace matching
  const out = [];
  for (const m of comments.matchAll(/\b(?:struct|class)\s+\w+[^{;()]*\{/g)) {
    let depth = 0, i = m.index;
    for (; i < comments.length; i++) {
      if (comments[i] === '{') depth++;
      else if (comments[i] === '}' && --depth === 0) break;
    }
    if (depth !== 0) continue;
    const def = comments.slice(m.index, i + 1) + ';';
    if (!out.some(d => d.includes(def))) out.push(def);
  }
  return out.join('\n\n');
}

let compilerCache;
function compiler() {
  if (compilerCache !== undefined) return compilerCache;
  for (const c of ['clang++', 'g++']) {
    try { execFileSync(c, ['--version'], { stdio: 'ignore' }); return (compilerCache = c); } catch { /* next */ }
  }
  return (compilerCache = null);
}

// → { ok: true } | { ok: false, error: '<first compiler errors>' } | { ok: true, skipped: true } (no compiler)
export function compileCheck(code, cppSnippet) {
  const cxx = compiler();
  if (!cxx) return { ok: true, skipped: true };
  const dir = mkdtempSync(join(tmpdir(), 'leethint-cc-'));
  try {
    mkdirSync(join(dir, 'bits'));
    writeFileSync(join(dir, 'bits', 'stdc++.h'), STDCPP);
    writeFileSync(join(dir, 'solution.cpp'),
      `#include <bits/stdc++.h>\nusing namespace std;\n${helperTypes(cppSnippet)}\n${code}\n`);
    execFileSync(cxx, ['-std=c++17', '-fsyntax-only', '-w', '-I', dir, join(dir, 'solution.cpp')], { stdio: 'pipe', timeout: 60000 });
    return { ok: true };
  } catch (e) {
    const lines = String(e.stderr || e.message).split('\n').filter(l => /error/.test(l)).slice(0, 5);
    return { ok: false, error: lines.map(l => l.replace(/^.*solution\.cpp:/, 'line ')).join('\n') || 'compile error' };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
