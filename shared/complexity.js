// shared/complexity.js
// TLE warning (plan 4.4) — a HEURISTIC, never a verdict:
//   1. the largest input size in the statement's constraints (n <= 10^5,
//      1 <= nums.length <= 2 * 10^4 …)
//   2. a rough shape of the user's code: deepest for/while nesting, sort(),
//      a recursive function that calls itself twice with no memo
//   3. ~10^8 simple operations fit in LeetCode's time limit.
// Pure logic — no chrome.* — so it can be unit-tested.

export const OPS_BUDGET = 1e8;

// ── 1. Constraints ──────────────────────────────────────────

// "10^5", "2 * 10^4", "10⁵", "100000", "1e5", "10**5" → number
export function parseNumber(text) {
  let t = String(text || '').trim()
    .replace(/[⁰¹²³⁴⁵⁶⁷⁸⁹]+/g, sup => '^' + [...sup].map(c => '⁰¹²³⁴⁵⁶⁷⁸⁹'.indexOf(c)).join(''))
    .replace(/\*\*/g, '^').replace(/,(?=\d{3}\b)/g, '').replace(/\s+/g, '');
  let m = t.match(/^(\d+(?:\.\d+)?)[*x×·]10\^(\d+)$/i);
  if (m) return Number(m[1]) * 10 ** Number(m[2]);
  m = t.match(/^10\^(\d+)$/);
  if (m) return 10 ** Number(m[1]);
  m = t.match(/^(\d+(?:\.\d+)?)e(\d+)$/i);
  if (m) return Number(m[1]) * 10 ** Number(m[2]);
  m = t.match(/^\d+$/);
  return m ? Number(t) : NaN;
}

