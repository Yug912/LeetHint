// api/gemini.js
// Handles all AI hint generation
//
// Pipeline — ONE streamed request per problem:
//   the model solves the problem in its reasoning, then replies with
//   approach + TC/SC → Hints 1-4 → C++ code.
// Hints, solution and complexity therefore always describe the SAME algorithm,
// and hints are shown as soon as each one finishes streaming.
//
// Providers (first available wins, falls through on failure):
//   OpenRouter key → Gemini key → Chrome Built-in AI (hints only, ungrounded)

// ─────────────────────────────────────────────
// 0. SHARED UTILITY — paren-counting O() extractor
//    Handles arbitrary nesting: O(n*log(log(n))), O(m² × n × log(n)) etc.
//    Simple regex breaks on these; paren counting works for any depth.
// ─────────────────────────────────────────────

function extractAllBigO(text) {
  const results = [];
  let i = 0;
  while (i < text.length) {
    // Find next 'O(' (must be 'O' followed by '(')
    const idx = text.indexOf('O(', i);
    if (idx < 0) break;
    // Make sure it's not preceded by a letter (e.g. 'FOR(' or 'GOOD(')
    if (idx > 0 && /[A-Za-z]/.test(text[idx - 1])) { i = idx + 1; continue; }
    // Count parens to find the matching close
    let depth = 0;
    let j = idx + 1; // start at '('
    while (j < text.length) {
      if (text[j] === '(') depth++;
      else if (text[j] === ')') {
        depth--;
        if (depth === 0) { results.push(text.slice(idx, j + 1)); break; }
      }
      j++;
    }
    i = idx + 2; // advance past 'O('
  }
  return results;
}

// Extract a section up to whichever ---DELIMITER--- comes next (order-independent)
function extractUntilNext(text, tag) {
  const startMatch = text.match(new RegExp(`---\\s*${tag}\\s*---`, 'i'));
  if (!startMatch) return '';
  const remaining = text.slice(startMatch.index + startMatch[0].length);
  const next = remaining.match(/---\s*[A-Z][A-Z0-9_]*\s*---/i);
  return remaining.slice(0, next ? next.index : remaining.length).trim();
}

// Extract text between ---TAG--- delimiters (tolerant of spacing / case / dashes)
function extractSection(text, startTag, endTag) {
  const startRe = new RegExp(`---\\s*${startTag}\\s*---`, 'i');
  const endRe   = endTag ? new RegExp(`---\\s*${endTag}\\s*---`, 'i') : null;
  const startMatch = text.match(startRe);
  if (!startMatch) return '';
  const from = startMatch.index + startMatch[0].length;
  const remaining = text.slice(from);
  if (!endRe) return remaining.trim();
  const endMatch = remaining.match(endRe);
  return remaining.slice(0, endMatch ? endMatch.index : remaining.length).trim();
}

