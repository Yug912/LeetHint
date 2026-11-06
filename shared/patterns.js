// shared/patterns.js
// Pattern guess (plan 4.1): before Hint 1, the user guesses the technique.
// A guess is correct when it matches the hints' pattern or any of LeetCode's
// topic tags, after both are mapped through one lookup table — so
// "Sliding Window" = "sliding-window technique" and "Hash Table" = "Hash Map".
// Pure logic — no chrome.* — so it can be unit-tested.

// The chips, in the order they're shown
export const PATTERN_CHIPS = [
  'Two Pointers', 'Sliding Window', 'Hash Map', 'Binary Search', 'DP', 'Graph/BFS/DFS',
  'Greedy', 'Heap', 'Stack', 'Backtracking', 'Trie', 'Union Find', 'Other'
];

// chip → words that mean it (checked in order; the first chip that matches wins)
const TABLE = [
  ['Sliding Window', [/sliding[\s-]*window/, /\bwindow\b/]],
  ['Two Pointers', [/two[\s-]*pointers?/, /\bfast\s*(and|&|\/)\s*slow\b/, /\bslow\s*(and|&|\/)\s*fast\b/, /\bpointers?\b/]],
  ['Union Find', [/union[\s-]*find/, /disjoint[\s-]*set/, /\bdsu\b/]],
  ['Trie', [/\btries?\b/, /prefix[\s-]*tree/]],
  ['Backtracking', [/backtrack/, /\bpermutations?\b/, /\bsubsets?\b/, /\bcombinations?\b/]],
  ['Heap', [/\bheaps?\b/, /priority[\s-]*queue/, /\btop[\s-]*k\b/, /k[\s-]*way[\s-]*merge/]],
  ['Stack', [/monotonic/, /\bstacks?\b/]],
  ['Binary Search', [/binary[\s-]*search(?![\s-]*trees?)/, /\bbisect/, /search[\s-]*on[\s-]*(the[\s-]*)?answer/]],
  ['DP', [/dynamic[\s-]*programming/, /\bdp\b/, /memoi[sz]/, /\bknapsack\b/, /tabulation/]],
  ['Graph/BFS/DFS', [/\bgraphs?\b/, /\bbfs\b/, /\bdfs\b/, /breadth[\s-]*first/, /depth[\s-]*first/, /topological/,
                     /shortest[\s-]*path/, /dijkstra/, /\btrees?\b/, /binary[\s-]*tree/, /\bmatrix\b.*\btraversal\b/, /flood[\s-]*fill/]],
  ['Greedy', [/\bgreedy\b/, /\bintervals?\b/]],
  ['Hash Map', [/hash/, /\bmaps?\b/, /dictionar/, /\bcounting\b/, /frequency/, /\bsets?\b/]]
];

// Free text ("Sliding window technique", "hash-table", "Breadth-First Search")
// → a chip name, or null when nothing matches
export function normalizePattern(text) {
  const t = String(text || '').toLowerCase().replace(/[_]+/g, ' ').trim();
  if (!t) return null;
  const exact = PATTERN_CHIPS.find(c => c.toLowerCase() === t);
  if (exact) return exact;
  for (const [chip, words] of TABLE) if (words.some(re => re.test(t))) return chip;
  return null;
}

// Every chip a pattern string names ("Hash Map + Sliding Window" → both)
export function chipsIn(text) {
  return [...new Set(String(text || '').split(/[,/&+;]|\band\b|\bwith\b|\bthen\b/i)
    .map(normalizePattern).concat(normalizePattern(text)).filter(Boolean))];
}

// Is the guess right? pattern: the hints' pattern; topicTags: LeetCode's tags
export function matchPattern(guess, { pattern = '', topicTags = [] } = {}) {
  const g = normalizePattern(guess);
  if (!g) return false;
  const actual = new Set([...chipsIn(pattern), ...(topicTags || []).map(normalizePattern).filter(Boolean)]);
  // "Other" is right only when nothing known applies
  if (g === 'Other') return actual.size === 0;
  return actual.has(g);
}

// The pattern a problem is filed under for the Stats bars
export function primaryPattern({ pattern = '', topicTags = [] } = {}) {
  return chipsIn(pattern)[0] || (topicTags || []).map(normalizePattern).find(Boolean) || 'Other';
}

// patternGuesses: [{ slug, guess, correct, pattern, date }] →
// [{ pattern, total, correct, pct }] for patterns with ≥ minGuesses, weakest first
export function patternAccuracy(guesses = [], { minGuesses = 3 } = {}) {
  const by = new Map();
  for (const g of guesses) {
    if (!g || typeof g.correct !== 'boolean') continue;
    const key = normalizePattern(g.pattern) || 'Other';
    const row = by.get(key) || { pattern: key, total: 0, correct: 0 };
    row.total++;
    if (g.correct) row.correct++;
    by.set(key, row);
  }
  return [...by.values()]
    .filter(r => r.total >= minGuesses)
    .map(r => ({ ...r, pct: Math.round((r.correct / r.total) * 100) }))
    .sort((a, b) => a.pct - b.pct || b.total - a.total);
}

// Patterns recognised less than half the time → worth revising
export const weakPatterns = (guesses, opts) => patternAccuracy(guesses, opts).filter(r => r.pct < 50);