const NUMBER_RE = String.raw`(\d+(?:\.\d+)?\s*[*x×·]\s*10\s*(?:\^|\*\*)\s*\d+|10\s*(?:\^|\*\*)\s*\d+|10[⁰¹²³⁴⁵⁶⁷⁸⁹]+|\d+(?:\.\d+)?e\d+|\d{1,3}(?:,\d{3})+|\d+)`;
// What a size looks like: n, m, nums.length, s.length, grid[i].length, the number of nodes …
const SIZE_SUBJECT = /(\.length|\.size\(\)|\blen\(|\bn\b|\bm\b|\bnumber of\b|\bsize\b|\bcount\b)/i;
const VALUE_SUBJECT = /\[\s*\w+\s*\]\s*$|\bval\b|\bvalue|\btarget\b|\bk\b(?!\s*\.)/i;

// The largest input size in the statement, or 0 if none is found.
// Element VALUES (-10^9 <= nums[i] <= 10^9, target) are not sizes and are ignored.
export function parseMaxBound(statement) {
  const text = String(statement || '').replace(/≤|&lt;=|=</g, '<=').replace(/&lt;/g, '<');
  let best = 0;
  const re = new RegExp(String.raw`([^\n<]{1,60}?)\s*<=?\s*${NUMBER_RE}(?![\d^])`, 'g');
  for (const m of text.matchAll(re)) {
    // The subject is what's just left of "<=": "1 <= nums.length" → "nums.length"
    const subject = m[1].split(/<=?|,|;|\band\b/).pop().trim();
    if (!SIZE_SUBJECT.test(subject) || VALUE_SUBJECT.test(subject)) continue;
    const n = parseNumber(m[2]);
    if (Number.isFinite(n) && n > best) best = n;
  }
  // "The number of nodes in the tree is in the range [0, 10^4]."
  const range = new RegExp(String.raw`(number of|length of|size of)[^\n\[]{0,60}range\s*\[\s*-?\d+\s*,\s*${NUMBER_RE}\s*\]`, 'gi');
  for (const m of text.matchAll(range)) {
    const n = parseNumber(m[2]);
    if (Number.isFinite(n) && n > best) best = n;
  }
  return best;
}

// ── 2. Code shape ───────────────────────────────────────────

// Strings and comments out, so "for" inside them doesn't count
function stripCode(code, language) {
  let s = String(code || '');
  if (language === 'python' || language === 'python3') {
    return s.replace(/("""|''')[\s\S]*?\1/g, '""').replace(/(["'])(?:\\.|(?!\1).)*\1/g, '""').replace(/#.*$/gm, '');
  }
  return s.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/.*$/gm, '')
          .replace(/`(?:\\.|[^`])*`/g, '""').replace(/(["'])(?:\\.|(?!\1).)*\1/g, '""');
}

function matchingParen(s, open) {
  let depth = 0;
  for (let i = open; i < s.length; i++) {
    if (s[i] === '(') depth++;
    else if (s[i] === ')' && --depth === 0) return i;
  }
  return -1;
}

// C++, Java, JavaScript, TypeScript, C#, Go, Kotlin, Swift, Rust, C
function braceLoopDepth(s) {
  const stack = [];     // loop count each open block adds
  let pending = 0;      // loops whose body hasn't started yet: for (...) for (...) x++;
  let max = 0;
  const inStack = () => stack.reduce((a, b) => a + b, 0);
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    const word = /[A-Za-z_]/.test(c) && (i === 0 || !/[\w$.]/.test(s[i - 1])) ? s.slice(i).match(/^[A-Za-z_]\w*/)[0] : '';
    if (word === 'for' || word === 'while' || word === 'do' || word === 'loop') {
      let j = i + word.length;
      while (/\s/.test(s[j] || '')) j++;
      if (word === 'while' && s[j] === '(') {
        const close = matchingParen(s, j);
        let k = close + 1;
        while (/\s/.test(s[k] || '')) k++;
        if (s[k] === ';') { i = close; continue; }   // the tail of do { } while (…);
      }
      pending++;
      max = Math.max(max, inStack() + pending);
      if (s[j] === '(') { i = matchingParen(s, j); if (i < 0) break; }
      else i = j - 1;
      continue;
    }
    if (word) { i += word.length - 1; continue; }
    if (c === '{') { stack.push(pending); pending = 0; }
    else if (c === '}') stack.pop();
    else if (c === ';') pending = 0;
  }
  return max;
}

function pythonLoopDepth(s) {
  const stack = [];   // { indent, loop }
  let max = 0;
  for (const raw of s.split('\n')) {
    if (!raw.trim()) continue;
    const indent = raw.match(/^\s*/)[0].replace(/\t/g, '    ').length;
    while (stack.length && stack.at(-1).indent >= indent) stack.pop();
    const line = raw.trim();
    const loops = stack.filter(b => b.loop).length;
    const isLoop = /^(async\s+)?(for|while)\b/.test(line);
    // Comprehensions: [x for x in a for y in b] adds a loop per "for"
    const inline = (line.replace(/^(async\s+)?(for|while)\b/, '').match(/\bfor\b/g) || []).length;
    max = Math.max(max, loops + (isLoop ? 1 : 0) + inline);
    if (line.endsWith(':')) stack.push({ indent, loop: isLoop });
  }
  return max;
}

// Function name → its body text
function functionBodies(s, language) {
  const out = [];
  if (language === 'python' || language === 'python3') {
    const lines = s.split('\n');
    lines.forEach((l, i) => {
      const m = l.match(/^(\s*)def\s+(\w+)\s*\(/);
      if (!m) return;
      const indent = m[1].length;
      const body = [];
      for (let j = i + 1; j < lines.length; j++) {
        if (lines[j].trim() && lines[j].match(/^\s*/)[0].length <= indent) break;
        body.push(lines[j]);
      }
      out.push({ name: m[2], body: body.join('\n') });
    });
    return out;
  }
  // name(...) { … } — methods, functions, and const name = (...) => { … }
  const re = /\b(\w+)\s*(?:=\s*(?:function\s*)?)?\(([^()]*)\)\s*(?:const\s*)?(?:->\s*[\w<>:,\s*&]+)?(?::\s*[\w<>[\],\s|]+)?\s*(?:=>\s*)?\{/g;
  const KEYWORDS = new Set(['if', 'for', 'while', 'switch', 'catch', 'return', 'function', 'else', 'do']);
  for (const m of s.matchAll(re)) {
    if (KEYWORDS.has(m[1])) continue;
    const open = m.index + m[0].length - 1;
    let depth = 0, end = -1;
    for (let i = open; i < s.length; i++) {
      if (s[i] === '{') depth++;
      else if (s[i] === '}' && --depth === 0) { end = i; break; }
    }
    if (end > 0) out.push({ name: m[1], body: s.slice(open + 1, end) });
  }
  return out;
}

const MEMO = /\bmemo|\bdp\s*\[|\bcache|lru_cache|@cache\b|\bvisited\b|\bseen\b|unordered_map|HashMap|\bMap\(|dict\(/i;

// → { loopDepth, sorts, exponential }
export function analyzeCode(code, language = 'cpp') {
  const lang = String(language || 'cpp').toLowerCase();
  const python = lang === 'python' || lang === 'python3';
  const s = stripCode(code, lang);
  const loopDepth = python ? pythonLoopDepth(s) : braceLoopDepth(s);
  const sorts = /\bsort\s*\(|\.sort\s*\(|\bsorted\s*\(|Arrays\.sort|Collections\.sort|\.sorted\s*\(/.test(s);
  const exponential = functionBodies(s, lang).some(({ name, body }) => {
    const calls = (body.match(new RegExp(String.raw`(?<![\w.])(?:self\.|this\.)?${name}\s*\(`, 'g')) || []).length;
    return calls >= 2 && !MEMO.test(body);
  });
  return { loopDepth, sorts, exponential };
}

// ── 3. Estimate + message ───────────────────────────────────

const CLASSES = [
  { label: 'O(2ⁿ)', ops: n => (n > 60 ? Infinity : 2 ** n) },
  { label: 'O(n³)', ops: n => n ** 3 },
  { label: 'O(n²)', ops: n => n ** 2 },
  { label: 'O(n log n)', ops: n => n * Math.log2(Math.max(2, n)) },
  { label: 'O(n)', ops: n => n }
];

const pow10 = n => {
  const e = Math.floor(Math.log10(n));
  const lead = Math.round(n / 10 ** e * 10) / 10;
  return lead === 1 ? `10^${e}` : `${lead} * 10^${e}`;
};

// The code's rough class: exponential beats loops; depth 1 + sort = n log n
export function codeClass({ loopDepth, sorts, exponential }) {
  if (exponential) return { label: 'O(2ⁿ)', ops: n => (n > 60 ? Infinity : 2 ** n), why: 'Your recursion calls itself twice with no memo' };
  if (loopDepth >= 2) {
    const ops = n => n ** loopDepth;
    const label = loopDepth === 2 ? 'O(n²)' : loopDepth === 3 ? 'O(n³)' : `O(n^${loopDepth})`;
    return { label, ops, why: 'Your nested loops' };
  }
  if (sorts) return { label: 'O(n log n)', ops: n => n * Math.log2(Math.max(2, n)), why: 'Sorting' };
  return { label: 'O(n)', ops: n => n, why: '' };
}

// → null (looks fine / not enough to go on) or
//   { message, label, target, n }
export function tleWarning(code, language, statement, { budget = OPS_BUDGET } = {}) {
  const n = parseMaxBound(statement);
  if (!n || !String(code || '').trim()) return null;
  const shape = codeClass(analyzeCode(code, language));
  if (!shape.why || shape.ops(n) <= budget) return null;
  const target = CLASSES.find(c => c.ops(n) <= budget && c.ops(n) < shape.ops(n))?.label || 'O(n)';
  const look = shape.why === 'Your recursion calls itself twice with no memo'
    ? `${shape.why} — that looks like ${shape.label}.`
    : `${shape.why} look like ${shape.label}.`;
  return {
    n, label: shape.label, target,
    message: `${look} With n up to ${pow10(n)} this may time out; aim for about ${target}.`
  };
}