// Strip reasoning blocks, normalise dashes, unwrap a whole-reply fence
function cleanModelText(raw) {
  let text = String(raw || '').replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
  // Gemini sometimes wraps the whole reply in ```...``` which hides delimiters
  if (/^```/.test(text) && !/---\s*CODE\s*---/i.test(text)) {
    text = text.replace(/^```[\w\s]*\n?/, '').replace(/\n?```\s*$/, '').trim();
  }
  // Normalise smart/em-dashes → regular hyphens so ---HINT1--- always matches
  return text.replace(/[—–]/g, '-');
}

// Remove #include / using namespace std / std:: — LeetCode provides these
function cleanCppCode(code) {
  return String(code || '').split('\n')
    .filter(l => !l.trimStart().startsWith('#include') &&
                 !l.trim().startsWith('using namespace std'))
    .join('\n')
    .replace(/std::/g, '')
    .replace(/^\n+/, '')
    .trim();
}

function extractCppFence(text) {
  const m = String(text || '').match(/```(?:cpp|c\+\+)?\s*([\s\S]*?)```/i);
  return m ? cleanCppCode(m[1]) : '';
}

// Models sometimes drop the fences or put the code in the wrong section.
// Find "class Solution {" and take everything up to its matching "};".
function extractClassSolution(text) {
  const t = String(text || '');
  const start = t.search(/class\s+Solution\s*\{/);
  if (start < 0) return '';
  let depth = 0;
  for (let i = t.indexOf('{', start); i < t.length; i++) {
    if (t[i] === '{') depth++;
    else if (t[i] === '}' && --depth === 0) {
      const end = t[i + 1] === ';' ? i + 2 : i + 1;
      return cleanCppCode(t.slice(start, end));
    }
  }
  return ''; // unbalanced → truncated output, not usable
}


// ─────────────────────────────────────────────
// 1. PROBLEM CONTEXT — everything the model needs, nothing truncated
//    Constraints sit at the END of the statement, and they are what
//    decides the intended complexity — never slice the description.
// ─────────────────────────────────────────────

function buildProblemContext(problem) {
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
    parts.push('', 'OFFICIAL LEETCODE HINTS:', ...officialHints.map((h, i) => `${i + 1}. ${h}`));
  }
  return parts.join('\n');
}


// ─────────────────────────────────────────────
// 2. SOLUTION PROMPT (Step 1 — reasoning model)
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
function buildSolutionPrompt(problem, { withHints = false } = {}) {
  const hintsStep = withHints ? `

Finish steps 1-6 in your reasoning FIRST. Then, for a learner who has NOT seen your code, write hints that
lead to YOUR solution's exact approach (any complexity mentioned must match your TC/SC; get example numbers
by tracing your code, never guess). In the reply the hints come before the code, but they must describe
exactly the code you then output:

${HINT_RULES}` : '';
  const hintsFormat = withHints ? '\n---HINT1---\n...\n---HINT2---\n...\n---HINT3---\n...\n---HINT4---\n...' : '';

  return `You are a world-class competitive programmer. Your C++ solution WILL be submitted to LeetCode and MUST pass every test case, including the largest inputs allowed by the constraints.

${buildProblemContext(problem)}

PROCESS (do this in your reasoning before answering):
1. Read the constraints and derive the complexity budget (≈10^8 simple ops per second).
2. Choose the optimal, well-known algorithm for THIS exact problem. No brute force if it would TLE.
3. Write the COMPLETE code using the EXACT signature above (class Solution { ... }) so it can be pasted into LeetCode and submitted as-is:
   - No #include, no std::, no main(), no I/O.
   - Do NOT define ListNode / TreeNode / Node etc. — LeetCode already provides them (they appear only as comments in the signature).
   - Put any helper functions or structs INSIDE class Solution. No placeholders, no "..." — every line must be real code.
4. Trace the code BY HAND on every example in the statement and confirm it prints the expected output. If any example fails, fix the code and trace again.
5. Check edge cases: minimum sizes, duplicates, negatives, all-equal values, overflow (use long long), empty results.
6. ${COMPLEXITY_RULES}${hintsStep}

Respond ONLY in this exact format:
---APPROACH---
2-4 sentences: the key insight, the algorithm, and why it is correct.
${COMPLEXITY_FORMAT}
---PATTERN---
short pattern name (e.g. "Sliding Window", "Monotonic Stack", "DP on Intervals")${hintsFormat}
---CODE---
\`\`\`cpp
class Solution {
...
};
\`\`\`
---END---`.trim();
}

function parseSolutionResponse(raw) {
  const text = cleanModelText(raw);

  const codeSection = extractUntilNext(text, 'CODE');
  // Fallbacks: unfenced code in the CODE section, then a class Solution anywhere
  // (e.g. the model wrongly put it inside a hint), then any fence at all
  const code = extractCppFence(codeSection) || extractClassSolution(codeSection) ||
               extractClassSolution(text) || extractCppFence(text);

  const tc = extractAllBigO(extractUntilNext(text, 'TC'))[0] || '';
  const sc = extractAllBigO(extractUntilNext(text, 'SC'))[0] || '';
  const approach = extractUntilNext(text, 'APPROACH') ||
                   (text.match(/Approach:\s*(.+)/i) || [])[1] || '';
  const pattern = extractUntilNext(text, 'PATTERN');
  const scBreakdown = extractUntilNext(text, 'SC_BREAKDOWN');

  return { code, approach: approach.trim(), tc, sc, scBreakdown, pattern: pattern.trim() };
}


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

