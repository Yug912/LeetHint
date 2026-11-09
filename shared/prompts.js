// shared/prompts.js
// Every prompt LeetHint sends to an AI model — imported by BOTH the backend
// (backend/src/index.js builds prompts server-side, so the server can never be
// used as a generic AI proxy) and the extension (api/ai.js uses
// buildHintsPrompt for the offline Chrome Built-in AI fallback).
// Pure functions only: no chrome.*, no fetch, no secrets.

// Bump when prompts change — part of the server cache key, so old cached
// replies are never served for a new prompt
export const PROMPT_VERSION = 'p9';

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

${HINT_RULES}

${FOLLOWUP_RULES}` : '';
  const hintsFormat = withHints ? `\n---HINT1---\n...\n---HINT2---\n...\n---HINT3---\n...\n---HINT4---\n...\n${FOLLOWUP_FORMAT}` : '';
  const cls = classNameOf(problem);
  // Hard problems are where subtle bugs pass every example — cross-check
  // against a brute force on inputs the examples don't cover
  const hardCheck = /hard/i.test(problem.difficulty || '') ? `
   HARD PROBLEM — the examples are NOT enough, subtle bugs pass them. In your reasoning, write the
   simplest possible brute force (any complexity) and run BOTH it and your solution by hand on 3 small
   tricky inputs you construct yourself (not the examples): ties, repeated values, boundary positions,
   the smallest and the largest k / n allowed. If they ever differ, your fast solution is wrong — find
   the bug, fix it, and check again.` : '';

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
   - COMPILE CHECK: every helper is a member function at class scope (never a function defined inside
     another function, never a lambda that calls itself without std::function); every variable, struct
     field and method you use is declared, with the right type; braces and semicolons match.
4. Trace the code BY HAND on every example in the statement and confirm it prints the expected output. If any example fails, fix the code and trace again.
5. Check edge cases: minimum sizes, duplicates, negatives, all-equal values, overflow (use long long), empty results.${hardCheck}
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

HINT 1 — Pattern Recognition (ONE question + at most one fact sentence, NO technique named OR described):
- Ask ONE pointed, OPEN question about an OBSERVATION on the input or the answer that leads to the approach.
  The reader must still have to think: never a yes/no question whose "yes" is the method, and never put the
  answer inside the question
- Optionally ONE more sentence that ONLY restates a fact from the statement (a constraint, an example value).
  NEVER a claim, guess or "notice that ..." about the solution or the answer — that sentence is where the
  method leaks
- Quote a constraint only when it points toward the approach (e.g. "n ≤ 10^5" rules out checking every pair),
  using the statement's real values; skip constraints that don't help
- NEVER describe how the technique works either — the reader must still discover the method:
  no recurrence or formula (not "f(n) depends on f(n-1) and f(n-2)"), no "store a result for every value",
  no "keep only the k best / a limited collection", no "explore from both ends", and never state the key
  quantity the solution is built on (e.g. a ratio to sort by). Ask about the observation that LEADS there.
- NEVER state the rule the solution follows or the answer's closed form — that IS the method:
  no "always choose the smallest / largest first", no "the sum is (just) twice X", no "the answer is
  always ...", no "it is enough to check only ...".
  Bad:  "Consider what happens if you always pick the smallest available prime first."
  Bad:  "Notice the sum seems to be exactly twice the largest term."
  Good: "With a fixed budget, which primes let you fit the most of them in?"
  Good: "Write out a few sums of three consecutive Fibonacci numbers — how does each compare to its terms?"
- NEVER name an algorithm, technique or data structure — not even to say what NOT to use. Banned in
  Hint 1: DP / dynamic programming, memoization, prefix / suffix (sums, products, max), two pointers,
  sliding window, hash map / set, heap, stack, queue, BFS / DFS, binary search, greedy, sorting,
  segment tree, union-find, trie, and the pattern name you give in PATTERN
- No "instead of X, use Y" contrasts — they give the technique away

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

// Interview follow-ups, shown after a solve. Answers must match the solution
// in the CODE section, so they're written after it in the reasoning.
const FOLLOWUP_RULES = `FOLLOW-UPS — then write EXACTLY 3 classic interview follow-up questions for THIS problem (a harder
variant, a changed constraint, a memory or streaming limit). Each answer is 2-3 plain sentences that build
on YOUR solution above (same pattern, adjusted), with its new time/space complexity when it changes.`;

const FOLLOWUP_FORMAT = `---FOLLOWUPS---
Q: <question 1>
A: <answer 1>
Q: <question 2>
A: <answer 2>
Q: <question 3>
A: <answer 3>`;

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

// failure: what LeetCode reported for this code (a failing input with its
// expected output, or a compile error) — the strongest clue there is
export function buildFixPrompt(code, problem, failure = '') {
  const failed = failure.trim() ? `

