// 10 standard problems (Easy → Hard): hints + solutions through the extension's
// own client. C++ is compiled and run on LeetCode's examples plus edge cases;
// Python solutions (asked as the user's language) are run too.
//   node tools/accuracy/standard.mjs        (BACKEND=<url>, default http://localhost:8787)
// Pass mark: 10/10 fully correct, Hint 1 clean on at least 9/10.
// Met on prompt p6 (5 Nov 2026); must be met again on the current PROMPT_VERSION
// before the pre-fill runs (a prompt change can change every answer).
import { execFileSync } from 'node:child_process';
import { writeFileSync, mkdirSync } from 'node:fs';
import { generateHints, compareComplexity, LANGUAGES } from '../../api/ai.js';
import { BACKEND_URL } from '../../api/config.js';

const LOCAL = process.env.BACKEND || 'http://localhost:8787';
let lastCache = '?', lastModel = '?';
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init = {}) => {
  // Test the live prompt, never a pre-made file from the static cache site
  if (/^https?:\/\/[^/]+\/cache\/[a-z0-9-]+\.json/i.test(String(url)) && !String(url).startsWith(BACKEND_URL)) {
    return new Response('', { status: 404 });
  }
  let u = String(url);
  if (u.startsWith(BACKEND_URL)) {
    u = LOCAL + u.slice(BACKEND_URL.length);
    init = { ...init, headers: { ...init.headers, Origin: 'chrome-extension://leethint-accuracy' } };
  }
  const res = await realFetch(u, init);
  if (u.includes('/v1/generate')) { lastCache = res.headers.get('X-LeetHint-Cache') || '?'; lastModel = res.headers.get('X-LeetHint-Model') || 'cache'; }
  return res;
};
const out = s => process.stdout.write(s + '\n');
console.log = (...a) => { if (!String(a[0]).startsWith('LeetHint:')) out(a.join(' ')); };
console.warn = (...a) => out('   ⚠ ' + a.join(' '));

