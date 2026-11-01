// shared/prompts.js
// Every prompt LeetHint sends to an AI model — imported by BOTH the backend
// (backend/src/index.js builds prompts server-side, so the server can never be
// used as a generic AI proxy) and the extension (api/ai.js uses
// buildHintsPrompt for the offline Chrome Built-in AI fallback).
// Pure functions only: no chrome.*, no fetch, no secrets.

// Bump when prompts change — part of the server cache key, so old cached
// replies are never served for a new prompt
export const PROMPT_VERSION = 'p5';

// Languages the solution can be translated into, keyed by LeetCode's langSlug.
// fence = the markdown code-fence tag the model is asked to use.
export const LANGUAGES = {
  cpp:        { name: 'C++',        fence: 'cpp' },
  java:       { name: 'Java',       fence: 'java' },
  python3:    { name: 'Python',     fence: 'python' },
  c:          { name: 'C',          fence: 'c' },
  javascript: { name: 'JavaScript', fence: 'javascript' },
  typescript: { name: 'TypeScript', fence: 'typescript' },
  csharp:     { name: 'C#',         fence: 'csharp' },
  golang:     { name: 'Go',         fence: 'go' },
  kotlin:     { name: 'Kotlin',     fence: 'kotlin' },
  swift:      { name: 'Swift',      fence: 'swift' },
  rust:       { name: 'Rust',       fence: 'rust' }
};


// ─────────────────────────────────────────────
// 1. PROBLEM CONTEXT — everything the model needs, nothing truncated
//    Constraints sit at the END of the statement, and they are what
//    decides the intended complexity — never slice the description.
// ─────────────────────────────────────────────

export function buildProblemContext(problem) {
  const { title, problemNumber, difficulty, description, topicTags, officialHints, cppSnippet } = problem;
  const parts = [
    `PROBLEM: ${problemNumber ? `#${problemNumber} ` : ''}"${title}" (${difficulty || 'Unknown'})`,
    '',
    'FULL STATEMENT (examples + constraints included; "10^5" means ten to the fifth):',
    description || '(statement unavailable — rely on your knowledge of this exact LeetCode problem)'
  ];
  if (cppSnippet) {
    parts.push('', 'EXACT LEETCODE C++ SIGNATURE (use this verbatim):', '```cpp', cppSnippet.trim(), '```');
  }
  if (topicTags?.length) {
    parts.push('', `LEETCODE TOPIC TAGS: ${topicTags.join(', ')}`);
  }
  if (officialHints?.length) {
    parts.push('', 'OFFICIAL LEETCODE HINTS (they point at the intended approach — follow them):',
               ...officialHints.map((h, i) => `${i + 1}. ${h}`));
  }
  return parts.join('\n');
}

// Function/method names LeetCode's starter code defines, in any language:
// twoSum (Java/C++/Python/Go/Swift/Kotlin/C/TS), two_sum (Rust), TwoSum (C#),
// `var twoSum = function` (JS), __init__/get/put (design problems).
// Comments are dropped first — they hold ListNode definitions and notes like "free()".
const NOT_A_NAME = new Set(['if', 'for', 'while', 'switch', 'return', 'sizeof', 'function', 'catch', 'new', 'super', 'this']);

