// shared/patterns.js — "Guess the pattern" (before Hint 1).
// Pure functions: maps the many ways a pattern is written — the hints'
// PATTERN line ("sliding-window technique", "DP on Intervals") and LeetCode's
// topic tags ("Hash Table", "Heap (Priority Queue)") — onto the chips the
// user picks from.

export const PATTERN_CHIPS = ['Two Pointers', 'Sliding Window', 'Hash Map', 'Binary Search', 'DP', 'Graph/BFS/DFS',
                              'Greedy', 'Heap', 'Stack', 'Backtracking', 'Trie', 'Union Find', 'Other'];

// First match wins — so "Binary Search on a Sliding Window" counts as Sliding
// Window only if nothing more specific came first. Order: specific → generic.
const TABLE = [
  ['Sliding Window', /sliding[\s-]*window|\bwindow\b/i],
  ['Two Pointers',   /two[\s-]*pointers?|fast\s*(and|&)\s*slow|tortoise|\bpointers\b|meet in the middle/i],
  ['Union Find',     /union[\s-]*find|disjoint[\s-]*set|\bdsu\b/i],
  ['Trie',           /\btries?\b|prefix tree/i],
  ['Backtracking',   /backtrack/i],
  ['Heap',           /\bheaps?\b|priority[\s-]*queue|top[\s-]*k\b|k[\s-]*way merge/i],
  ['Stack',          /\bstacks?\b|monotonic|parenthes/i],
  ['Binary Search',  /binary[\s-]*search|bisect|lower[\s-]*bound|upper[\s-]*bound/i],
  ['DP',             /dynamic[\s-]*programming|\bdp\b|memoi[sz]|knapsack|kadane|tabulation|longest (common|increasing)/i],
  ['Graph/BFS/DFS',  /\bgraphs?\b|\bbfs\b|\bdfs\b|breadth[\s-]*first|depth[\s-]*first|topolog|dijkstra|bellman|floyd|shortest path|flood fill|\bgrid traversal|minimum spanning|kruskal|prim'?s|tree traversal|\bbinary tree\b|\btree\b/i],
  ['Hash Map',       /hash[\s-]*(map|table|set|ing)?\b|dictionar|frequency (count|map)|counting|\bcounter\b|\bset\b/i],
  ['Greedy',         /greedy|interval scheduling|sweep line/i]
];

// "sliding-window technique" → "Sliding Window"; unknown → null
export function canonicalPattern(text) {
  const t = String(text || '').trim();
  if (!t) return null;
  if (PATTERN_CHIPS.includes(t)) return t;
  for (const [chip, re] of TABLE) if (re.test(t)) return chip;
  return null;
}

// Is the guess right? It matches the hints' pattern OR any of LeetCode's tags.
// "Other" is right when neither names a pattern from the list.
export function matchPattern(guess, { pattern = '', topicTags = [] } = {}) {
  const known = [canonicalPattern(pattern), ...topicTags.map(canonicalPattern)].filter(Boolean);
  if (guess === 'Other') return known.length === 0;
  return known.includes(guess);
}

// patternGuesses: [{ slug, guess, correct, pattern, date }] → accuracy per
// pattern (by the REAL pattern), only patterns with at least `min` guesses
export function patternAccuracy(guesses = [], min = 3) {
  const by = new Map();
  for (const g of guesses) {
    const key = canonicalPattern(g.pattern) || 'Other';
    const e = by.get(key) || { pattern: key, total: 0, correct: 0 };
    e.total++;
    if (g.correct) e.correct++;
    by.set(key, e);
  }
  return [...by.values()].filter(e => e.total >= min)
    .map(e => ({ ...e, pct: Math.round(100 * e.correct / e.total) }))
    .sort((a, b) => a.pct - b.pct || b.total - a.total);
}

// Patterns you recognise less than half the time → worth revising
export const weakPatterns = (guesses, min = 3) => patternAccuracy(guesses, min).filter(e => e.pct < 50);