// ── Problems: C++ driver (examples + edge cases), expected TC, words Hint 1 must not use ──
const P = [
  { slug: 'two-sum', tc: ['O(n)'], leak: [/hash/i, /dictionar/i, /\bmap\b/i],
    cpp: `auto N=[](vector<int> v){sort(v.begin(),v.end());return v;};
    {vector<int> a={2,7,11,15}; ex(N(S().twoSum(a,9))==vector<int>{0,1});}
    {vector<int> a={3,2,4}; ex(N(S().twoSum(a,6))==vector<int>{1,2});}
    {vector<int> a={3,3}; ex(N(S().twoSum(a,6))==vector<int>{0,1});}
    {vector<int> a={-3,4,3,90}; edge(N(S().twoSum(a,0))==vector<int>{0,2});}
    {vector<int> a={0,4,3,0}; edge(N(S().twoSum(a,0))==vector<int>{0,3});}` },
  { slug: 'valid-parentheses', lang: 'python3', tc: ['O(n)'], leak: [/\bstack\b/i],
    cpp: `ex(S().isValid("()")==true); ex(S().isValid("()[]{}")==true); ex(S().isValid("(]")==false); ex(S().isValid("([])")==true);
    edge(S().isValid("(")==false); edge(S().isValid("]")==false); edge(S().isValid("([)]")==false); edge(S().isValid("{[]}")==true);`,
    py: `s=Solution(); ex(s.isValid("()")==True); ex(s.isValid("()[]{}")==True); ex(s.isValid("(]")==False); ex(s.isValid("([])")==True)
edge(s.isValid("(")==False); edge(s.isValid("]")==False); edge(s.isValid("([)]")==False)` },
  { slug: 'longest-substring-without-repeating-characters', tc: ['O(n)'], leak: [/sliding window/i, /\bwindow\b/i, /two[- ]pointer/i],
    cpp: `ex(S().lengthOfLongestSubstring("abcabcbb")==3); ex(S().lengthOfLongestSubstring("bbbbb")==1); ex(S().lengthOfLongestSubstring("pwwkew")==3);
    edge(S().lengthOfLongestSubstring("")==0); edge(S().lengthOfLongestSubstring(" ")==1); edge(S().lengthOfLongestSubstring("abba")==2); edge(S().lengthOfLongestSubstring("dvdf")==3);` },
  { slug: '3sum', tc: ['O(n^2)'], leak: [/two[- ]pointer/i],
    cpp: `auto N=[](vector<vector<int>> v){for(auto&x:v)sort(x.begin(),x.end());sort(v.begin(),v.end());return v;};
    {vector<int> a={-1,0,1,2,-1,-4}; ex(N(S().threeSum(a))==N({{-1,-1,2},{-1,0,1}}));}
    {vector<int> a={0,1,1}; ex(S().threeSum(a).empty());}
    {vector<int> a={0,0,0}; ex(N(S().threeSum(a))==N({{0,0,0}}));}
    {vector<int> a={0,0,0,0}; edge(N(S().threeSum(a))==N({{0,0,0}}));}
    {vector<int> a={-2,0,1,1,2}; edge(N(S().threeSum(a))==N({{-2,0,2},{-2,1,1}}));}` },
  { slug: 'coin-change', tc: ['O(n*amount)', 'O(amount*n)', 'O(S*n)', 'O(n*S)', 'O(amount*k)', 'O(k*amount)', 'O(amount*m)', 'O(m*amount)', 'O(n*m)', 'O(m*n)'], leak: [/dynamic programming/i, /\bdp\b/i, /memo/i],
    cpp: `{vector<int> c={1,2,5}; ex(S().coinChange(c,11)==3);} {vector<int> c={2}; ex(S().coinChange(c,3)==-1);} {vector<int> c={1}; ex(S().coinChange(c,0)==0);}
    {vector<int> c={186,419,83,408}; edge(S().coinChange(c,6249)==20);} {vector<int> c={2,5,10,1}; edge(S().coinChange(c,27)==4);} {vector<int> c={3,7}; edge(S().coinChange(c,5)==-1);}` },
  { slug: 'product-of-array-except-self', lang: 'python3', tc: ['O(n)'], leak: [/prefix/i, /suffix/i],
    cpp: `{vector<int> a={1,2,3,4}; ex(S().productExceptSelf(a)==vector<int>{24,12,8,6});}
    {vector<int> a={-1,1,0,-3,3}; ex(S().productExceptSelf(a)==vector<int>{0,0,9,0,0});}
    {vector<int> a={0,0}; edge(S().productExceptSelf(a)==vector<int>{0,0});} {vector<int> a={2,3}; edge(S().productExceptSelf(a)==vector<int>{3,2});}`,
    py: `s=Solution(); ex(s.productExceptSelf([1,2,3,4])==[24,12,8,6]); ex(s.productExceptSelf([-1,1,0,-3,3])==[0,0,9,0,0])
edge(s.productExceptSelf([0,0])==[0,0]); edge(s.productExceptSelf([2,3])==[3,2])` },
  { slug: 'merge-intervals', lang: 'python3', tc: ['O(n log n)'], leak: [/\bsort/i],
    cpp: `{vector<vector<int>> a={{1,3},{2,6},{8,10},{15,18}}; ex(S().merge(a)==vector<vector<int>>{{1,6},{8,10},{15,18}});}
    {vector<vector<int>> a={{1,4},{4,5}}; ex(S().merge(a)==vector<vector<int>>{{1,5}});}
    {vector<vector<int>> a={{4,7},{1,4}}; ex(S().merge(a)==vector<vector<int>>{{1,7}});}
    {vector<vector<int>> a={{1,4},{2,3}}; edge(S().merge(a)==vector<vector<int>>{{1,4}});}
    {vector<vector<int>> a={{5,5}}; edge(S().merge(a)==vector<vector<int>>{{5,5}});}`,
    py: `s=Solution(); ex(s.merge([[1,3],[2,6],[8,10],[15,18]])==[[1,6],[8,10],[15,18]]); ex(s.merge([[1,4],[4,5]])==[[1,5]])
edge(s.merge([[1,4],[2,3]])==[[1,4]]); edge(s.merge([[4,7],[1,4]])==[[1,7]])` },
  { slug: 'lru-cache', design: true, tc: ['O(1)'], leak: [/linked list/i, /hash ?map/i, /\bmap\b/i],
    cpp: `{LRUCache c(2); c.put(1,1); c.put(2,2); ex(c.get(1)==1); c.put(3,3); ex(c.get(2)==-1); c.put(4,4); ex(c.get(1)==-1); ex(c.get(3)==3); ex(c.get(4)==4);}
    {LRUCache c(1); c.put(2,1); edge(c.get(2)==1); c.put(3,2); edge(c.get(2)==-1); edge(c.get(3)==2);}
    {LRUCache c(2); c.put(2,1); c.put(2,2); edge(c.get(2)==2); c.put(1,1); c.put(4,1); edge(c.get(2)==-1);}` },
  { slug: 'trapping-rain-water', tc: ['O(n)'], leak: [/two[- ]pointer/i, /prefix/i, /suffix/i, /monotonic/i, /\bstack\b/i],
    cpp: `{vector<int> a={0,1,0,2,1,0,1,3,2,1,2,1}; ex(S().trap(a)==6);} {vector<int> a={4,2,0,3,2,5}; ex(S().trap(a)==9);}
    {vector<int> a={1,0,2}; edge(S().trap(a)==1);} {vector<int> a={5}; edge(S().trap(a)==0);} {vector<int> a={1,2,3,4}; edge(S().trap(a)==0);} {vector<int> a={5,4,1,2}; edge(S().trap(a)==1);}` },
  { slug: 'median-of-two-sorted-arrays', tc: ['O(log(min(m,n)))', 'O(log(m+n))', 'O(log min(m,n))', 'O(log(min(n,m)))'], leak: [/binary search/i],
    cpp: `auto M=[](vector<int> a, vector<int> b){return S().findMedianSortedArrays(a,b);};
    ex(fabs(M({1,3},{2})-2.0)<1e-9); ex(fabs(M({1,2},{3,4})-2.5)<1e-9);
    edge(fabs(M({},{1})-1.0)<1e-9); edge(fabs(M({2},{})-2.0)<1e-9); edge(fabs(M({1,1},{1,1})-1.0)<1e-9); edge(fabs(M({1,2,3,4,5},{6,7,8})-4.5)<1e-9);` }
];

