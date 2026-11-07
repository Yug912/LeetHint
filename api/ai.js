// api/ai.js
// Everything the side panel needs from the AI — with ZERO configuration:
// requests go to the LeetHint backend (backend/), which holds the API keys.
// No key, secret or prompt-provider detail ever lives in the extension.
//
// Pipeline — ONE streamed request per problem:
//   the model solves the problem in its reasoning, then replies with
//   approach + TC/SC → Hints 1-4 → C++ code.
// Hints, solution and complexity therefore always describe the SAME algorithm,
// and hints are shown as soon as each one finishes streaming.
//
// Fallback when the backend can't be reached: Chrome Built-in AI (hints only).
//
// Where an answer comes from — route(), in this order:
//   the panel's local cache (sidepanel.js) → the static hint file (hints only,
//   CACHE_URL) → the user's own API key if set (api/direct.js) → the Worker.

import { BACKEND_URL, CACHE_URL } from './config.js';
import { buildHintsPrompt, LANGUAGES, snippetNames } from '../shared/prompts.js';
import { getOwnKey, callDirect } from './direct.js';

export { LANGUAGES };

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
// 1. PARSING the model reply (---TAG--- delimited sections)
// ─────────────────────────────────────────────

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

// Streaming: the hints written so far. Finished hints are complete; the one
// being written right now is included too (partial.streaming names it), so
// the user can read along instead of waiting for the whole section.
function parsePartialHints(raw) {
  // An unclosed <think> block is reasoning still in progress — not answer text
  const text = cleanModelText(raw).replace(/<think>[\s\S]*$/i, '');
  const finished = tag => {
    const m = text.match(new RegExp(`---\\s*${tag}\\s*---`, 'i'));
    return !!m && /---\s*[A-Z][A-Z0-9_]*\s*---/i.test(text.slice(m.index + m[0].length));
  };
  const partial = { hint1: '', hint2: '', hint3: '', hint4: '', optimal_tc: '', optimal_sc: '', sc_breakdown: '', pattern: '', streaming: '' };
  for (const n of [1, 2, 3, 4]) {
    const tag = `HINT${n}`;
    if (finished(tag)) {
      partial[`hint${n}`] = extractUntilNext(text, tag);
    } else if (new RegExp(`---\\s*${tag}\\s*---`, 'i').test(text)) {
      // Drop a half-typed delimiter at the very end ("---HI")
      partial[`hint${n}`] = extractUntilNext(text, tag).replace(/-{1,3}\s*[A-Z0-9_]*$/i, '').trimEnd();
      partial.streaming = `hint${n}`;
    }
  }
  if (finished('PATTERN')) {
    // TC / SC / SC_BREAKDOWN come before PATTERN, so they are complete too
    const ref = parseSolutionResponse(raw);
    Object.assign(partial, { optimal_tc: ref.tc, optimal_sc: ref.sc, sc_breakdown: ref.scBreakdown, pattern: ref.pattern });
  }
  return partial;
}

// ---FOLLOWUPS--- → [{ q, a }] (up to 3). Missing section (older prompt, or
// the Chrome Built-in AI fallback) → []
export function parseFollowUps(raw) {
  const section = extractUntilNext(cleanModelText(raw), 'FOLLOWUPS');
  const pairs = [];
  for (const m of section.matchAll(/(?:^|\n)\s*\**Q\d*\**\s*[:.)]\s*([\s\S]*?)\n\s*\**A\d*\**\s*[:.)]\s*([\s\S]*?)(?=\n\s*\**Q\d*\**\s*[:.)]|$)/gi)) {
    const q = m[1].trim(), a = m[2].trim();
    if (q && a) pairs.push({ q, a });
  }
  return pairs.slice(0, 3);
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

  const pattern = extractUntilNext(text, 'PATTERN') || 'Unknown';

  return { hint1, hint2, hint3, hint4, hint5: '', optimal_tc, optimal_sc, pattern, followUps: parseFollowUps(text) };
}


// ─────────────────────────────────────────────
// 2. BACKEND CLIENT
//    action: 'hints' | 'solve' | 'fix'. The server builds the prompt from the
//    problem data and streams back the model's reply as plain text.
// ─────────────────────────────────────────────