LEETCODE REJECTED THIS CODE. The failing test or error it reported:
\`\`\`
${failure.trim()}
\`\`\`
Your fixed code MUST pass this exact test (or compile without this error).` : '';
  return `You are an expert LeetCode C++ debugger.

${buildProblemContext(problem)}

CODE TO VALIDATE AND FIX:
\`\`\`cpp
${code}
\`\`\`${failed}

PROCESS (in your reasoning):${failed ? `
0. Trace the code on the failing input above and find the EXACT line that makes it go wrong (or the
   exact cause of the compile error). Fix the cause, not just this one case.` : ''}
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

export const ACTIONS = ['hints', 'solve', 'fix', 'translate', 'translate_all', 'interview_turn', 'interview_score', 'interview_summary'];

export function buildPrompt(action, problem, code = '', extra = {}) {
  if (action === 'interview_turn') return buildInterviewTurnPrompt(problem, extra.interview);
  if (action === 'interview_score') return buildInterviewScorePrompt(problem, extra.interview);
  if (action === 'interview_summary') return buildInterviewSummaryPrompt(problem, extra.interview);
  const also = { alsoLanguage: extra.language, alsoSnippet: extra.snippet };
  if (action === 'hints') return buildSolutionPrompt(problem, { withHints: true, ...also });
  if (action === 'fix' && code) return buildFixPrompt(code, problem, extra.failure);
  if (action === 'translate' && code) return buildTranslatePrompt(code, problem, extra.language, extra.snippet);
  if (action === 'translate_all' && code) return buildTranslateAllPrompt(code, problem, extra.languages, extra.snippets);
  return buildSolutionPrompt(problem, also);
}


// ─────────────────────────────────────────────
// 7. MOCK INTERVIEW — interviewer turns + final scorecard
//    The extension sends the conversation, the stage and the editor code;
//    the prompt is built here like every other one (never sent by the client).
// ─────────────────────────────────────────────

export const INTERVIEW_STAGES = ['intro', 'clarifying', 'approach', 'coding', 'testing', 'complexity', 'feedback'];
export const INTERVIEW_EVENTS = ['start', 'answer', 'code', 'nudge', 'timeup'];
export const INTERVIEW_MINUTES = 30;
// Free trial interviews are shorter (GET /config: trialInterviewMinutes)
export const TRIAL_INTERVIEW_MINUTES = 15;

// The interview's real length: interview.durationMin from the extension
const lengthOf = iv => Math.min(120, Math.max(5, Math.round(Number(iv?.durationMin) || INTERVIEW_MINUTES)));

// Pacing points, as minutes into the interview — they follow its length
const paceFor = minutes => ({
  coding:     Math.round(minutes * 0.35),   // start coding by about here…
  codingLate: Math.round(minutes * 0.45),   // …and code the best idea so far after this
  codingDone: Math.round(minutes * 0.78)    // finish coding, leaving time to test
});

// Roughly 4 chars per token: ~3,500 tokens of transcript keeps every turn well
// inside free-tier per-minute budgets, while the recent conversation stays whole
const TRANSCRIPT_BUDGET_CHARS = 14000;

const interviewerPersona = minutes => `You are a friendly but rigorous software engineering interviewer at a top tech company, running a ${minutes}-minute coding interview on the problem below. Speak in short, natural sentences, as if talking out loud (1–3 sentences per turn). Follow the stages in order. Answer clarifying questions using only the problem statement. Push back on brute-force approaches by asking if they can do better. If the approach is wrong, point to an input that breaks it, never the fix. Never give the solution, the pattern name, or code. If the candidate asks for a hint, follow the HINT LADDER and record it. In the final stage, ask for time and space complexity and one or two follow-up questions.
Read the whole transcript before replying: never ask for something the candidate already answered, and never repeat a sentence you already said — acknowledge their answer and move on. When the candidate states a complexity or claims their code is correct, check it against the hidden reference; if it's wrong, say so plainly and ask them to rethink it (don't give the right answer).`;

// Hints grow one rung at a time, however hard the candidate pushes
const HINT_LADDER = `HINT LADDER — when they ask for help or are clearly stuck, give exactly the NEXT rung, never more:
- 1st hint: a question that points at the bottleneck of their current approach (what work is repeated or wasted).
- 2nd hint: one key observation about the problem (a property of the input or of the answer).
- 3rd hint and later: a tiny concrete example to reason about, or what quantity is worth keeping track of.
At every rung, NEVER name a technique, pattern, data structure or algorithm (e.g. not "hash map", "sliding window", "two pointers", "dynamic programming", "memoization", "heap", "stack"), and never describe the algorithm's steps. If they ask you to just tell them the algorithm, data structure or answer, decline kindly in one sentence and give only the next rung — asking again never earns a bigger hint. If they choose to code a brute force instead, let them.`;