const dir = new URL('./work/', import.meta.url).pathname;
mkdirSync(`${dir}bits`, { recursive: true });
writeFileSync(`${dir}bits/stdc++.h`, ['algorithm','vector','string','unordered_map','unordered_set','map','set','queue','stack','deque','cmath','climits','numeric','iostream','functional','utility','cstdio','cstring','array','bitset','list','tuple','sstream','iterator','limits','cassert','optional'].map(h => `#include <${h}>`).join('\n'));

function runCpp(slug, code, driver) {
  const src = `#include <bits/stdc++.h>\nusing namespace std;\n${code}\nusing S = Solution;\nint ef=0,et=0,gf=0,gt=0;\nvoid ex(bool b){et++; if(!b) ef++;}\nvoid edge(bool b){gt++; if(!b) gf++;}\nint main(){ ${driver} printf("%d %d %d %d\\n", et-ef, et, gt-gf, gt); return 0; }`;
  // design problems have no "Solution" class
  const fixed = /class\s+Solution\b/.test(code) ? src : src.replace('using S = Solution;', '');
  writeFileSync(`${dir}${slug}.cpp`, fixed);
  try { execFileSync('clang++', ['-std=c++17', '-O1', '-w', '-I', dir, '-o', `${dir}${slug}`, `${dir}${slug}.cpp`], { stdio: 'pipe' }); }
  catch (e) { return { compiled: false, err: String(e.stderr).split('\n').find(l => /error/.test(l)) || 'compile error' }; }
  try {
    const [ep, et, gp, gt] = execFileSync(`${dir}${slug}`, { timeout: 10000 }).toString().trim().split(' ').map(Number);
    return { compiled: true, ep, et, gp, gt };
  } catch (e) { return { compiled: true, crashed: true, err: 'crashed or timed out' }; }
}

function runPy(slug, code, driver) {
  const src = `from typing import *\nimport collections, heapq, math, bisect, itertools\nfrom collections import *\n${code}\nef=et=gf=gt=0\ndef ex(b):\n    global ef,et\n    et+=1\n    ef+=0 if b else 1\ndef edge(b):\n    global gf,gt\n    gt+=1\n    gf+=0 if b else 1\n${driver}\nprint(et-ef, et, gt-gf, gt)\n`;
  writeFileSync(`${dir}${slug}.py`, src);
  try {
    const [ep, et, gp, gt] = execFileSync('python3', ['-I', `${dir}${slug}.py`], { timeout: 10000, stdio: 'pipe' }).toString().trim().split(' ').map(Number);
    return { ran: true, ep, et, gp, gt };
  } catch (e) { return { ran: false, err: String(e.stderr || '').split('\n').filter(Boolean).at(-1) || 'error' }; }
}

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