export function snippetNames(snippet) {
  const code = String(snippet || '')
    .replace(/\/\*[\s\S]*?\*\//g, '')       // /* ... */ and /** ... */
    .replace(/(^|\s)(\/\/|#).*$/gm, '$1');  // // ... and # ... line comments
  const names = new Set();
  for (const [, n] of code.matchAll(/([A-Za-z_]\w*)\s*(?:<[^>()]*>)?\s*\(/g)) if (!NOT_A_NAME.has(n)) names.add(n);
  for (const [, n] of code.matchAll(/(?:var|let|const)\s+(\w+)\s*=\s*function/g)) names.add(n);
  return [...names];
}

// "Keep these exact names: twoSum" — LeetCode calls the function by name, so a
// renamed one (two_sum, TwoSum) fails even when the logic is right
function keepNamesLine(snippet) {
  const names = snippetNames(snippet);
  return names.length ? `Keep these exact names (LeetCode calls them): ${names.join(', ')}` : '';
}

// Design problems ("Implement LRUCache") use their own class name, not Solution
function classNameOf(problem) {
  return (problem.cppSnippet || '').match(/class\s+(\w+)/)?.[1] || 'Solution';
}


// ─────────────────────────────────────────────
// 2. SOLUTION PROMPT
// ─────────────────────────────────────────────

// TC/SC must describe THIS implementation — not a different algorithm's optimum.
// Space in particular depends on implementation details (recursion vs iteration,
// in-place vs copy, map vs array), so it is derived item by item from the code.
const COMPLEXITY_RULES = `Analyse the complexity of the EXACT code you wrote (not of some other approach):
   - TC: tight worst-case bound for this code.
   - SC: auxiliary space of THIS implementation. Go through the code and list every item that uses memory:
       • every container / array / string you allocate, with its maximum size
       • recursion call-stack depth (worst case: a skewed tree is O(n) deep, a balanced one O(log n))
       • BFS queue / heap / stack maximum size
       • sort(): C++ introsort uses O(log n) stack
     SC is the largest of these. Do NOT count the input or the returned output (LeetCode convention).
     Modifying the input in place counts as O(1). If nothing grows with the input, SC is O(1).
   - Use standard single-letter variables: n = main input size (array/string length, node count),
     m × n = grid rows × cols, V/E = graph vertices/edges, k = the problem's k parameter,
     h = tree height (only for recursion/stack depth on trees). Simplest form only (no constants, no "where ..." text).`;

const COMPLEXITY_FORMAT = `---TC---
O(...)
---SC---
O(...)
---SC_BREAKDOWN---
one line per item that uses memory in the code, e.g.
- unordered_map<int,int> seen: up to n entries → O(n)
- recursion depth: none
- not counted: input, returned vector`;

// withHints: also write Hints 1-4 in the SAME reply (one API call instead of two).
// The hints come BEFORE the code in the reply so they can be streamed to the
// user first; the model still solves everything in its reasoning beforehand,
// so the hints describe the exact code that follows them.
// alsoLanguage: also write the same solution in the user's language (e.g.
// 'python3') in the same reply, so it arrives without a second request.
export function buildSolutionPrompt(problem, { withHints = false, alsoLanguage = '', alsoSnippet = '' } = {}) {
  const extraLang = alsoLanguage && alsoLanguage !== 'cpp' && LANGUAGES[alsoLanguage];
  const extraStep = extraLang ? `
7. Also write the SAME solution in ${extraLang.name} (same algorithm, same complexity), idiomatic, using
   LeetCode's exact ${extraLang.name} signature${alsoSnippet ? ` below:
\`\`\`${extraLang.fence}
${alsoSnippet.trim()}
\`\`\`` : '.'}
   Keep 64-bit integers where the C++ uses long long. No main(), no I/O.` : '';
  const extraFormat = extraLang
    ? `\n---${codeTag(alsoLanguage)}---\n\`\`\`${extraLang.fence}\n...\n\`\`\`` : '';
  const hintsStep = withHints ? `

Finish steps 1-6 in your reasoning FIRST. Then, for a learner who has NOT seen your code, write hints that
lead to YOUR solution's exact approach (any complexity mentioned must match your TC/SC; get example numbers
by tracing your code, never guess). In the reply the hints come before the code, but they must describe
exactly the code you then output:

${HINT_RULES}` : '';
  const hintsFormat = withHints ? '\n---HINT1---\n...\n---HINT2---\n...\n---HINT3---\n...\n---HINT4---\n...' : '';
  const cls = classNameOf(problem);

  return `You are a world-class competitive programmer. Your C++ solution WILL be submitted to LeetCode and MUST pass every test case, including the largest inputs allowed by the constraints.

${buildProblemContext(problem)}

PROCESS (do this in your reasoning before answering):
1. Read the constraints and derive the complexity budget (≈10^8 simple ops per second).
2. Choose the optimal, well-known algorithm for THIS exact problem. No brute force if it would TLE.
3. Write the COMPLETE code using the EXACT signature above (class ${cls} { ... }) so it can be pasted into LeetCode and submitted as-is:
   - Keep the class name, method names, parameter types and return type EXACTLY as in the signature.
   - No #include, no std::, no main(), no I/O.
   - Do NOT define ListNode / TreeNode / Node etc. — LeetCode already provides them (they appear only as comments in the signature).
   - Put any helper functions or structs INSIDE class Solution. No placeholders, no "..." — every line must be real code.
4. Trace the code BY HAND on every example in the statement and confirm it prints the expected output. If any example fails, fix the code and trace again.
5. Check edge cases: minimum sizes, duplicates, negatives, all-equal values, overflow (use long long), empty results.
6. ${COMPLEXITY_RULES}${extraStep}${hintsStep}

Respond ONLY in this exact format:
---APPROACH---
2-4 sentences: the key insight, the algorithm, and why it is correct.
${COMPLEXITY_FORMAT}
---PATTERN---
short pattern name (e.g. "Sliding Window", "Monotonic Stack", "DP on Intervals")${hintsFormat}
---CODE---
\`\`\`cpp
class ${cls} {
...
};
\`\`\`${extraFormat}
---END---`.trim();
}

// Section tag for a translated solution: python3 → CODE_PYTHON3
export const codeTag = language => `CODE_${language.toUpperCase()}`;


// ─────────────────────────────────────────────
// 3. HINT RULES + hints-only fallback prompt
// ─────────────────────────────────────────────

const HINT_RULES = `Generate EXACTLY 4 progressive hints. Follow these rules STRICTLY:

HINT 1 — Pattern Recognition (MAX 2 sentences, NO algorithm name):
- Ask ONE pointed question about the constraint or property that reveals the approach
- Follow with a nudge toward the key insight (e.g. a space-vs-time trade-off)
- Quote the real constraint values from the statement (e.g. "n ≤ 10^5"), never invent them

HINT 2 — Concrete Technique (SHORT, name the data structure NOW):
- Name the exact data structure/algorithm in 1 sentence
- Show ONE step of the walkthrough with an ACTUAL example from the statement
- Keep total hint under 4 lines

HINT 3 — Algorithm Skeleton (pseudocode only, happy path):
- Write the core algorithm as clean LANGUAGE-NEUTRAL pseudocode (4-8 lines max)
- NEVER real C++: no "class Solution", no types, no semicolons — the code belongs only in the CODE section
- No edge cases yet — just the main logic
- Use indentation to show structure clearly

HINT 4 — Edge Cases & Gotchas (specific to THIS problem):
- Give 3-5 edge cases that are VALID under the constraints and actually break naive or buggy solutions.
- Pick only the categories that apply here: smallest input (n = 1, or empty only if allowed), largest values
  (sums/products past 2^31 - 1 → overflow), duplicates, negatives / zeros, all elements equal,
  already sorted / reverse sorted, no valid answer / multiple valid answers, ties, disconnected or cyclic
  graphs, skewed (linked-list-shaped) trees, boundary indices (first / last element).
- Skip anything the constraints rule out — never suggest an empty array if n ≥ 1.
- Format EVERY case exactly like this, with a blank line between cases:
  **<Short name>** — <one plain sentence: what makes this input different>
  \`Input: <LeetCode input syntax>\` → \`Expected: <exact output>\`
  ⚠️ Bug: <one CONCRETE wrong implementation choice> → returns <the exact wrong output on this input>
- Expected outputs must be EXACT: derive each one by tracing the solution on that input, never by guessing.
- Every ⚠️ line must describe a REAL failure you can demonstrate, not a vague risk:
  • name the specific wrong choice (e.g. "using < instead of <= in the partition check",
    "returning (a + b) / 2 with int division", "initialising maxLeft to 0 instead of INT_MIN")
  • state the exact wrong output that choice produces on THIS input — trace the buggy version to get it
  • if you cannot name a concrete wrong output, DROP the case and pick another category
- Never claim the solution itself fails on a case it handles. The ⚠️ line is about a buggy alternative.
- Overflow: only include it if you computed that an intermediate value really exceeds 2^31 - 1 under
  the given constraints (show the arithmetic, e.g. "10^5 × 10^9 = 10^14"). Values ≤ 10^6 that are only
  compared or added in pairs do NOT overflow — skip the case.
- Banned words in Hint 4: "may", "might", "could", "likely", "potentially", "gracefully".
- Plain, direct wording. Short sentences. No filler like "Make sure to" or "Don't forget".

RULES:
- Use ACTUAL numbers/examples from the problem statement, not generic ones
- Be concise — no fluff, no "Great question!", no generic advice
- Hints 1 and 2 must be SHORT (2-4 lines max each)
- If you are not certain a specific number is right, re-derive it; never state an unchecked value`;

// Hints-only prompt — used only by the no-server fallback (Chrome Built-in AI)
export function buildHintsPrompt(problem) {
  return `You are an expert DSA mentor helping a competitive programmer learn problem-solving.

${buildProblemContext(problem)}

${HINT_RULES}

Respond ONLY in this exact delimiter format:
---HINT1---
...
---HINT2---
...
---HINT3---
...
---HINT4---
...
---TC---
O(...)
---SC---
O(...)
---PATTERN---
short pattern name
---END---`.trim();
}


// ─────────────────────────────────────────────
// 4. FIX PROMPT — "🔧 Fix" button: debug the given code
// ─────────────────────────────────────────────

export function buildFixPrompt(code, problem) {
  return `You are an expert LeetCode C++ debugger.

${buildProblemContext(problem)}

CODE TO VALIDATE AND FIX:
\`\`\`cpp
${code}
\`\`\`

PROCESS (in your reasoning):
1. Check the signature matches the EXACT LeetCode signature (if given above).
2. Trace the code by hand on every example in the statement; compare with the expected outputs.
3. Check the complexity fits the constraints; if it would TLE, replace it with the optimal algorithm.
4. Fix compilation errors, off-by-one, i/j confusion, overflow (long long), and missed edge cases.
5. ${COMPLEXITY_RULES}

Respond ONLY in this exact format (code: no #include, no std::, no main()):
${COMPLEXITY_FORMAT}
---CODE---
\`\`\`cpp
class ${classNameOf(problem)} {
...
};
\`\`\`
---END---`.trim();
}


// ─────────────────────────────────────────────
// 5. TRANSLATE PROMPT — the verified C++ solution in another language
//    Translating keeps the SAME algorithm (and TC/SC), which is far more
//    reliable than solving again from scratch in every language.
// ─────────────────────────────────────────────

export function buildTranslatePrompt(code, problem, language, snippet) {
  const { name, fence } = LANGUAGES[language];
  return `You are an expert competitive programmer fluent in C++ and ${name}.

${buildProblemContext({ ...problem, cppSnippet: '' })}
${snippet ? `
EXACT LEETCODE ${name.toUpperCase()} SIGNATURE (use it verbatim — same class/function names and types):
\`\`\`${fence}
${snippet.trim()}
\`\`\`
${keepNamesLine(snippet)}
` : ''}
ACCEPTED C++ SOLUTION (correct — translate it, do not change the algorithm):
\`\`\`cpp
${code}
\`\`\`

RULES:
- Same algorithm, same time and space complexity. Do not "optimise" or restructure it.
- Idiomatic ${name}, standard library only. No main(), no I/O, no test code.
- Do NOT define ListNode / TreeNode / Node etc. — LeetCode provides them.
- Keep integer semantics correct: C++ long long → a 64-bit type (Java/Kotlin/C# long, Go int64, Rust i64);
  JavaScript/TypeScript numbers are exact only up to 2^53 — use BigInt only if values can exceed that.
- In your reasoning, trace the translated code on Example 1 and confirm it gives the expected output.

Respond ONLY in this exact format:
---CODE---
\`\`\`${fence}
...
\`\`\`
---END---`.trim();
}


// Every remaining language in ONE request — one reply section per language.
// Only Example 1 matters for checking a translation, so the statement is
// clipped to keep the request small.
export function buildTranslateAllPrompt(code, problem, languages, snippets = {}) {
  const shortProblem = { ...problem, cppSnippet: '', officialHints: [], description: (problem.description || '').slice(0, 2500) };
  const signatures = languages.filter(l => snippets[l]).map(l =>
    `${LANGUAGES[l].name}:\n\`\`\`${LANGUAGES[l].fence}\n${snippets[l].trim()}\n\`\`\`\n${keepNamesLine(snippets[l])}`).join('\n\n');
  return `You are an expert competitive programmer fluent in many languages.

${buildProblemContext(shortProblem)}

ACCEPTED C++ SOLUTION (correct — translate it, do not change the algorithm):
\`\`\`cpp
${code}
\`\`\`
${signatures ? `
EXACT LEETCODE SIGNATURES (use them verbatim — same class/function names and types):
${signatures}
` : ''}
Translate the solution into: ${languages.map(l => LANGUAGES[l].name).join(', ')}.

RULES:
- Same algorithm, same time and space complexity in every language. Do not restructure it.
- Idiomatic code, standard library only. No main(), no I/O, no test code.
- Do NOT define ListNode / TreeNode / Node etc. — LeetCode provides them.
- C++ long long → a 64-bit type (Java/Kotlin/C# long, Go int64, Rust i64, Swift Int).
  JavaScript/TypeScript numbers are exact only up to 2^53 — use BigInt only if values can exceed that.

Respond ONLY in this exact format, one section per language, in this order:
${languages.map(l => `---${codeTag(l)}---\n\`\`\`${LANGUAGES[l].fence}\n...\n\`\`\``).join('\n')}
---END---`.trim();
}


// ─────────────────────────────────────────────
// 6. ENTRY POINT used by the backend
//    action: 'hints' (solve + hints, streamed) | 'solve' (code only) | 'fix'
//            | 'translate' (C++ → extra.language)
//            | 'translate_all' (C++ → every language in extra.languages)
//    extra.language on 'hints' / 'solve': also write the solution in that language
// ─────────────────────────────────────────────

export const ACTIONS = ['hints', 'solve', 'fix', 'translate', 'translate_all'];

export function buildPrompt(action, problem, code = '', extra = {}) {
  const also = { alsoLanguage: extra.language, alsoSnippet: extra.snippet };
  if (action === 'hints') return buildSolutionPrompt(problem, { withHints: true, ...also });
  if (action === 'fix' && code) return buildFixPrompt(code, problem);
  if (action === 'translate' && code) return buildTranslatePrompt(code, problem, extra.language, extra.snippet);
  if (action === 'translate_all' && code) return buildTranslateAllPrompt(code, problem, extra.languages, extra.snippets);
  return buildSolutionPrompt(problem, also);
}