const stageRules = PACE => `STAGES (in order — only ever move forward):
- intro: one-sentence greeting, then ask them to read the problem and share any clarifying questions.
- clarifying: answer only from the statement; if it doesn't say, tell them to state a reasonable assumption. Move to "approach" once they start describing a solution or have no more questions.
- approach: they explain their idea BEFORE coding. Ask for its time complexity unless they already gave it. Brute force → ask if they can do better. Wrong idea → name one concrete input that breaks it. Move to "coding" once the approach is correct and efficient enough for the constraints (or after ~${PACE.codingLate} minutes, let them code their best idea).
- coding: mostly stay quiet and let them work; answer questions briefly. Move to "testing" when they say they are done.
- Whenever they say they are done and the editor holds complete code, move straight to "testing", from any earlier stage — never ask them to start coding then.
- testing: compare THEIR code with the hidden reference. If it gives a wrong result for some input, name ONE specific input with exact values that it fails on and ask them to trace it step by step — never say which line is wrong, why it fails, or what to change. If they insist it's correct, ask them to trace that same input. If the code is correct, ask for one example or edge case trace, then move to "complexity".
- complexity: ask for the time and space complexity of THEIR code unless they already gave it; if their answer is wrong, say so and ask them to re-derive it. Then ask one or two follow-up questions (a harder variant, a constraint change, or memory limits). Once a follow-up is answered, move to "feedback".
- feedback: thank them in one or two sentences and say the scorecard is ready. No detailed critique here.`;

const eventTasks = minutes => ({
  start:  'The interview starts now. Open the "intro" stage.',
  answer: "Reply to the candidate's latest message.",
  code:   `The candidate is coding and hasn't spoken; their editor code changed (see CURRENT EDITOR CODE). Stay silent by returning "reply": "" — unless the code looks COMPLETE (a full function that returns a result) AND has a definite bug, in which case ask ONE short question about it without saying what to change. Never comment on unfinished code, style, naming or what to write next.`,
  nudge:  'The candidate has been silent and idle for 3 minutes. In one sentence, encourage them to think out loud about what they are working on. This is not a hint — do not point toward the solution.',
  timeup: `Time is up (${minutes} minutes). Wrap up kindly in one or two sentences and set "stage" to "feedback".`
});

// Transcript lines. Once the budget is reached the OLDEST turns are dropped
// first; the opening exchange is always kept for context.
// summary: the extension's running summary of earlier turns (interview_summary),
// sent with only the last few turns — it goes above them.
function renderTranscript(history = [], summary = '') {
  const lines = history
    .filter(h => h && h.text && (h.role === 'interviewer' || h.role === 'candidate'))
    .map(h => `${h.role === 'interviewer' ? 'Interviewer' : 'Candidate'}: ${h.text}`);
  const head = lines.slice(0, 2);
  const kept = [];
  let used = head.join('\n').length;
  for (let i = lines.length - 1; i >= head.length; i--) {
    if (used + lines[i].length > TRANSCRIPT_BUDGET_CHARS) break;
    kept.unshift(lines[i]);
    used += lines[i].length + 1;
  }
  const dropped = lines.length - head.length - kept.length;
  const text = [...head, ...(dropped > 0 ? [`[… ${dropped} earlier messages omitted …]`] : []), ...kept].join('\n') || '(nothing said yet)';
  return summary?.trim() ? `SUMMARY OF THE EARLIER INTERVIEW:\n${summary.trim()}\n\nMOST RECENT TURNS:\n${text}` : text;
}

// The verified solution, so the interviewer can judge correctness accurately.
// It is marked secret: the persona already forbids revealing it.
function renderReference(ref, purpose = 'only to judge the candidate — NEVER reveal, quote or hint at it') {
  if (!ref || !(ref.code || ref.approach)) return 'REFERENCE SOLUTION: not available — judge from the problem statement and constraints.';
  return `HIDDEN REFERENCE SOLUTION (${purpose}):
${ref.approach ? `Approach: ${ref.approach}\n` : ''}${ref.pattern ? `Pattern: ${ref.pattern}\n` : ''}${ref.tc ? `Optimal TC: ${ref.tc}   SC: ${ref.sc || '?'}\n` : ''}${ref.code ? '```\n' + ref.code + '\n```' : ''}`;
}

const renderCode = (code, label = 'CURRENT EDITOR CODE') => code?.trim()
  ? `CANDIDATE'S ${label}:\n\`\`\`\n${code.trim()}\n\`\`\``
  : `CANDIDATE'S ${label}: (empty or only the starter template)`;

