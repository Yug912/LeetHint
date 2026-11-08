// tools/examples.mjs — run a C++ solution on LeetCode's own examples.
//
// Inputs come from LeetCode's exampleTestcaseList, expected outputs from the
// statement's "Output:" lines, argument/return types from metaData. The code is
// compiled with clang++ (tools/cpp/leetcode-prelude.h) and its answers compared
// (order-free where the problem allows any order). Used by tools/prefill.mjs
// and tools/export-d1.mjs so that no static file ships a solution that fails
// the problem's own examples. Free: a local compiler, no AI call.
//
//   import { runExamples } from './examples.mjs';
//   await runExamples('two-sum', cppCode)
//   → { ok: true, passed: 3, total: 3 }
//   → { ok: false, passed: 1, total: 3, failures: [{ input, expected, got }] }
//   → { ok: false, skipped: '<why the examples could not be run>' }   (unsupported type, no compiler…)

import { writeFileSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { htmlToText } from '../shared/html-text.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// Problems whose answer may come in any order (LeetCode accepts any)
export const ANY_ORDER = {
  'two-sum': 'flat', '3sum': 'deep', '4sum': 'deep', 'group-anagrams': 'deep', 'n-queens': 'outer',
  'permutations': 'outer', 'permutations-ii': 'outer', 'subsets': 'deep', 'subsets-ii': 'deep',
  'combination-sum': 'deep', 'combination-sum-ii': 'deep', 'combinations': 'deep', 'top-k-frequent-elements': 'flat',
  'find-all-anagrams-in-a-string': 'flat', 'k-closest-points-to-origin': 'outer'
};

const base = t => t.replace(/^list<(.+)>$/, '$1[]');
const SCALAR = { integer: 'int', long: 'long long', double: 'double', boolean: 'bool', string: 'string', character: 'char', ListNode: 'ListNode*', TreeNode: 'TreeNode*' };

export function cppType(t) {
  t = base(t);
  if (t.endsWith('[]')) return `vector<${cppType(t.slice(0, -2))}>`;
  if (!SCALAR[t]) throw new Error(`unsupported type ${t}`);
  return SCALAR[t];
}

// A LeetCode test-case value (JSON) → a C++ expression of the given type
export function cppLiteral(t, v) {
  t = base(t);
  if (t === 'ListNode') return `mkList({${v.join(',')}})`;
  if (t === 'TreeNode') return `mkTree({${v.map(x => (x === null ? 'NUL' : x)).join(',')}})`;
  if (t.endsWith('[]')) return `${cppType(t)}{${v.map(x => cppLiteral(t.slice(0, -2), x)).join(',')}}`;
  if (t === 'string') return JSON.stringify(v);
  if (t === 'character') return `'${v === "'" || v === '\\' ? '\\' + v : v}'`;
  if (t === 'boolean') return v ? 'true' : 'false';
  if (t === 'long') return `${v}LL`;
  if (t === 'integer' || t === 'double') return String(v);
  throw new Error(`unsupported type ${t}`);
}

// "Output: [0,1]" lines of the statement, in order
export function expectedOutputs(html) {
  return [...htmlToText(html).matchAll(/Output:?\s*([^\n]+)/g)].map(m => m[1].trim());
}

const sortRec = x => Array.isArray(x) ? x.map(sortRec).sort((a, b) => (JSON.stringify(a) < JSON.stringify(b) ? -1 : 1)) : x;
export function normalise(v, mode) {
  if (!Array.isArray(v) || !mode) return v;
  if (mode === 'flat') return [...v].sort((a, b) => (JSON.stringify(a) < JSON.stringify(b) ? -1 : 1));
  if (mode === 'outer') return [...v].sort((a, b) => (JSON.stringify(a) < JSON.stringify(b) ? -1 : 1));
  return sortRec(v);
}
export function sameAnswer(a, b) {
  if (typeof a === 'number' && typeof b === 'number') return Math.abs(a - b) <= 1e-5 * Math.max(1, Math.abs(b));
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((x, i) => sameAnswer(x, b[i]));
  return JSON.stringify(a) === JSON.stringify(b);
}
const parse = s => { try { return JSON.parse(s); } catch { return s; } };

const PRELUDE = `#include "leetcode-prelude.h"
const int NUL = INT_MIN;
ListNode* mkList(vector<int> v){ListNode d; ListNode* t=&d; for(int x:v){t->next=new ListNode(x); t=t->next;} return d.next;}
TreeNode* mkTree(vector<int> v){ if(v.empty()||v[0]==NUL) return nullptr; TreeNode* r=new TreeNode(v[0]); queue<TreeNode*> q; q.push(r); size_t i=1;
  while(!q.empty()&&i<v.size()){ TreeNode* n=q.front(); q.pop();
    if(i<v.size()&&v[i]!=NUL){n->left=new TreeNode(v[i]); q.push(n->left);} i++;
    if(i<v.size()&&v[i]!=NUL){n->right=new TreeNode(v[i]); q.push(n->right);} i++; } return r; }
void pr(int x){cout<<x;} void pr(long long x){cout<<x;} void pr(bool x){cout<<(x?"true":"false");}
void pr(double x){cout<<setprecision(10)<<x;} void pr(char c){cout<<'"'<<c<<'"';}
void pr(const string& s){cout<<'"'; for(char c:s){ if(c=='"'||c=='\\\\') cout<<'\\\\'; cout<<c;} cout<<'"';}
void pr(ListNode* l){cout<<'['; bool f=1; while(l){ if(!f) cout<<','; f=0; cout<<l->val; l=l->next;} cout<<']';}
void pr(TreeNode* t){ vector<string> o; queue<TreeNode*> q; q.push(t);
  while(!q.empty()){ TreeNode* n=q.front(); q.pop(); if(!n){o.push_back("null"); continue;} o.push_back(to_string(n->val)); q.push(n->left); q.push(n->right);}
  while(!o.empty()&&o.back()=="null") o.pop_back(); cout<<'['; for(size_t i=0;i<o.size();i++){ if(i) cout<<','; cout<<o[i];} cout<<']'; }
template<class T> void pr(const vector<T>& v){cout<<'['; for(size_t i=0;i<v.size();i++){ if(i) cout<<','; pr(v[i]);} cout<<']';}
`;

// The C++ test program for one problem (no network) — exported for tests
export function buildProgram(code, meta, cases) {
  let body = '';
  for (const args of cases) {
    const decl = meta.params.map((p, j) => `${cppType(p.type)} a${j} = ${cppLiteral(p.type, args[j])};`).join(' ');
    body += `  { ${decl} Solution s; auto r = s.${meta.name}(${meta.params.map((_, j) => `a${j}`).join(', ')}); pr(r); cout << "\\n"; }\n`;
  }
  return `${PRELUDE}\n${code}\n\nint main() {\n${body}}\n`;
}

export async function runExamples(slug, code, { leetcode, cxx = process.env.CXX || 'clang++' } = {}) {
  leetcode ||= (await import('./prefill.mjs')).leetcode;
  const q = (await leetcode(`query q($s: String!) { question(titleSlug: $s) { content metaData exampleTestcaseList } }`, { s: slug })).question;
  if (!q?.metaData || !q.exampleTestcaseList?.length) return { ok: false, skipped: 'no examples from LeetCode' };
  let meta, cases, program;
  try {
    meta = JSON.parse(q.metaData);
    if (!meta.name || !meta.params || !meta.return || meta.return.type === 'void') return { ok: false, skipped: 'in-place or design problem' };
    cppType(meta.return.type);
    cases = q.exampleTestcaseList.map(c => c.split('\n').map(x => JSON.parse(x)));
    program = buildProgram(code, meta, cases);
  } catch (e) {
    return { ok: false, skipped: e.message };
  }
  const expected = expectedOutputs(q.content);
  if (expected.length < cases.length) return { ok: false, skipped: `${expected.length} expected outputs for ${cases.length} examples` };

  const dir = join(tmpdir(), 'leethint-examples');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${slug}.cpp`), bin = join(dir, slug);
  writeFileSync(file, program);
  try {
    execFileSync(cxx, ['-std=c++17', '-O1', '-w', '-I', join(ROOT, 'tools/cpp'), file, '-o', bin], { stdio: 'pipe' });
  } catch (e) {
    if (e.code === 'ENOENT') return { ok: false, skipped: `${cxx} not found` };
    return { ok: false, passed: 0, total: cases.length, failures: [{ error: 'compile: ' + String(e.stderr).split('\n').find(l => /error/.test(l)) }] };
  }
  let got;
  try {
    got = execFileSync(bin, { timeout: 10000, stdio: 'pipe' }).toString().trim().split('\n');
  } catch (e) {
    return { ok: false, passed: 0, total: cases.length, failures: [{ error: e.signal === 'SIGTERM' ? 'time limit (10 s)' : `runtime error (${e.signal || e.status})` }] };
  }
  const mode = ANY_ORDER[slug];
  const failures = [];
  cases.forEach((args, i) => {
    if (!sameAnswer(normalise(parse(got[i]), mode), normalise(parse(expected[i]), mode))) {
      failures.push({ input: q.exampleTestcaseList[i].replace(/\n/g, ', '), expected: expected[i], got: got[i] ?? '(nothing)' });
    }
  });
  return { ok: !failures.length, passed: cases.length - failures.length, total: cases.length, ...(failures.length ? { failures } : {}) };
}

// One line for logs and the Fix prompt: "nums = [3,2,4], target = 6 → expected [1,2], got [0,0]"
export function describeFailure(f) {
  return f.error || `Input ${f.input} → expected ${f.expected}, got ${f.got}`;
}