// Only the fields the server uses — keeps requests small
function problemPayload(p) {
  return {
    slug: p.slug, title: p.title, problemNumber: String(p.problemNumber || ''),
    difficulty: p.difficulty, description: p.description, cppSnippet: p.cppSnippet || '',
    topicTags: p.topicTags || [], officialHints: p.officialHints || []
  };
}

// ── Anonymous install ID (X-LeetHint-Install) ──
// One random UUID per install, kept in chrome.storage.local as installId. The
// service worker creates it on install; this creates it too when the side
// panel happens to run first. Outside the extension (tools/prefill.mjs) there
// is no ID, and the server then treats the request like an old version's.
let installIdPromise = null;
export function getInstallId() {
  if (typeof chrome === 'undefined' || !chrome.storage?.local) return Promise.resolve('');
  installIdPromise ||= (async () => {
    try {
      const { installId } = await chrome.storage.local.get('installId');
      if (installId) return installId;
      const id = crypto.randomUUID();
      await chrome.storage.local.set({ installId: id });
      return id;
    } catch {
      return '';
    }
  })();
  return installIdPromise;
}

export async function backendHeaders(extra = {}) {
  const id = await getInstallId();
  return { ...extra, ...(id ? { 'X-LeetHint-Install': id } : {}) };
}

// ── Waiting line ──
// "busy" (every AI provider at its limit): wait the server's Retry-After, then
// 10 s, 20 s, 40 s, 60 s between tries — up to 3 minutes in all, after which
// the caller falls back (hints: Chrome's built-in AI, as before).
export const WAIT = { maxMs: 3 * 60 * 1000, sleep: ms => new Promise(r => setTimeout(r, ms)), now: () => Date.now() };

export function nextWaitMs(tries, retryAfterSec) {
  const steps = [10, 20, 40, 60];
  const sec = tries === 0 ? (retryAfterSec > 0 ? retryAfterSec : 10) : steps[Math.min(tries - 1, steps.length - 1)];
  return Math.min(60, Math.max(1, sec)) * 1000;
}

// A server reply that isn't the answer → an Error with a message for the user.
// code: busy | rate_limited | trial_used | blocked | (none)
export function serverError(status, body = {}) {
  const err = new Error(body.message || body.error || `LeetHint server error (${status})`);
  err.status = status;
  err.code = typeof body.error === 'string' && /^[a-z_]+$/.test(body.error) ? body.error : '';
  if (err.code === 'busy') {
    err.message = 'High demand — every free AI model is busy right now.';
    err.retryAfter = Number(body.retryAfter) || 20;
    err.position = Number(body.position) || 0;
  } else if (err.code === 'rate_limited') {
    err.message = 'Too many requests — try again in a minute.';
  } else if (err.code === 'trial_used') {
    err.action = body.action;
    err.resetsAt = body.resetsAt;
    const when = body.resetsAt ? new Date(body.resetsAt) : null;
    const back = when && !isNaN(when)
      ? (body.action === 'interview'
          ? when.toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric' })
          : `at ${when.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}`)
      : 'later';
    err.message = body.action === 'interview'
      ? `This week's free mock interview is used up. Add a free key in 2 minutes, or come back ${back}.`
      : `Free trials are used up for today. Add a free key in 2 minutes, or come back ${back}.`;
  } else if (err.code === 'blocked') {
    err.message = 'LeetHint can’t answer requests from this browser right now.';
  }
  return err;
}

// One answer for an action, from the user's own key or the Worker.
// Every caller in the extension goes through here.
// opts.onWait({ position, waitSec }) is told while it waits in line.
export async function route(action, problem, opts = {}) {
  const ownKey = await getOwnKey();
  if (!ownKey) return callBackend(action, problem, opts);
  const text = await callDirect(action, problemPayload(problem), opts, ownKey);
  if (text.trim()) return text;
  if (!opts.lowEffort) return route(action, problem, { ...opts, lowEffort: true });   // all thinking, no answer
  throw new Error('The AI returned an empty reply — please retry.');
}