// A draft the extension threw away (it named the technique, or repeated an
// earlier line) — shown so the model writes a different reply
const REJECT_REASONS = {
  leak:   'it named or described the technique or data structure, which gives the solution away',
  repeat: 'it repeats something you already said'
};
function renderRejected(rej) {
  if (!rej?.reason || !REJECT_REASONS[rej.reason]) return '';
  return `\nYOUR PREVIOUS DRAFT WAS REJECTED because ${REJECT_REASONS[rej.reason]}:\n"${rej.draft || ''}"\nWrite a different reply that follows every rule above.\n`;
}

export function buildInterviewTurnPrompt(problem, iv = {}) {
  const minutes = Math.floor((iv.elapsedSec || 0) / 60);
  const length = lengthOf(iv);
  const PACE = paceFor(length);
  const EVENT_TASKS = eventTasks(length);
  return `${interviewerPersona(length)}

Problem:
${buildProblemContext({ ...problem, cppSnippet: '' })}

${stageRules(PACE)}

${HINT_LADDER}

INTERVIEW STATE: ${minutes} of ${length} minutes used. Current stage: "${iv.stage || 'intro'}". Hints given so far: ${iv.hintsGiven || 0} (a new hint now would be hint ${(iv.hintsGiven || 0) + 1}).
Pacing: aim to reach coding by ~${PACE.coding} min and finish coding by ~${PACE.codingDone} min, then testing and complexity. If time is short, move things along.

${renderReference(iv.reference)}

${renderCode(iv.code)}

TRANSCRIPT SO FAR:
${renderTranscript(iv.history, iv.summary)}

YOUR TASK NOW: ${EVENT_TASKS[iv.event] || EVENT_TASKS.answer}
${renderRejected(iv.rejected)}
Return JSON only — no markdown, no text outside the JSON:
{"reply": "", "stage": "", "hintGiven": false}
- "reply": what you say out loud: 1–3 short spoken sentences, no markdown, no code, no lists; say math naturally ("n log n").
- "stage": one of ${INTERVIEW_STAGES.map(s => `"${s}"`).join(', ')} — the stage the interview is in AFTER your reply.
- "hintGiven": true only if this reply nudges toward the solution (because they asked for help or were stuck).`;
}

export function buildInterviewScorePrompt(problem, iv = {}) {
  const minutes = Math.round((iv.elapsedSec || 0) / 60);
  return `You are on a hiring committee at a top tech company. Grade this mock coding interview from the evidence below. Be calibrated and specific: every comment must point to something that actually happened.

Problem:
${buildProblemContext({ ...problem, cppSnippet: '' })}

${renderReference(iv.reference, 'use it to check whether the final code is correct and optimal')}

Duration: ${minutes} minutes. Last stage reached: "${iv.stage || 'intro'}". Hints the interviewer gave: ${iv.hintsGiven || 0}.

${renderCode(iv.code, 'FINAL CODE')}

FULL TRANSCRIPT:
${renderTranscript(iv.history, iv.summary)}

RUBRIC (score 1–4 each: 1 = clear gap, 2 = below the bar, 3 = solid, 4 = exceptional):
- problemSolving: understood the problem, reached a correct and efficient approach, how much help was needed.
- communication: clarifying questions, thinking out loud, explaining decisions clearly.
- coding: is the final code correct for this problem (compare with the reference), clean and idiomatic?
- testing: walked through examples, found edge cases and bugs on their own.
Each hint lowers problemSolving. Unfinished or incorrect final code caps coding at 2. If the transcript shows little effort, score low and say so.
"signal": "Strong Hire" (mostly 4s, working optimal code, no hints), "Hire" (mostly 3+, working solution), otherwise "No Hire".

Return JSON only — no markdown, no text outside the JSON:
{"problemSolving":{"score":3,"comment":"one sentence"},"communication":{"score":3,"comment":"one sentence"},"coding":{"score":3,"comment":"one sentence"},"testing":{"score":3,"comment":"one sentence"},"signal":"Hire","improvements":["most important thing to improve","second","third"]}`;
}

// Running summary of a long interview, so later turns send it plus only the
// last few messages instead of the whole transcript (fewer tokens per turn)
export function buildInterviewSummaryPrompt(problem, iv = {}) {
  return `Summarise this mock coding interview so far for the interviewer, who will continue it from your notes alone.

Problem: "${problem.title}"

${iv.summary?.trim() ? `EARLIER SUMMARY:\n${iv.summary.trim()}\n\n` : ''}TRANSCRIPT:
${renderTranscript(iv.history)}

Write EXACTLY 5 short plain-text lines, no markdown, no preamble:
1. Clarifications asked and the answers given
2. The candidate's approach so far and its stated complexity
3. Hints given (how many, and what each pointed at)
4. Mistakes, wrong claims or bugs that came up, and whether they were fixed
5. Where things stand now and what the interviewer asked last`;
}