const rows = [];
for (const spec of P) {
  const p = await fetchProblem(spec.slug);
  out(`\n=== ${p.title} (${p.difficulty})${spec.lang ? ' — in Python' : ''} ===`);
  const t0 = Date.now();
  let h;
  for (let attempt = 1; attempt <= 4 && !h; attempt++) {
    try { h = await generateHints(p, { language: spec.lang || 'cpp' }); }
    catch (e) { out(`   attempt ${attempt} failed: ${e.message}`); if (attempt < 4) await new Promise(r => setTimeout(r, 30000 * attempt)); }
  }
  const secs = (Date.now() - t0) / 1000;
  if (!h) { rows.push({ title: p.title, difficulty: p.difficulty, failed: true }); continue; }

  const code = String(h.hint5 || '').match(/```\w*\n([\s\S]*?)```/)?.[1] || '';
  const hintsOk = ['hint1', 'hint2', 'hint3', 'hint4'].every(k => String(h[k] || '').trim().length > 20);
  const leaked = spec.leak.filter(re => re.test(h.hint1 || '')).map(re => (h.hint1.match(re) || [])[0]);
  const tcOk = spec.tc.some(t => { try { return compareComplexity(h.optimal_tc, t); } catch { return false; } });
  const hint4Cases = (String(h.hint4).match(/→|->|output|returns?|expected/gi) || []).length;
  const cpp = code ? runCpp(spec.slug, code, spec.cpp) : { compiled: false, err: 'no code' };
  const py = spec.lang ? (h.translations?.[spec.lang] ? runPy(spec.slug, h.translations[spec.lang], spec.py) : { ran: false, err: 'no Python code in reply' }) : null;

  const row = { title: p.title, difficulty: p.difficulty, secs, model: lastModel, cache: lastCache, hintsOk, leaked, tc: h.optimal_tc, sc: h.optimal_sc, tcOk, pattern: h.pattern, hint4Cases, cpp, py, hint1: h.hint1 };
  rows.push(row);
  out(`   ${secs.toFixed(1)}s ${lastModel} ${lastCache} | hints ${hintsOk ? 'ok' : 'MISSING'} | TC ${h.optimal_tc} ${tcOk ? '✓' : '✗?'} SC ${h.optimal_sc} | pattern ${h.pattern}`);
  out(`   C++: ${cpp.compiled ? (cpp.crashed ? 'CRASH' : `examples ${cpp.ep}/${cpp.et}, edge ${cpp.gp}/${cpp.gt}`) : 'NO COMPILE: ' + cpp.err}` +
      (py ? ` | Python: ${py.ran ? `examples ${py.ep}/${py.et}, edge ${py.gp}/${py.gt}` : 'FAILED: ' + py.err}` : ''));
  out(`   Hint 1: ${String(h.hint1).replace(/\s+/g, ' ').slice(0, 220)}${leaked.length ? '   ⚠ names: ' + leaked.join(', ') : ''}`);
  writeFileSync(new URL('./results.json', import.meta.url), JSON.stringify(rows, null, 2));
}

// ── Summary ──
const ok = rows.filter(r => !r.failed);
const sum = (f) => ok.reduce((a, r) => a + (f(r) || 0), 0);
out('\n## SUMMARY');
out(`Problems answered: ${ok.length}/${rows.length}`);
out(`All 4 hints present: ${ok.filter(r => r.hintsOk).length}/${ok.length}`);
out(`C++ compiles: ${ok.filter(r => r.cpp.compiled && !r.cpp.crashed).length}/${ok.length}`);
out(`C++ fully correct (all examples + edge): ${ok.filter(r => r.cpp.compiled && !r.cpp.crashed && r.cpp.ep === r.cpp.et && r.cpp.gp === r.cpp.gt).length}/${ok.length}`);
out(`C++ test cases: examples ${sum(r => r.cpp.ep)}/${sum(r => r.cpp.et)}, edge ${sum(r => r.cpp.gp)}/${sum(r => r.cpp.gt)}`);
const pys = ok.filter(r => r.py);
out(`Python (user language): ${pys.filter(r => r.py.ran && r.py.ep === r.py.et && r.py.gp === r.py.gt).length}/${pys.length} fully correct; examples ${pys.reduce((a, r) => a + (r.py.ep || 0), 0)}/${pys.reduce((a, r) => a + (r.py.et || 0), 0)}`);
out(`TC matches the optimal: ${ok.filter(r => r.tcOk).length}/${ok.length} (auto-check; ✗? = check by hand)`);
out(`Hint 1 avoids naming the technique: ${ok.filter(r => !r.leaked.length).length}/${ok.length}`);
out(`Median time: ${[...ok].map(r => r.secs).sort((a, b) => a - b)[ok.length >> 1]?.toFixed(1)}s, max ${Math.max(...ok.map(r => r.secs)).toFixed(1)}s`);
