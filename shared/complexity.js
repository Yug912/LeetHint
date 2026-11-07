// shared/complexity.js — "Will this time out?" A HEURISTIC, shown as one.
//
// From the statement: the largest input-size bound (n <= 10^5,
// 1 <= nums.length <= 2 * 10^4). From the editor code: the deepest nesting of
// for / while loops, sort() as n log n, and a function that calls itself
// twice (without a memo) as possibly exponential. With a budget of ~10^8
// simple operations, too much work → a gentle warning and a target.
// Pure functions — no DOM, no chrome.*.

const BUDGET = 1e8;

// "2 * 10^4" | "10^5" | "1e5" | "10⁵" | "100000" | "5 x 10^4" → number
export function parseBound(expr) {
  const s = String(expr || '').replace(/[,_\s]/g, '').replace(/⁰|¹|²|³|⁴|⁵|⁶|⁷|⁸|⁹/g, d => '^' + '⁰¹²³⁴⁵⁶⁷⁸⁹'.indexOf(d))
    .replace(/\^\^/g, '^').replace(/(\^\d)\^(\d)/g, '$1$2');
  const m = s.match(/^(?:(\d+(?:\.\d+)?)[*x×·])?(\d+(?:\.\d+)?)(?:\^(\d+)|e(\d+))?$/i);
  if (!m) return NaN;
  const coef = m[1] ? Number(m[1]) : 1;
  const base = Number(m[2]);
  const exp = m[3] ?? m[4];
  return coef * (exp !== undefined ? (m[4] !== undefined ? base * 10 ** Number(exp) : base ** Number(exp)) : base);
}

// A constraint about SIZE (how many items), not about values
const SIZE_HINT = /\.length|\.size\(?\)?|\blen\(|\bn\b|\bm\b|\bk\b|number of|count|size|nodes|edges|rows|cols|columns|queries|words|points|intervals/i;

// → { bound, text } for the largest size bound, or null
export function maxConstraint(statement) {
  let best = null;
  const lines = String(statement || '').split(/\n|;/);
  for (const line of lines) {
    for (const m of line.matchAll(/([^<≤=\n]{0,60}?)\s*(?:<=|≤|<)\s*([\d.\s*x×·^⁰¹²³⁴⁵⁶⁷⁸⁹e]+?)(?=\s*(?:$|,|\.\s|\)|[a-z]))/gi)) {
      const left = m[1];
      if (!SIZE_HINT.test(left) || /\[[^\]]*\]\s*$/.test(left.trim()) && !/\.length|size/i.test(left)) continue;
      const bound = parseBound(m[2]);
      if (!Number.isFinite(bound) || bound < 2) continue;
      if (!best || bound > best.bound) best = { bound, text: m[2].trim().replace(/\s+/g, ' ') };
    }
  }
  return best;
}