// Hints-only prompt — used only by the no-key fallback (Chrome Built-in AI)
function buildHintsPrompt(problem) {
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

// Streaming: what is FINISHED so far. A section is finished once the next
// ---TAG--- delimiter has started, so a half-written hint is never shown.
function parsePartialHints(raw) {
  const text = cleanModelText(raw);
  const finished = tag => {
    const m = text.match(new RegExp(`---\\s*${tag}\\s*---`, 'i'));
    return !!m && /---\s*[A-Z][A-Z0-9_]*\s*---/i.test(text.slice(m.index + m[0].length));
  };
  const partial = { hint1: '', hint2: '', hint3: '', hint4: '', optimal_tc: '', optimal_sc: '', sc_breakdown: '', pattern: '' };
  for (const n of [1, 2, 3, 4]) {
    if (finished(`HINT${n}`)) partial[`hint${n}`] = extractUntilNext(text, `HINT${n}`);
  }
  if (finished('PATTERN')) {
    // TC / SC / SC_BREAKDOWN come before PATTERN, so they are complete too
    const ref = parseSolutionResponse(raw);
    Object.assign(partial, { optimal_tc: ref.tc, optimal_sc: ref.sc, sc_breakdown: ref.scBreakdown, pattern: ref.pattern });
  }
  return partial;
}

function parseHintsJSON(rawText) {
  const text = cleanModelText(rawText);
  const extract = (a, b) => extractSection(text, a, b);

  // Each hint ends at the next delimiter, whatever it is — works for both the
  // hints-only format and the combined solve+hints format
  const hint1 = extractUntilNext(text, 'HINT1');
  const hint2 = extractUntilNext(text, 'HINT2');
  const hint3 = extractUntilNext(text, 'HINT3');
  const hint4 = extractUntilNext(text, 'HINT4');

  if (!hint1) {
    throw new Error('Failed to parse AI response: missing required hints. Please retry.');
  }

  // TC/SC from hints response — only used when there is no reference solution
  let optimal_tc = extractAllBigO(extract('TC', 'SC'))[0] || '';
  let optimal_sc = extractAllBigO(extract('SC', 'PATTERN') || extract('SC', 'END') || extract('SC', null))[0] || '';

  // Fallback: scan entire text for O() expressions if sections didn't yield values
  if (!optimal_tc || !optimal_sc) {
    const unique = [...new Set(extractAllBigO(text))];
    // Take the last two unique O() expressions — TC then SC are at the end
    if (!optimal_tc) optimal_tc = unique[unique.length - 2] || unique[unique.length - 1] || '';
    if (!optimal_sc) optimal_sc = unique[unique.length - 1] || '';
  }

  const pattern = extract('PATTERN', 'END') || 'Unknown';

  return { hint1, hint2, hint3, hint4, hint5: '', optimal_tc, optimal_sc, pattern };
}


// ─────────────────────────────────────────────
// 4. PROVIDERS — one call signature for every backend
//    NOTE: for reasoning models the token limit INCLUDES thinking tokens —
//    small limits silently truncate the answer, so budgets are generous.
// ─────────────────────────────────────────────

const OR_MODEL = 'deepseek/deepseek-r1';   // strong at correct algorithms
const OR_ENDPOINT = 'https://openrouter.ai/api/v1/chat/completions';

// Google retires Gemini models for new keys regularly. If the API says
// "please use models/X", callGemini switches to X and remembers it.
const GEMINI_DEFAULT_MODEL = 'gemini-3.8-flash';

// The token limit INCLUDES thinking tokens — keep it generous or the reply is cut off
const GEN_SETTINGS = { temperature: 0.1, maxTokens: 16000 };

// Reads a Server-Sent Events body and hands each parsed `data:` JSON to onEvent
async function readSSE(response, onEvent) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line.startsWith('data:')) continue;  // keep-alive comments etc.
      const data = line.slice(5).trim();
      if (!data || data === '[DONE]') continue;
      let event;
      try { event = JSON.parse(data); } catch { continue; }
      onEvent(event);
    }
  }
}

