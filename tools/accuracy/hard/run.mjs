// 5 very hard problems (<20% acceptance): LeetHint's C++ solution vs LeetCode's
// examples, 300 random brute-force-checked cases, and max-size inputs (TLE).
//   python3 tools/accuracy/hard/gen.py      (once: writes the test drivers)
//   node tools/accuracy/hard/run.mjs        (BACKEND=<url>, default http://localhost:8787)
// Pass mark (prompt p6, 5 Nov 2026): at least 4/5 correct and fast.
import { execFileSync } from 'node:child_process';
import { writeFileSync, readFileSync, mkdirSync } from 'node:fs';
import { generateHints, LANGUAGES } from '../../../api/ai.js';
import { BACKEND_URL } from '../../../api/config.js';

const SERVER = (process.env.BACKEND || 'http://localhost:8787').replace(/\/+$/, '');

let lastModel = '?', lastCache = '?';
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init = {}) => {
  const ours = String(url).startsWith(BACKEND_URL);
  if (ours) {
    url = SERVER + String(url).slice(BACKEND_URL.length);
    init = { ...init, headers: { ...init.headers, Origin: 'chrome-extension://leethint-accuracy' } };
  }
  const res = await realFetch(url, init);
  if (String(url).includes('/v1/generate')) { lastModel = res.headers.get('X-LeetHint-Model') || 'cache'; lastCache = res.headers.get('X-LeetHint-Cache') || '?'; }
  return res;
};
const out = s => process.stdout.write(s + '\n');
console.log = (...a) => { if (!String(a[0]).startsWith('LeetHint:')) out(a.join(' ')); };
console.warn = (...a) => out('   ⚠ ' + a.join(' '));

const here = new URL('./', import.meta.url).pathname;
const work = here + 'work/';
mkdirSync(`${work}bits`, { recursive: true });
writeFileSync(`${work}bits/stdc++.h`, ['algorithm','vector','string','unordered_map','unordered_set','map','set','queue','stack','deque','cmath','climits','numeric','iostream','functional','utility','cstdio','cstring','array','bitset','list','tuple','sstream','iterator','limits','cassert','optional','chrono','random'].map(h => `#include <${h}>`).join('\n'));

const PROBLEMS = [
  ['final-array-state-after-k-multiplication-operations-ii', [/\bheap\b/i, /priority queue/i]],
  ['check-if-digits-are-equal-in-string-after-operations-ii', [/lucas/i, /binomial/i, /pascal/i, /\bncr\b/i, /combinat/i]],
  ['maximum-sum-of-subsequence-with-non-adjacent-elements', [/segment tree/i, /\bdp\b/i, /dynamic programming/i]],
  ['minimum-reverse-operations', [/\bbfs\b/i, /breadth/i, /ordered set/i, /union[- ]find/i, /\bdsu\b/i]],
  ['find-maximum-non-decreasing-array-length', [/monotonic/i, /\bdeque\b/i, /\bdp\b/i, /dynamic programming/i, /prefix sum/i]]
];

function htmlToText(html) {
  return String(html || '').replace(/<sup>(.*?)<\/sup>/g, '^$1').replace(/<li>/g, '- ')
    .replace(/<br\s*\/?>|<\/p>|<\/li>|<\/pre>/g, '\n').replace(/<[^>]+>/g, '')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/\n{3,}/g, '\n\n').trim();
}
async function fetchProblem(slug) {
  const query = `query q($s: String!) { question(titleSlug: $s) {
    questionFrontendId title difficulty content hints topicTags { name } codeSnippets { langSlug code } } }`;
  const res = await realFetch('https://leetcode.com/graphql', { method: 'POST',
    headers: { 'Content-Type': 'application/json', Referer: `https://leetcode.com/problems/${slug}/` },
    body: JSON.stringify({ query, variables: { s: slug } }) });
  const q = (await res.json()).data.question;
  const codeSnippets = {};
  for (const s of q.codeSnippets || []) if (LANGUAGES[s.langSlug]) codeSnippets[s.langSlug] = s.code;
  return { slug, title: q.title, problemNumber: q.questionFrontendId, difficulty: q.difficulty,
           description: htmlToText(q.content), topicTags: q.topicTags.map(t => t.name),
           officialHints: (q.hints || []).map(htmlToText), cppSnippet: codeSnippets.cpp || '', codeSnippets };
}