// Comments and string literals out, so "for" inside them doesn't count
function stripNoise(code, lang) {
  let c = String(code || '');
  if (lang === 'python3' || lang === 'python') {
    c = c.replace(/("""|''')[\s\S]*?\1/g, '""').replace(/#.*$/gm, '');
  } else {
    c = c.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/.*$/gm, '');
  }
  return c.replace(/"(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'|`(?:\\.|[^`\\])*`/g, '""');
}

// Deepest loop nesting — brace languages (C++, Java, JavaScript, ...)
function braceLoopDepth(code) {
  const loopRe = /\b(for|while)\s*\(|\.forEach\s*\(|\bdo\s*\{/y;
  const stack = [];   // 'loop' | 'block' for each open {, plus pending single-statement loops
  let pendingLoops = 0, singleLoops = [], max = 0;
  const depth = () => stack.filter(x => x === 'loop').length + singleLoops.length;
  for (let i = 0; i < code.length; i++) {
    loopRe.lastIndex = i;
    const m = loopRe.exec(code);
    if (m && (i === 0 || /\W/.test(code[i - 1]) || code[i] === '.')) {
      if (m[0].startsWith('do')) { stack.push('loop'); max = Math.max(max, depth()); i += m[0].length - 1; continue; }
      // skip the (...) header
      let j = i + m[0].length, p = 1;
      for (; j < code.length && p > 0; j++) { if (code[j] === '(') p++; else if (code[j] === ')') p--; }
      if (m[0].startsWith('.forEach')) {          // arr.forEach(x => { ... }) — the body is inside the parens
        stack.push('loop'); max = Math.max(max, depth()); stack.pop();
        const inner = braceLoopDepth(code.slice(i + m[0].length, j - 1));
        max = Math.max(max, depth() + 1 + inner);
        i = j - 1; continue;
      }
      let k = j; while (k < code.length && /\s/.test(code[k])) k++;
      if (code[k] === '{') { pendingLoops++; i = k - 1; }
      else if (code[k] === ';') { i = k; }        // while (x--); — empty body
      else { singleLoops.push(stack.length); max = Math.max(max, depth()); i = k - 1; }
      continue;
    }
    const c = code[i];
    if (c === '{') {
      if (pendingLoops) { pendingLoops--; stack.push('loop'); max = Math.max(max, depth()); }
      else stack.push('block');
    } else if (c === '}') {
      stack.pop();
      while (singleLoops.length && singleLoops.at(-1) > stack.length) singleLoops.pop();
      while (singleLoops.length && singleLoops.at(-1) === stack.length && code.slice(i + 1).match(/^\s*(else|$)/) === null) singleLoops.pop();
    } else if (c === ';' && singleLoops.length && singleLoops.at(-1) === stack.length) {
      singleLoops.pop();
      while (singleLoops.length && singleLoops.at(-1) === stack.length) singleLoops.pop();
    }
  }
  return max;
}

// Deepest loop nesting — Python, by indentation (comprehensions count too)
function pythonLoopDepth(code) {
  const open = [];   // indents of enclosing loops
  let max = 0;
  for (const raw of code.split('\n')) {
    if (!raw.trim()) continue;
    const indent = raw.match(/^\s*/)[0].replace(/\t/g, '    ').length;
    while (open.length && open.at(-1) >= indent) open.pop();
    const line = raw.trim();
    const inline = (line.match(/\bfor\b[^:]*?\bin\b/g) || []).length - (/^(for|async for)\b/.test(line) ? 1 : 0);
    const isLoop = /^(for|while|async\s+for)\b.*:\s*$/.test(line) || /^(for|while)\b.*:\s*\S/.test(line);
    const here = open.length + (isLoop ? 1 : 0) + Math.max(0, inline);
    max = Math.max(max, here);
    if (isLoop && /:\s*$/.test(line)) open.push(indent);
  }
  return max;
}

export function loopDepth(code, lang = 'cpp') {
  const c = stripNoise(code, lang);
  return lang === 'python3' || lang === 'python' ? pythonLoopDepth(c) : braceLoopDepth(c);
}

// A function that calls itself at least twice, with no memo in sight
export function exponentialRecursion(code, lang = 'cpp') {
  const c = stripNoise(code, lang);
  if (/memo|\bdp\b|\bcache\b|lru_cache|@cache|unordered_map|HashMap|new Map\(/i.test(c)) return false;
  const names = lang === 'python3' || lang === 'python'
    ? [...c.matchAll(/\bdef\s+(\w+)\s*\(/g)].map(m => m[1])
    : [...c.matchAll(/(?:^|[\s*&>])(\w+)\s*\([^;{)]*\)\s*(?:const\s*)?\{/gm)].map(m => m[1])
        .filter(n => !['if', 'for', 'while', 'switch', 'catch', 'function'].includes(n));
  return names.some(n => (c.match(new RegExp(`\\b${n}\\s*\\(`, 'g')) || []).length >= 3);   // definition + 2 calls
}

export const usesSort = (code, lang) => /\bsort\s*\(|\bsorted\s*\(|\.sort\s*\(|Arrays\.sort|Collections\.sort/.test(stripNoise(code, lang));

const SUP = { 2: '²', 3: '³', 4: '⁴' };
// → { label: 'O(n²)', ops(n) } for the code's rough cost
export function estimateCost(code, lang = 'cpp') {
  if (exponentialRecursion(code, lang)) return { label: 'O(2ⁿ)', exponential: true, ops: n => n > 60 ? Infinity : 2 ** n };
  const d = loopDepth(code, lang);
  const sorted = usesSort(code, lang);
  if (d >= 2) return { label: `O(n${SUP[d] || '^' + d})`, power: d, ops: n => n ** d };
  if (sorted) return { label: 'O(n log n)', power: 1, log: true, ops: n => n * Math.log2(Math.max(2, n)) };
  if (d === 1) return { label: 'O(n)', power: 1, ops: n => n };
  return { label: 'O(1)', power: 0, ops: () => 1 };
}

// What fits in ~10^8 operations for a given n
export function targetFor(n) {
  if (n <= 12) return 'O(n!) or O(2ⁿ)';
  if (n <= 25) return 'O(2ⁿ)';
  if (n <= 500) return 'O(n³)';
  if (n <= 5000) return 'O(n²)';
  if (n <= 1e6) return 'O(n log n)';
  return 'O(n) or O(log n)';
}

// "100000" → "10^5", "20000" → "2 × 10^4"
export function prettyBound(n) {
  if (n < 1000) return String(n);
  const exp = Math.floor(Math.log10(n));
  const coef = n / 10 ** exp;
  return Number.isInteger(coef) ? (coef === 1 ? `10^${exp}` : `${coef} × 10^${exp}`) : String(n);
}

// → { message, label, bound, target } when the code looks too slow, else null
export function tleWarning(statement, code, lang = 'cpp') {
  if (!String(code || '').trim()) return null;
  const c = maxConstraint(statement);
  if (!c) return null;
  const cost = estimateCost(code, lang);
  if (cost.ops(c.bound) <= BUDGET) return null;
  const target = targetFor(c.bound);
  const what = cost.exponential ? 'Your recursion calls itself twice with no memo, which looks like O(2ⁿ)'
             : cost.power >= 2 ? `Your nested loops look like ${cost.label}` : `Your code looks like ${cost.label}`;
  return {
    label: cost.label, bound: c.bound, target,
    message: `${what}. With n up to ${prettyBound(c.bound)} this may time out; aim for about ${target}.`
  };
}