// onText(fullTextSoFar) is called as the reply streams in
async function callBackend(action, problem, opts = {}) {
  const { code = '', onText, onWait, language, snippet, languages, snippets, interview, failure, reason, lowEffort = false } = opts;
  const body = JSON.stringify({ action, problem: problemPayload(problem), code, language, snippet, languages, snippets,
                                interview, failure, reason, lowEffort });
  const headers = await backendHeaders({ 'Content-Type': 'application/json' });
  const startedAt = WAIT.now();
  let res;
  for (let tries = 0; ; tries++) {
    try {
      res = await fetch(`${BACKEND_URL}/v1/generate`, {
        method: 'POST', headers, body,
        signal: AbortSignal.timeout(180000)   // reasoning models can think for a while
      });
    } catch (e) {
      const err = new Error('Could not reach the LeetHint server — check your connection.');
      err.offline = true;
      throw err;
    }
    if (res.ok) break;
    const err = serverError(res.status, await res.json().catch(() => ({})));
    // Busy → wait in line, then try again (never for rate_limited/trial_used)
    if (err.code !== 'busy') throw err;
    const waitMs = nextWaitMs(tries, err.retryAfter);
    if (WAIT.now() - startedAt + waitMs > WAIT.maxMs) throw err;
    onWait?.({ position: err.position, waitSec: Math.round(waitMs / 1000) });
    await WAIT.sleep(waitMs);
  }

  console.log(`LeetHint: ${action} reply (${res.headers.get('X-LeetHint-Cache') || '?'}, ${res.headers.get('X-LeetHint-Model') || 'cache'})`);
  const text = await readAnswerStream(res, res.headers.get('X-LeetHint-Format') || 'openai', onText);

  if (!text.trim()) {
    // The model spent its whole token budget thinking — ask again with less thinking
    if (!lowEffort) {
      console.warn(`LeetHint: ${action} reply had no answer text — retrying with low reasoning`);
      return callBackend(action, problem, { ...opts, lowEffort: true });
    }
    throw new Error('The AI returned an empty reply — please retry.');
  }
  return text;
}

// The server passes the provider's Server-Sent Events through untouched;
// pull the answer text out of them. kind: 'openai' (OpenAI-style chat
// chunks: Groq, Cerebras, OpenRouter), 'workersai' or 'gemini'. Reasoning is ignored.
export async function readAnswerStream(res, kind, onText) {
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '', text = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let changed = false, nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line.startsWith('data:')) continue;   // keep-alive comments etc.
      const data = line.slice(5).trim();
      if (!data || data === '[DONE]') continue;
      let ev;
      try { ev = JSON.parse(data); } catch { continue; }
      if (ev.error) {
        if (!text) throw new Error('The AI service stopped unexpectedly — please retry.');
        continue;
      }
      const piece = kind === 'gemini'
        ? (ev.candidates?.[0]?.content?.parts || []).filter(p => !p.thought).map(p => p.text || '').join('')
        : (ev.choices?.[0]?.delta?.content ?? ev.response);   // Workers AI may use either shape
      if (piece) { text += piece; changed = true; }
    }
    if (changed) onText?.(text);
  }
  return text;
}

// Mock interview: one interviewer turn, the final scorecard or a summary.
// action: 'interview_turn' | 'interview_score' | 'interview_summary'; returns the raw model text
export function callInterviewer(action, problem, interview) {
  return route(action, problem, { interview });
}

// "Report wrong hint" → POST /v1/report (contract item 7). → true when the
// server took it; false when it couldn't (an older Worker without /v1/report,
// offline) — the panel then just hides the link, never shows an error.
export async function reportHint({ slug, promptVersion, reason, note = '' }) {
  try {
    const res = await fetch(`${BACKEND_URL}/v1/report`, {
      method: 'POST',
      headers: await backendHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ slug, promptVersion, reason, note: String(note).slice(0, 500) }),
      signal: AbortSignal.timeout(8000)
    });
    return res.ok;
  } catch {
    return false;
  }
}

// Is the backend up, and which providers does it have? (names only)
export async function checkBackend() {
  try {
    const res = await fetch(`${BACKEND_URL}/health`, { headers: await backendHeaders(), signal: AbortSignal.timeout(5000) });
    return res.ok ? await res.json() : { ok: false };
  } catch {
    return { ok: false };
  }
}


// ─────────────────────────────────────────────
// 3. CHROME BUILT-IN AI FALLBACK (no server — hints only)
// ─────────────────────────────────────────────

async function generateWithBuiltinAI(prompt) {
  const AIModel = globalThis.LanguageModel || globalThis.ai?.languageModel;
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
// 4. Attach the solved code + its TC/SC to the hints
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
  // The parts on their own (the pre-fill script writes them to static files)
  result.solution = { code: reference.code, approach: reference.approach, tc: reference.tc, sc: reference.sc };
  return result;
}