function build(slug, code, body, tag) {
  const src = `#include <bits/stdc++.h>\nusing namespace std;\n${code}\nusing S = Solution;\n` +
    `int ef=0,et=0,rf=0,rt=0; long long sink=0;\n#define EX(...) do{et++; if(!(__VA_ARGS__)) ef++;}while(0)\n#define RND(...) do{rt++; if(!(__VA_ARGS__)) rf++;}while(0)\n` +
    `int main(){ auto t0=chrono::steady_clock::now();\n${body}\n` +
    `printf("%d %d %d %d %lld %lld\\n", et-ef, et, rt-rf, rt, (long long)chrono::duration_cast<chrono::milliseconds>(chrono::steady_clock::now()-t0).count(), sink%7); return 0; }`;
  const file = `${work}${slug}-${tag}`;
  writeFileSync(file + '.cpp', src);
  execFileSync('clang++', ['-std=c++17', '-O2', '-w', '-I', work, '-o', file, file + '.cpp'], { stdio: 'pipe' });
  return file;
}

const rows = [];
for (const [slug, leak] of PROBLEMS) {
  const p = await fetchProblem(slug);
  out(`\n=== #${p.problemNumber} ${p.title} (${p.difficulty}) ===`);
  const t0 = Date.now();
  let h;
  for (let attempt = 1; attempt <= 4 && !h; attempt++) {
    try { h = await generateHints(p, { language: 'cpp' }); }
    catch (e) { out(`   attempt ${attempt} failed: ${e.message}`); if (attempt < 4) await new Promise(r => setTimeout(r, 30000 * attempt)); }
  }
  const secs = (Date.now() - t0) / 1000;
  if (!h) { rows.push({ title: p.title, failed: true }); continue; }
  const code = String(h.hint5 || '').match(/```\w*\n([\s\S]*?)```/)?.[1] || '';
  const row = { n: p.problemNumber, title: p.title, secs, model: lastModel, cache: lastCache, tc: h.optimal_tc, sc: h.optimal_sc, pattern: h.pattern,
                hintsOk: ['hint1', 'hint2', 'hint3', 'hint4'].every(k => String(h[k] || '').trim().length > 20),
                leaked: leak.filter(re => re.test(h.hint1 || '')).map(re => (h.hint1.match(re) || [])[0]), hint1: h.hint1 };
  writeFileSync(`${work}${slug}.solution.cpp`, code);
  try {
    const bin = build(slug, code, readFileSync(`${here}drivers/${slug}.inc`, 'utf8'), 'check');
    const [ep, et, rp, rt] = execFileSync(bin, { timeout: 20000 }).toString().trim().split(' ').map(Number);
    Object.assign(row, { compiled: true, ep, et, rp, rt });
    try {
      const pbin = build(slug, code, readFileSync(`${here}drivers/${slug}.perf`, 'utf8'), 'perf');
      const r = execFileSync(pbin, { timeout: 10000 }).toString().trim().split(' ').map(Number);
      row.perfMs = r[4];
    } catch (e) { row.perfMs = e.signal === 'SIGTERM' || e.code === 'ETIMEDOUT' ? '>10000 (TLE)' : 'crashed'; }
  } catch (e) {
    row.compiled = !String(e.stderr || '').includes('error');
    row.err = row.compiled ? 'crashed / timed out on tests' : String(e.stderr).split('\n').find(l => /error/.test(l));
  }
  rows.push(row);
  out(`   ${secs.toFixed(1)}s · ${row.model} · ${row.cache} | TC ${row.tc} SC ${row.sc} | pattern ${row.pattern}`);
  out(`   C++: ${row.compiled ? (row.err ? row.err : `examples ${row.ep}/${row.et} · random ${row.rp}/${row.rt} · max-size run ${row.perfMs}${typeof row.perfMs === 'number' ? ' ms' : ''}`) : 'NO COMPILE: ' + row.err}`);
  out(`   Hint 1: ${String(h.hint1).replace(/\s+/g, ' ').slice(0, 230)}${row.leaked.length ? '   ⚠ names: ' + row.leaked.join(', ') : ''}`);
  writeFileSync(here + 'results.json', JSON.stringify(rows, null, 2));
}

const ok = rows.filter(r => !r.failed && r.compiled && !r.err);
out('\n## SUMMARY');
out(`Answered ${rows.filter(r => !r.failed).length}/${rows.length} · compiled ${rows.filter(r => r.compiled).length}/${rows.length}`);
out(`Fully correct (all examples + all random): ${ok.filter(r => r.ep === r.et && r.rp === r.rt).length}/${rows.length}`);
out(`Fast enough on max-size input (<2 s): ${ok.filter(r => typeof r.perfMs === 'number' && r.perfMs < 2000).length}/${rows.length}`);
out(`Accepted-level (correct AND fast): ${ok.filter(r => r.ep === r.et && r.rp === r.rt && typeof r.perfMs === 'number' && r.perfMs < 2000).length}/${rows.length}`);
out(`Hint 1 spoiler-free: ${rows.filter(r => !r.failed && !r.leaked.length).length}/${rows.length}`);