// onText(fullTextSoFar) — when given, the reply is streamed
async function callOpenRouter(apiKey, prompt, onText) {
  const model = OR_MODEL;
  const { temperature, maxTokens } = GEN_SETTINGS;
  const response = await fetch(OR_ENDPOINT, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      'HTTP-Referer': 'https://leethint.chrome.extension',
      'X-Title': 'LeetHint'
    },
    body: JSON.stringify({
      model,
      messages: [{ role: 'user', content: prompt }],
      temperature,
      max_tokens: maxTokens,
      stream: !!onText
    })
  });

  if (!response.ok) {
    const err = await response.json().catch(() => ({}));
    const msg = err.error?.message || `HTTP ${response.status}`;
    throw new Error(`OpenRouter (${model}): ${msg}`);
  }

  let text = '';
  let finish = '';
  if (onText) {
    let streamErr = '';
    await readSSE(response, ev => {
      if (ev.error) { streamErr = ev.error.message || 'stream error'; return; }
      const choice = ev.choices?.[0];
      const delta = choice?.delta?.content;
      if (choice?.finish_reason) finish = choice.finish_reason;
      if (delta) { text += delta; onText(text); }
    });
    if (streamErr && !text) throw new Error(`OpenRouter (${model}): ${streamErr}`);
  } else {
    const data = await response.json();
    const choice = data.choices?.[0];
    text = choice?.message?.content || '';
    finish = choice?.finish_reason || '';
  }

  if (!text) throw new Error(`OpenRouter (${model}) returned empty response (finish: ${finish || '?'})`);
  if (finish === 'length') console.warn(`LeetHint: ${model} hit the token limit — output may be truncated`);
  return text;
}

async function getGeminiModel() {
  const { geminiModel } = await chrome.storage.local.get('geminiModel');
  return geminiModel || GEMINI_DEFAULT_MODEL;
}