// A complete hints reply → the object the side panel shows (no network).
// Used by tools/export-d1.mjs to turn cached replies into static files.
export function parseHintsReply(raw) {
  const result = parseHintsJSON(raw);
  const reference = parseSolutionResponse(raw);
  return reference.code ? applyReference(result, reference) : result;
}


// ─────────────────────────────────────────────
// 4b. STATIC HINT FILES — https://leethint.pages.dev/cache/<slug>.json
//     Generated once per problem by tools/prefill.mjs (compile-checked, with
//     the exact LeetCode signature), so reading one costs no AI call at all.
// ─────────────────────────────────────────────

// The file (shared contract item 1) → the object the side panel already shows
export function mapStaticFile(file) {
  if (!file || !Array.isArray(file.hints) || file.hints.length < 4 || !file.code?.cpp) return null;
  const { cpp, ...others } = file.code;
  const note = [file.approach, file.tc && `TC ${file.tc}`, file.sc && `SC ${file.sc}`].filter(Boolean).join(' · ');
  return {
    hint1: file.hints[0], hint2: file.hints[1], hint3: file.hints[2], hint4: file.hints[3],
    hint5: '```cpp\n' + cpp + '\n```\n' + (note ? `Approach: ${note}` : ''),
    optimal_tc: file.tc || '', optimal_sc: file.sc || '', sc_breakdown: file.spaceBreakdown || '',
    pattern: file.pattern || '',
    translations: Object.fromEntries(Object.entries(others).filter(([l, c]) => LANGUAGES[l] && c)),
    followUps: Array.isArray(file.followUps) ? file.followUps.filter(f => f?.q && f?.a).slice(0, 3) : [],
    solution: { code: cpp, approach: file.approach || '', tc: file.tc || '', sc: file.sc || '' },
    source: 'static',
    promptVersion: file.promptVersion || ''
  };
}

// → the mapped file, or null on any error / 404 / 4 s timeout (then the Worker
// is asked exactly as before). An older promptVersion is still used.
export async function fetchStaticHints(slug) {
  if (!slug || !/^[a-z0-9-]+$/.test(slug)) return null;
  try {
    const res = await fetch(`${CACHE_URL}/cache/${slug}.json`, { signal: AbortSignal.timeout(4000) });
    if (!res.ok) return null;
    return mapStaticFile(await res.json());
  } catch {
    return null;
  }
}


// ─────────────────────────────────────────────
// 5. MAIN EXPORT — generateHints()
// ─────────────────────────────────────────────

// onPartial(partialHints) is called each time the visible hint text changes.
// language: the user's own solution language — when it isn't C++, the same
// reply also contains the solution in that language (no second request).
// Any other language is translated from the C++ only when it's picked.
// onWait({ position, waitSec }): the request is waiting in line (server busy)
export async function generateHints(problemData, { onPartial, onWait, language = 'cpp' } = {}) {
  console.log('LeetHint: generateHints() called for:', problemData.title);

  // A static file → instant, and already signature-checked
  const fromFile = await fetchStaticHints(problemData.slug);
  if (fromFile) {
    console.log(`LeetHint: hints from the static file (${fromFile.promptVersion || '?'})`);
    onPartial?.({ ...fromFile, streaming: '' });
    return fromFile;
  }

  // Report every change to the visible hint text, so hints appear as they're written
  let lastShown = '';
  const onText = onPartial && (soFar => {
    const partial = parsePartialHints(soFar);
    const shown = [partial.hint1, partial.hint2, partial.hint3, partial.hint4, partial.optimal_tc].join('\u0000');
    if (shown !== lastShown) { lastShown = shown; onPartial(partial); }
  });

  const also = withLanguage(problemData, language);

  try {
    let raw = await route('hints', problemData, { onText, onWait, ...also });
    let result;
    try {
      result = parseHintsJSON(raw);
    } catch {
      // The model thought so long the reply was cut off before the hints were
      // complete (seen on Hard problems) — ask once more with less thinking
      console.warn('LeetHint: hints reply incomplete — retrying with low reasoning');
      raw = await route('hints', problemData, { onText, onWait, ...also, lowEffort: true });
      result = parseHintsJSON(raw);
    }
    let reference = parseSolutionResponse(raw);
    let codeRaw = raw;
    if (!reference.code) {
      // Hints arrived but the code didn't (reply ran out of tokens — the code
      // comes last). A solution-only reply is much shorter, so ask for just that.
      console.warn('LeetHint: reply had no code — requesting solution separately');
      try {
        codeRaw = await route('solve', problemData, { ...also, onWait });
        reference = parseSolutionResponse(codeRaw);
      } catch (e) {
        console.warn('LeetHint: separate solution request failed →', e.message);
      }
    }
    if (reference.code) reference = await ensureSignature(reference, problemData);
    // The user's language, written in the same reply as the C++. A reply the
    // server shared from another user may not have it — then it's translated
    // when the solution card opens.
    if (also.language) {
      const translated = extractLanguageSection(codeRaw, also.language);
      // Wrong function name → leave it out; it's re-translated when the card opens
      if (translated && keepsSignature(translated, also.snippet)) result.translations = { [also.language]: translated };
    }
    console.log('LeetHint: FINAL TC =', reference.tc || result.optimal_tc, '| SC =', reference.sc || result.optimal_sc);
    return reference.code ? applyReference(result, reference) : result;
  } catch (e) {
    console.warn('LeetHint: server generation failed →', e.message);
    // These are answers, not outages: show them instead of the offline AI
    if (e.code === 'rate_limited' || e.code === 'trial_used' || e.code === 'blocked' || e.ownKey) throw e;
    // Server unreachable or failing → Chrome Built-in AI can still give hints
    try {
      return await generateWithBuiltinAI(buildHintsPrompt(problemData));
    } catch (builtinErr) {
      console.warn('LeetHint: Built-in AI unavailable →', builtinErr.message);
      throw e;   // the server's message is the useful one
    }
  }
}


// ─────────────────────────────────────────────
// 6. SOLUTION VALIDATOR — "🔧 Fix" / "Generate Solution" buttons
//    With code: the server debugs it. Without: it solves from scratch.
// ─────────────────────────────────────────────

// Returns { code, tc, sc, scBreakdown, ... } — complexity describes the RETURNED code
// failure: optional — the failing test or compile error LeetCode reported
export async function validateSolutionCode(code, problem, failure = '') {
  // (no language option here — Fix/Generate produce the C++ reference only)
  const solved = parseSolutionResponse(await route(code ? 'fix' : 'solve', problem, { code, failure: failure || undefined }));
  if (!solved.code) throw new Error('The AI returned no code — please retry.');
  return code ? solved : ensureSignature(solved, problem);
}


// ─────────────────────────────────────────────
// 6b. SIGNATURE CHECK — the #1 reason a "correct" solution fails on LeetCode
//     is a renamed class/method or changed parameters. Compare against
//     LeetCode's own C++ starter code and auto-fix once if anything is off.
// ─────────────────────────────────────────────

// Class name + every method name in LeetCode's starter code
function signatureNames(snippet) {
  const code = String(snippet || '')
    .replace(/\/\*[\s\S]*?\*\//g, '')     // ListNode/TreeNode definitions live in comments
    .replace(/\/\/.*$/gm, '');
  const cls = code.match(/class\s+(\w+)/)?.[1] || '';
  const methods = [...code.matchAll(/(\w+)\s*\(/g)].map(m => m[1])
    .filter(n => !['if', 'for', 'while', 'switch', 'return', 'sizeof'].includes(n));
  return { cls, methods: [...new Set(methods)] };
}

export function missingSignatureParts(code, snippet) {
  const { cls, methods } = signatureNames(snippet);
  const missing = [];
  if (cls && !new RegExp(`class\\s+${cls}\\b`).test(code)) missing.push(`class ${cls}`);
  for (const m of methods) if (!new RegExp(`\\b${m}\\s*\\(`).test(code)) missing.push(`${m}()`);
  return missing;
}

async function ensureSignature(reference, problem) {
  if (!problem.cppSnippet) return reference;
  const missing = missingSignatureParts(reference.code, problem.cppSnippet);
  if (!missing.length) return reference;

  console.warn('LeetHint: solution does not match LeetCode signature (missing', missing.join(', '), ') — fixing');
  try {
    // reason: 'signature' → the server caches this fix for everyone (the code
    // came from the shared cache, so every user would send the same request)
    const fixed = parseSolutionResponse(await route('fix', problem, { code: reference.code, reason: 'signature' }));
    if (fixed.code && missingSignatureParts(fixed.code, problem.cppSnippet).length < missing.length) {
      return { ...reference, ...fixed, approach: reference.approach, pattern: reference.pattern };
    }
  } catch (e) {
    console.warn('LeetHint: signature fix failed →', e.message);
  }
  return reference;
}


// ─────────────────────────────────────────────
// 6c. TRANSLATION — the verified C++ solution in another language
// ─────────────────────────────────────────────

// Code inside the CODE section's fence, for any language (no C++ clean-up)
function extractAnyFence(raw) {
  const text = cleanModelText(raw);
  const section = extractUntilNext(text, 'CODE') || text;
  const m = section.match(/```[\w#+-]*\s*\n?([\s\S]*?)```/);
  return (m ? m[1] : '').trim();
}

// Does the translated code still define every name LeetCode will call?
function keepsSignature(code, snippet) {
  return snippetNames(snippet).every(n => new RegExp(`\\b${n}\\b`).test(code));
}

// { language, snippet } for the request when the user's language isn't C++
function withLanguage(problem, language) {
  if (!language || language === 'cpp' || !LANGUAGES[language]) return {};
  return { language, snippet: problem.codeSnippets?.[language] || '' };
}

// The ---CODE_PYTHON3--- (etc.) section of a reply, as plain code
function extractLanguageSection(raw, language) {
  const section = extractUntilNext(cleanModelText(raw), `CODE_${language.toUpperCase()}`);
  const m = section.match(/```[\w#+-]*\s*\n?([\s\S]*?)```/);
  return (m ? m[1] : '').trim();
}

// One language at a time, only when it's needed. The C++ it starts from is
// the same for every user (it comes from the shared hints cache), so each
// translation is generated once and then served from the server cache too.
export async function translateSolution(cppCode, problem, language) {
  const snippet = problem.codeSnippets?.[language] || '';
  const raw = await route('translate', problem, { code: cppCode, language, snippet });
  const code = extractAnyFence(raw);
  if (!code) throw new Error('The AI returned no translated code — please retry.');
  return code;
}


// ─────────────────────────────────────────────
// 7. TC/SC COMPARISON — smart matching
// ─────────────────────────────────────────────

// Canonical big-O form so equivalent answers match:
//   "m+n" = "n + m", "n^2" = "n²" = "n*n" = "n2", "mn" = "n × m",
//   "n log(n)" = "nlogn", "log2 n" = "lg n" = "log n", "sqrt(n)" = "√n" = "n^0.5",
//   "2n" = "n/2" = "n", "log² n" = "(log n)^2", "constant" = "1",
//   and lower-order terms vanish: "n² + n" = "n²", "n + log n" = "n".
// Each variable is one letter (LeetCode complexities use n, m, k, V, E, h ...
// so "mn" means m·n).
//
// A term is { pow: {var: exponent}, logs: {arg: exponent}, other: [text] }:
// powers and logs can be compared for dominance; anything else (2^n, n!,
// min(m,n), (n+m)^2) must match exactly.

const SUPERSCRIPTS = { '⁰': '0', '¹': '1', '²': '2', '³': '3', '⁴': '4', '⁵': '5', '⁶': '6', '⁷': '7', '⁸': '8', '⁹': '9', 'ⁿ': 'n', 'ᵐ': 'm', 'ᵏ': 'k' };

const WORDS = { constant: '1', linear: 'n', linearithmic: 'nlogn', quadratic: 'n^2', cubic: 'n^3', logarithmic: 'logn' };

function normalizeComplexity(input) {
  let s = String(input || '').trim();
  // Unwrap O(...) / Θ(...) / Ω(...) if the user or model included it
  const m = s.match(/^[OoΘθΩ]\s*\(([\s\S]*)\)$/);
  if (m) s = m[1];

  s = s.toLowerCase()
    .replace(/\b(constant|linearithmic|linear|quadratic|cubic|logarithmic)\b(\s+time|\s+space)?/g, w => WORDS[w.split(/\s/)[0]])
    .replace(/[⁰¹²³⁴⁵⁶⁷⁸⁹ⁿᵐᵏ]+/g, sup => '^' + [...sup].map(c => SUPERSCRIPTS[c]).join(''))
    .replace(/√\s*(\w)/g, 'sqrt($1)')
    .replace(/\blg\b/g, 'log')
    .replace(/log\s*_?\s*(2|10|e)(?=\s|\()/g, 'log')   // log2 n, log_2(n) → log
    .replace(/\bln\b/g, 'log')
    .replace(/\*\*/g, '^')
    .replace(/\s*\/\s*\d+(\.\d+)?/g, '')                  // n/2 → n (constant divisor)
    .replace(/(^|[^a-z])([a-z])(\d+)(?![\d.])/g, '$1$2^$3') // n2 → n^2 (after log2 is gone)
    .replace(/[\s*×·⋅.]/g, (c, i, str) => (c === '.' && /\d/.test(str[i + 1] || '')) ? c : '');

  try {
    return sumKey(canonSum(s, { i: 0 }));
  } catch {
    return s; // unparseable → plain string compare
  }
}

const emptyTerm = () => ({ pow: {}, logs: {}, other: [] });

function termKey(t) {
  const parts = [
    ...Object.entries(t.pow).filter(([, e]) => e !== 0).map(([b, e]) => e === 1 ? b : `${b}^${e}`),
    ...Object.entries(t.logs).filter(([, e]) => e !== 0).map(([a, e]) => e === 1 ? `log(${a})` : `log(${a})^${e}`),
    ...t.other
  ].sort();
  return parts.length ? parts.join('*') : '1';
}

const sumKey = terms => terms.map(termKey).sort().join('+') || '1';

// Is term a asymptotically ≤ term b (so a disappears from a + b)?
function dominatedBy(a, b) {
  if (termKey(a) === termKey(b)) return false;
  if (a.other.slice().sort().join() !== b.other.slice().sort().join()) return false;
  for (const [v, e] of Object.entries(a.pow)) if ((b.pow[v] || 0) < e) return false;
  for (const [arg, e] of Object.entries(a.logs)) {
    if ((b.logs[arg] || 0) >= e) continue;
    // log n is smaller than any extra power of n: n > log n, n² > n·log n
    if (/^[a-z]$/.test(arg) && (b.pow[arg] || 0) > (a.pow[arg] || 0)) continue;
    return false;
  }
  for (const [arg, e] of Object.entries(b.logs)) if ((a.logs[arg] || 0) > e) return false;
  return true;
}

// sum := product ('+' product)*  — lower-order terms are dropped
function canonSum(s, pos, stopAt = '') {
  const terms = [];
  while (pos.i < s.length && s[pos.i] !== stopAt) {
    if (s[pos.i] === '+') { pos.i++; continue; }
    terms.push(canonProduct(s, pos, stopAt));
  }
  const unique = [...new Map(terms.map(t => [termKey(t), t])).values()];
  const kept = unique.filter(a => !unique.some(b => dominatedBy(a, b)));
  return kept.length ? kept : [emptyTerm()];
}

function mergeInto(t, f, k = 1) {
  for (const [v, e] of Object.entries(f.pow)) t.pow[v] = (t.pow[v] || 0) + e * k;
  for (const [a, e] of Object.entries(f.logs)) t.logs[a] = (t.logs[a] || 0) + e * k;
  for (let i = 0; i < k; i++) t.other.push(...f.other);
}

// product := factor+   (stops at '+', a closing paren, or the end)
function canonProduct(s, pos, stopAt) {
  const t = emptyTerm();
  while (pos.i < s.length && s[pos.i] !== '+' && s[pos.i] !== stopAt) {
    const f = canonFactor(s, pos);
    if (f) mergeInto(t, f);
  }
  return t;
}

function readExponent(s, pos) {
  if (s[pos.i] !== '^') return null;
  pos.i++;
  if (s[pos.i] === '(') {
    // n^(2) → plain numeric exponent; otherwise canonicalise the expression
    const num = s.slice(pos.i).match(/^\((\d+(\.\d+)?)\)/);
    if (num) { pos.i += num[0].length; return num[1]; }
    pos.i++; const e = sumKey(canonSum(s, pos, ')')); pos.i++; return e;
  }
  const m = s.slice(pos.i).match(/^(\d+(\.\d+)?|[a-z])/);
  if (!m) throw new Error('bad exponent');
  pos.i += m[0].length;
  return m[0];
}

const isNum = e => e !== null && /^\d/.test(e);
const single = terms => terms.length === 1 ? terms[0] : null;
const factorOf = (fields) => ({ ...emptyTerm(), ...fields });

// A single-variable term (n, n^2) → its variable, for log(n^k) = k·log n
function soleVariable(t) {
  const vars = Object.keys(t.pow).filter(v => t.pow[v] !== 0);
  return vars.length === 1 && !Object.keys(t.logs).length && !t.other.length ? vars[0] : null;
}

function canonFactor(s, pos) {
  const rest = s.slice(pos.i);

  // min(m,n) / max(m,n) — kept as one opaque factor, arguments sorted
  const mm = rest.match(/^(min|max)\(/);
  if (mm) {
    pos.i += mm[0].length;
    const args = [];
    let depth = 0, start = pos.i;
    for (; pos.i < s.length; pos.i++) {
      const c = s[pos.i];
      if (c === '(') depth++;
      else if ((c === ',' || c === ')') && depth === 0) {
        args.push(normalizeComplexity(s.slice(start, pos.i)));
        start = pos.i + 1;
        if (c === ')') break;
      } else if (c === ')') depth--;
    }
    pos.i++;
    return factorOf({ other: [`${mm[1]}(${args.sort().join(',')})`] });
  }

  // log / sqrt with "(...)" or a single atom as argument; log^2 n works too
  const fn = rest.match(/^(log|sqrt)/);
  if (fn) {
    pos.i += fn[0].length;
    const preExp = fn[1] === 'log' ? readExponent(s, pos) : null;   // log^2 n
    let argTerms;
    if (s[pos.i] === '(') { pos.i++; argTerms = canonSum(s, pos, ')'); pos.i++; }
    else argTerms = [canonFactor(s, pos) || emptyTerm()];

    if (fn[1] === 'sqrt') {
      const t = single(argTerms);
      if (t && !t.other.length) {   // sqrt(n) = n^0.5, sqrt(n log n) = n^0.5·log^0.5
        const f = emptyTerm();
        for (const [v, e] of Object.entries(t.pow)) f.pow[v] = e / 2;
        for (const [a, e] of Object.entries(t.logs)) f.logs[a] = e / 2;
        return f;
      }
      return factorOf({ other: [`(${sumKey(argTerms)})^0.5`] });
    }
    const t = single(argTerms);
    const arg = (t && soleVariable(t)) || sumKey(argTerms);   // log(n^k) = k·log n → log n
    const postExp = readExponent(s, pos);                       // log(n)^2
    const exp = preExp || postExp;
    if (exp && !isNum(exp)) return factorOf({ other: [`log(${arg})^${exp}`] });
    return factorOf({ logs: { [arg]: exp ? Number(exp) : 1 } });
  }

  // Parenthesised group: (n), (log n)^2, (n+m), (n+m)^2
  if (s[pos.i] === '(') {
    pos.i++;
    const inner = canonSum(s, pos, ')');
    pos.i++;
    const e = readExponent(s, pos);
    const t = single(inner);
    if (t && (e === null || isNum(e)) && !t.other.length) {
      const f = emptyTerm();
      mergeInto(f, t, 1);
      if (e !== null) { for (const v in f.pow) f.pow[v] *= Number(e); for (const a in f.logs) f.logs[a] *= Number(e); }
      return f;
    }
    const key = sumKey(inner);
    return factorOf({ other: [e !== null ? `(${key})^${e}` : (inner.length > 1 ? `(${key})` : key)] });
  }

  // Number: a constant multiplier (dropped), or an exponential base like 2^n
  const num = rest.match(/^\d+(\.\d+)?/);
  if (num) {
    pos.i += num[0].length;
    const e = readExponent(s, pos);
    if (e && !isNum(e)) return factorOf({ other: [`${num[0]}^${e}`] });
    return null; // constant factor — irrelevant to big-O
  }

  // Single-letter variable, optional ^exp and optional !
  if (/[a-z]/.test(s[pos.i])) {
    const v = s[pos.i++];
    const e = readExponent(s, pos);
    if (s[pos.i] === '!') { pos.i++; return factorOf({ other: [`${v}!`] }); }
    if (e === null) return factorOf({ pow: { [v]: 1 } });
    if (isNum(e)) return factorOf({ pow: { [v]: Number(e) } });
    return factorOf({ other: [`${v}^${e}`] });  // n^k, n^n
  }

  throw new Error(`unexpected "${s[pos.i]}"`);
}

export function compareComplexity(userInput, optimal) {
  const userNorm = normalizeComplexity(userInput);
  const optNorm  = normalizeComplexity(optimal);
  return userNorm === optNorm;
}