async function callGemini(apiKey, prompt, onText, retried = false) {
  const model = await getGeminiModel();
  const { temperature, maxTokens } = GEN_SETTINGS;
  const method = onText ? 'streamGenerateContent?alt=sse&' : 'generateContent?';
  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${model}:${method}key=${apiKey}`;

  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: {
        temperature,
        maxOutputTokens: maxTokens   // includes thinking tokens — keep generous
        // NOTE: responseMimeType removed — causes failures on some API keys/regions
      }
    })
  });

  if (!response.ok) {
    const err = await response.json().catch(() => ({}));
    const msg = err.error?.message || `HTTP ${response.status}`;

    // Model retired → switch to the replacement Google names, once
    const suggested = msg.match(/use\s+models\/([\w.\-]+)/i)?.[1];
    if (!retried && suggested && suggested !== model) {
      console.warn(`LeetHint: Gemini model ${model} retired → switching to ${suggested}`);
      await chrome.storage.local.set({ geminiModel: suggested });
      return callGemini(apiKey, prompt, onText, true);
    }

    if (response.status === 429) {
      const details = err.error?.details || [];
      const retryInfo = details.find(d => String(d['@type']).includes('RetryInfo'));
      const delaySec = parseFloat(retryInfo?.retryDelay || msg.match(/retry in ([\d.]+)s/i)?.[1] || 'NaN');
      const quotaIds = details.flatMap(d => (d.violations || []).map(v => v.quotaId || '')).join(' ');
      const perDay = /PerDay/i.test(quotaIds) || (!isNaN(delaySec) && delaySec > 60);

      // Per-minute limit with a short wait → wait it out once, transparently
      if (!retried && !perDay && !isNaN(delaySec) && delaySec <= 60) {
        console.warn(`LeetHint: Gemini per-minute quota hit — retrying in ${Math.ceil(delaySec)}s`);
        await new Promise(r => setTimeout(r, (delaySec + 1) * 1000));
        return callGemini(apiKey, prompt, onText, true);
      }

      const e = new Error(perDay
        ? 'Gemini free-tier DAILY quota used up — it resets at midnight Pacific time. To keep going now, add an OpenRouter key or enable billing on your Google AI key.'
        : 'Gemini free-tier rate limit hit (too many requests per minute). Wait a minute and try again.');
      e.isQuota = true;
      throw e;
    }
    throw new Error(`Gemini (${model}): ${msg}`);
  }

  // Thinking models may return several parts — keep only the non-thought ones
  const answerText = data => (data.candidates?.[0]?.content?.parts || [])
    .filter(p => !p.thought).map(p => p.text || '').join('');

  let text = '';
  if (onText) {
    await readSSE(response, ev => {
      const chunk = answerText(ev);
      if (chunk) { text += chunk; onText(text); }
    });
  } else {
    text = answerText(await response.json());
  }
  if (!text) throw new Error(`Gemini (${model}) returned empty response`);
  return text;
}

// Returns [{ name, call(prompt, onText?) }] in priority order
async function getProviders() {
  const storage = await chrome.storage.local.get(['openRouterApiKey', 'geminiApiKey']);
  const providers = [];
  if (storage.openRouterApiKey) {
    providers.push({ name: 'OpenRouter', call: (p, onText) => callOpenRouter(storage.openRouterApiKey, p, onText) });
  }
  if (storage.geminiApiKey) {
    providers.push({ name: 'Gemini', call: (p, onText) => callGemini(storage.geminiApiKey, p, onText) });
  }
  return providers;
}


// ─────────────────────────────────────────────
// 5. CHROME BUILT-IN AI FALLBACK (no key — hints only)
// ─────────────────────────────────────────────

async function generateWithBuiltinAI(prompt) {
  const AIModel = window.LanguageModel || window.ai?.languageModel;
  if (!AIModel) throw new Error('Chrome Built-in AI not available');

  const session = await AIModel.create({
    systemPrompt: 'You are a DSA mentor. Always respond in the exact ---DELIMITER--- format requested.',
    expectedInputLanguages:  ['en'],
    expectedOutputLanguages: ['en']
  });

  const result = await session.prompt(prompt);
  session.destroy();
  return parseHintsJSON(result);
}


// ─────────────────────────────────────────────
// 6. MAIN EXPORT — generateHints()
// ─────────────────────────────────────────────

function applyReference(result, reference) {
  // The solver analysed its own code — its TC/SC is the source of truth
  if (reference.tc) result.optimal_tc = reference.tc;
  if (reference.sc) result.optimal_sc = reference.sc;
  if (reference.pattern) result.pattern = reference.pattern;
  result.sc_breakdown = reference.scBreakdown || '';
  const note = [reference.approach, reference.tc && `TC ${reference.tc}`, reference.sc && `SC ${reference.sc}`]
    .filter(Boolean).join(' · ');
  result.hint5 = '```cpp\n' + reference.code + '\n```\n' + (note ? `Approach: ${note}` : '');
  return result;
}

// ONE request: solve + hints together (half the latency and quota of
// solve-then-hints). Streamed, so finished hints reach onPartial early.
async function generateWithProvider(provider, problem, onPartial) {
  console.log(`LeetHint: [${provider.name}] solve + hints in one streamed request...`);
  let shownCount = 0;
  const onText = onPartial && (soFar => {
    const partial = parsePartialHints(soFar);
    const count = [partial.hint1, partial.hint2, partial.hint3, partial.hint4].filter(Boolean).length;
    if (count > shownCount) { shownCount = count; onPartial(partial); }
  });

  const raw = await provider.call(buildSolutionPrompt(problem, { withHints: true }), onText);
  const result = parseHintsJSON(raw);
  let reference = parseSolutionResponse(raw);
  if (!reference.code) {
    // Hints arrived but the code didn't — spend ONE more request on just the
    // solution rather than leaving hint 5 empty
    console.warn('LeetHint: combined reply had no code — requesting solution separately');
    try {
      const solo = parseSolutionResponse(await provider.call(buildSolutionPrompt(problem)));
      if (solo.code) reference = solo;
    } catch (e) {
      console.warn('LeetHint: separate solution request failed →', e.message);
    }
  }
  return reference.code ? applyReference(result, reference) : result;
}

// onPartial(partialHints) is called each time another hint finishes streaming
async function generateHints(problemData, { onPartial } = {}) {
  console.log('LeetHint: generateHints() called for:', problemData.title);
  console.log('LeetHint: description length:', problemData.description?.length,
              '| signature?', !!problemData.cppSnippet, '| tags:', problemData.topicTags?.join(', ') || '-');

  const providers = await getProviders();
  const errors = [];

  for (const provider of providers) {
    try {
      const result = await generateWithProvider(provider, problemData, onPartial);
      console.log('LeetHint: FINAL TC =', result.optimal_tc, '| SC =', result.optimal_sc);
      console.log(`LeetHint: ${provider.name} succeeded ✅`);
      return result;
    } catch (e) {
      console.warn(`LeetHint: ${provider.name} failed →`, e.message);
      errors.push(e);
    }
  }

  // ─── LAST RESORT: Chrome Built-in AI ─────────────────────────────────
  console.log('LeetHint: Trying Chrome Built-in AI...');
  try {
    return await generateWithBuiltinAI(buildHintsPrompt(problemData));
  } catch (e) {
    console.error('LeetHint: Built-in AI also failed →', e.message);
    // Out of quota isn't a key problem — show just that clear message
    const quotaErr = errors.find(err => err.isQuota);
    if (quotaErr) throw quotaErr;
    const hint = providers.length ? 'Check your API key in Settings.' : 'Add a Gemini API key in Settings.';
    throw new Error(`${[...errors.map(err => err.message), e.message].join(' | ')}. ${hint}`);
  }
}


// ─────────────────────────────────────────────
// 7. SOLUTION VALIDATOR — "🔧 Fix" button
//    Re-solves with full context; if code is given, it is debugged instead.
// ─────────────────────────────────────────────

async function validateSolutionCode(code, problem) {
  const prompt = code ? `You are an expert LeetCode C++ debugger.

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
class Solution {
...
};
\`\`\`
---END---`.trim()
    : buildSolutionPrompt(problem);

  const providers = await getProviders();
  if (!providers.length) throw new Error('No API key available for validation');

  let lastErr;
  for (const provider of providers) {
    try {
      console.log(`LeetHint: Validating solution via ${provider.name}...`);
      // { code, tc, sc, scBreakdown, ... } — complexity describes the RETURNED code
      const fixed = parseSolutionResponse(await provider.call(prompt));
      if (fixed.code) return fixed;
      lastErr = new Error('Validator returned no code');
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr;
}


// ─────────────────────────────────────────────
// 8. TC/SC COMPARISON — smart matching
// ─────────────────────────────────────────────

// Canonical form so equivalent answers match:
//   "m+n" = "n + m", "n^2" = "n²" = "n*n", "mn" = "n × m", "n log(n)" = "nlogn",
//   "log2 n" = "lg n" = "log n", "sqrt(n)" = "√n" = "n^0.5", "2n" = "n"
// Terms are a sorted sum of sorted products; each variable is one letter
// (LeetCode complexities use n, m, k, V, E ... so "mn" means m·n).

const SUPERSCRIPTS = { '⁰': '0', '¹': '1', '²': '2', '³': '3', '⁴': '4', '⁵': '5', '⁶': '6', '⁷': '7', '⁸': '8', '⁹': '9', 'ⁿ': 'n', 'ᵐ': 'm', 'ᵏ': 'k' };

function normalizeComplexity(input) {
  let s = String(input || '').trim();
  // Unwrap O(...) / Θ(...) if the user or model included it
  const m = s.match(/^[OoΘθ]\s*\(([\s\S]*)\)$/);
  if (m) s = m[1];

  s = s.toLowerCase()
    .replace(/[⁰¹²³⁴⁵⁶⁷⁸⁹ⁿᵐᵏ]+/g, sup => '^' + [...sup].map(c => SUPERSCRIPTS[c]).join(''))
    .replace(/√\s*(\w)/g, 'sqrt($1)')
    .replace(/\blg\b/g, 'log')
    .replace(/log\s*_?\s*(2|10|e)(?=\s|\()/g, 'log')   // log2 n, log_2(n) → log
    .replace(/\bln\b/g, 'log')
    .replace(/\*\*/g, '^')
    .replace(/[\s*×·⋅.]/g, (c, i, str) => (c === '.' && /\d/.test(str[i + 1] || '')) ? c : '');

  try {
    return canonSum(s, { i: 0 });
  } catch {
    return s; // unparseable → plain string compare
  }
}

// sum := product ('+' product)*
function canonSum(s, pos, stopAt = '') {
  const terms = [];
  while (pos.i < s.length && s[pos.i] !== stopAt) {
    if (s[pos.i] === '+') { pos.i++; continue; }
    terms.push(canonProduct(s, pos, stopAt));
  }
  // Drop constant terms when something bigger exists: O(n + 1) = O(n)
  let uniq = [...new Set(terms)];
  if (uniq.length > 1) uniq = uniq.filter(t => t !== '1');
  return uniq.sort().join('+') || '1';
}

// product := factor+   (stops at '+', closing paren, or end)
function canonProduct(s, pos, stopAt) {
  const powers = {};   // base → exponent (numeric where possible)
  const others = [];   // non-combinable factors like 2^n, n!, log(n)
  while (pos.i < s.length && s[pos.i] !== '+' && s[pos.i] !== stopAt) {
    const f = canonFactor(s, pos);
    if (!f) continue;
    if (f.base !== undefined) powers[f.base] = (powers[f.base] || 0) + f.exp;
    else others.push(f.text);
  }
  const parts = Object.entries(powers)
    .filter(([, e]) => e !== 0)
    .map(([b, e]) => e === 1 ? b : `${b}^${e}`);
  const all = [...parts, ...others].sort();
  return all.length ? all.join('*') : '1';
}

function readExponent(s, pos) {
  if (s[pos.i] !== '^') return null;
  pos.i++;
  if (s[pos.i] === '(') {
    // n^(2) → plain numeric exponent; otherwise canonicalise the expression
    const num = s.slice(pos.i).match(/^\((\d+(\.\d+)?)\)/);
    if (num) { pos.i += num[0].length; return num[1]; }
    pos.i++; const e = canonSum(s, pos, ')'); pos.i++; return e;
  }
  const m = s.slice(pos.i).match(/^(\d+(\.\d+)?|[a-z])/);
  if (!m) throw new Error('bad exponent');
  pos.i += m[0].length;
  return m[0];
}

function canonFactor(s, pos) {
  const rest = s.slice(pos.i);

  // log / sqrt with either "(...)" or a single atom as argument
  const fn = rest.match(/^(log|sqrt)/);
  if (fn) {
    pos.i += fn[0].length;
    let arg;
    if (s[pos.i] === '(') { pos.i++; arg = canonSum(s, pos, ')'); pos.i++; }
    else {
      const inner = canonFactor(s, pos);
      arg = inner.base !== undefined ? (inner.exp === 1 ? inner.base : `${inner.base}^${inner.exp}`) : inner.text;
    }
    if (fn[1] === 'sqrt') {
      return /^[a-z]$/.test(arg) ? { base: arg, exp: 0.5 } : { text: `(${arg})^0.5` };
    }
    // log(n^k) = k·log n → same big-O
    const lm = arg.match(/^([a-z])\^\d+(\.\d+)?$/);
    if (lm) arg = lm[1];
    let text = `log(${arg})`;
    const e = readExponent(s, pos);
    if (e) text += `^${e}`;
    return { text };
  }

  // Parenthesised group, e.g. (n+m) or (n+m)^2
  if (s[pos.i] === '(') {
    pos.i++;
    const inner = canonSum(s, pos, ')');
    pos.i++;
    const e = readExponent(s, pos);
    if (/^[a-z]$/.test(inner)) {   // (n) or (n)^2 — just a variable
      if (e === null) return { base: inner, exp: 1 };
      if (/^\d/.test(e)) return { base: inner, exp: Number(e) };
      return { text: `${inner}^${e}` };
    }
    if (e) return { text: `(${inner})^${e}` };
    return { text: inner.includes('+') ? `(${inner})` : inner };
  }

  // Number: a constant multiplier (dropped), or an exponential base like 2^n
  const num = rest.match(/^\d+(\.\d+)?/);
  if (num) {
    pos.i += num[0].length;
    const e = readExponent(s, pos);
    if (e && !/^\d/.test(e)) return { text: `${num[0]}^${e}` };
    return null; // constant factor — irrelevant to big-O
  }

  // Single-letter variable, optional ^exp and optional !
  if (/[a-z]/.test(s[pos.i])) {
    const v = s[pos.i++];
    const e = readExponent(s, pos);
    if (s[pos.i] === '!') { pos.i++; return { text: `${v}!` }; }
    if (e === null) return { base: v, exp: 1 };
    if (/^\d/.test(e)) return { base: v, exp: Number(e) };
    return { text: `${v}^${e}` };  // n^k, n^n
  }

  throw new Error(`unexpected "${s[pos.i]}"`);
}

function compareComplexity(userInput, optimal) {
  const userNorm = normalizeComplexity(userInput);
  const optNorm  = normalizeComplexity(optimal);
  return userNorm === optNorm;
}
