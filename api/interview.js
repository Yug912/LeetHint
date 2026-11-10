// api/interview.js
// Mock Interview logic that doesn't touch the DOM — parsing the interviewer's
// JSON replies and the scorecard, stage rules, and "did the code change?".
// The UI lives in sidepanel/interview.js; the prompts in shared/prompts.js.

import { callInterviewer } from './ai.js';
import { INTERVIEW_STAGES, INTERVIEW_MINUTES } from '../shared/prompts.js';

export { INTERVIEW_STAGES, INTERVIEW_MINUTES };

export const STAGE_LABELS = {
  intro: 'Intro', clarifying: 'Clarify', approach: 'Approach', coding: 'Coding',
  testing: 'Testing', complexity: 'Complexity', feedback: 'Feedback'
};

export const SIGNALS = ['Strong Hire', 'Hire', 'No Hire'];
export const SCORE_KEYS = ['problemSolving', 'communication', 'coding', 'testing'];
export const SCORE_LABELS = { problemSolving: 'Problem solving', communication: 'Communication', coding: 'Coding', testing: 'Testing' };


// ─────────────────────────────────────────────
// 1. JSON FROM A MODEL REPLY
//    Models sometimes wrap JSON in ```json fences or add a sentence around it.
//    Take the first balanced {...} object (string-aware) and parse that.
// ─────────────────────────────────────────────
export function extractJSON(text) {
  const s = String(text || '').replace(/<think>[\s\S]*?<\/think>/gi, '');
  for (let start = s.indexOf('{'); start >= 0; start = s.indexOf('{', start + 1)) {
    let depth = 0, inStr = false, esc = false;
    for (let i = start; i < s.length; i++) {
      const c = s[i];
      if (inStr) {
        if (esc) esc = false;
        else if (c === '\\') esc = true;
        else if (c === '"') inStr = false;
      } else if (c === '"') inStr = true;
      else if (c === '{') depth++;
      else if (c === '}' && --depth === 0) {
        try { return JSON.parse(s.slice(start, i + 1)); } catch { break; }
      }
    }
  }
  return null;
}

// Stages only move forward — a model that "goes back" keeps the current stage
export function nextStage(current, proposed) {
  const cur = Math.max(0, INTERVIEW_STAGES.indexOf(current));
  const next = INTERVIEW_STAGES.indexOf(proposed);
  return next > cur ? INTERVIEW_STAGES[next] : INTERVIEW_STAGES[cur];
}

// Spoken text: no markdown or code, which sound terrible when read aloud
function cleanSpoken(text) {
  return String(text || '')
    .replace(/```[\s\S]*?```/g, '')
    .replace(/[*_#`>]+/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

// → { reply, stage, hintGiven }. reply '' means "stay silent".
export function parseInterviewerReply(raw, currentStage) {
  const obj = extractJSON(raw);
  if (obj && typeof obj === 'object') {
    return {
      reply: cleanSpoken(obj.reply),
      stage: nextStage(currentStage, String(obj.stage || '').toLowerCase().trim()),
      hintGiven: obj.hintGiven === true || obj.hintGiven === 'true'
    };
  }
  // No JSON at all — plain prose is still a usable reply
  const prose = cleanSpoken(String(raw || '').replace(/[{}]/g, ''));
  return { reply: prose.length > 3 ? prose : '', stage: currentStage, hintGiven: false };
}

// → { problemSolving: {score, comment}, ..., signal, improvements[3] } or null
export function parseScorecard(raw) {
  const obj = extractJSON(raw);
  if (!obj || typeof obj !== 'object') return null;
  const card = {};
  for (const k of SCORE_KEYS) {
    const v = obj[k] || {};
    const score = Math.round(Number(typeof v === 'object' ? v.score : v));
    if (!(score >= 1 && score <= 4)) return null;
    card[k] = { score, comment: String((typeof v === 'object' && v.comment) || '').trim() };
  }
  const signal = SIGNALS.find(s => s.toLowerCase() === String(obj.signal || '').toLowerCase().trim());
  // A signal outside the three allowed values → derive it from the scores
  const avg = SCORE_KEYS.reduce((sum, k) => sum + card[k].score, 0) / SCORE_KEYS.length;
  card.signal = signal || (avg >= 3.5 ? 'Strong Hire' : avg >= 2.75 ? 'Hire' : 'No Hire');
  card.improvements = (Array.isArray(obj.improvements) ? obj.improvements : [])
    .map(s => String(s || '').trim()).filter(Boolean).slice(0, 3);
  return card;
}


// ─────────────────────────────────────────────
// 2. CODE CHANGES
//    Only a meaningful change is worth the interviewer's attention:
//    whitespace-only edits never count; otherwise at least ~20 characters
//    (or a whole new line of code) must differ.
// ─────────────────────────────────────────────
const squash = code => String(code || '').replace(/\s+/g, '');

export function codeChangedMeaningfully(before, after) {
  const a = squash(before), b = squash(after);
  if (a === b) return false;
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length, endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) { endA--; endB--; }
  const changed = Math.max(endA - start, endB - start);
  const lines = c => String(c || '').split('\n').filter(l => l.trim()).length;
  return changed >= 20 || (Math.abs(lines(after) - lines(before)) >= 1 && changed >= 6);
}


// ─────────────────────────────────────────────
// 3. HIDDEN REFERENCE — the verified solution from the hints, so the
//    interviewer can judge approaches and code accurately
// ─────────────────────────────────────────────
export function referenceFromHints(hints) {
  if (!hints || hints.generating) return null;
  const code = String(hints.hint5 || '').match(/```\w*\n([\s\S]*?)```/)?.[1]?.trim() || '';
  const approach = String(hints.hint5 || '').match(/Approach:\s*([^\n]+)/)?.[1]?.trim() || '';
  if (!code && !approach) return null;
  return { code, approach, tc: hints.optimal_tc || '', sc: hints.optimal_sc || '', pattern: hints.pattern || '' };
}


// ─────────────────────────────────────────────
// 4. GUARDS — models sometimes name the technique when pushed for a hint, or
//    repeat an earlier question. Such a reply is asked for again once.
// ─────────────────────────────────────────────

// Words that give a technique away — only checked before coding, and only if
// the candidate (or the problem statement) hasn't used the word already
const TECHNIQUE_TERMS = [
  /sliding[- ]window/i, /\bwindow\b/i, /two[- ]pointers?/i, /both ends/i,
  /hash ?(map|table|set)/i, /\bhash(ing)?\b/i, /dictionar(y|ies)/i, /\bmap\b/i, /complement/i,
  /dynamic programming/i, /\bdp\b/i, /memoi[sz]/i, /\bmemo\b/i, /tabulation/i, /bottom[- ]up/i, /top[- ]down/i,
  /binary search/i, /\bheap\b/i, /priority queue/i, /monotonic/i, /\bstack\b/i,
  /prefix (sums?|max(imum)?|min(imum)?)/i, /suffix (sums?|max(imum)?|min(imum)?)/i,
  /\bbfs\b/i, /breadth[- ]first/i, /\bdfs\b/i, /depth[- ]first/i, /backtrack/i,
  /union[- ]find/i, /disjoint set/i, /\btrie\b/i, /topological/i, /greedy/i
];
// Pattern names too generic to count as a giveaway on their own
const PLAIN_TOPICS = /^(array|arrays|string|strings|math|matrix|simulation|unknown|design|other)$/i;
const PRE_CODING = ['intro', 'clarifying', 'approach'];
const escapeRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export function leakedTerms(reply, { problem = {}, history = [], reference } = {}) {
  const said = [problem.title, problem.description,
                ...history.filter(h => h.role === 'candidate').map(h => h.text)].join('\n');
  const terms = [...TECHNIQUE_TERMS];
  for (const part of String(reference?.pattern || '').split(/[,/&+]|\band\b/)) {
    const p = part.trim();
    if (p.length > 2 && !PLAIN_TOPICS.test(p)) terms.push(new RegExp(escapeRe(p), 'i'));
  }
  return terms.filter(re => re.test(reply) && !re.test(said)).map(re => reply.match(re)[0]);
}

// Nearly the same words as one of the interviewer's recent lines
const wordSet = s => new Set(String(s).toLowerCase().match(/[a-z0-9']+/g) || []);
export function repeatsEarlier(reply, history = []) {
  const w = wordSet(reply);
  if (w.size < 4) return false;
  return history.filter(h => h.role === 'interviewer').slice(-6).some(h => {
    const o = wordSet(h.text);
    let common = 0;
    for (const x of w) if (o.has(x)) common++;
    return common / Math.max(w.size, o.size) >= 0.8;
  });
}

// Spoken when a second draft still names the technique
const SAFE_HINT = "I can't give the technique away, but look at what work your current approach keeps repeating. How could you avoid doing that work twice?";


// ─────────────────────────────────────────────
// 5. SERVER CALLS
// ─────────────────────────────────────────────

const spoken = session => session.history
  .filter(h => h.role === 'interviewer' || h.role === 'candidate')
  .map(h => ({ role: h.role, text: h.text }));

// The editor code is worth sending once it differs from the starter template,
// or when the interviewer is judging code (coding → feedback). Before that
// it's only the template — leaving it out keeps early turns small.
const CODE_STAGES = ['coding', 'testing', 'complexity', 'feedback'];
export function codeWorthSending(session, code) {
  if (!code) return false;
  return CODE_STAGES.includes(session.stage) || codeChangedMeaningfully(session.starterCode || '', code);
}

// Only what the server reads. Once there is a running summary, only it and
// the last 4 turns go (contract item 9) — every request stays small.
export const RECENT_TURNS = 4;
export function interviewPayload(session, event, code, reference, { full = false } = {}) {
  const history = spoken(session);
  const summarised = !full && session.summary;
  return {
    interviewId: session.interviewId || undefined,
    durationMin: session.durationMin || INTERVIEW_MINUTES,
    event,
    stage: session.stage,
    elapsedSec: Math.floor((Date.now() - session.startedAt) / 1000),
    hintsGiven: session.hintsGiven,
    code: full || codeWorthSending(session, code) ? code || '' : '',
    ...(summarised ? { summary: session.summary.slice(0, 1500) } : {}),
    history: summarised ? history.slice(-RECENT_TURNS)
           : history.length > 80 ? [...history.slice(0, 2), ...history.slice(-78)] : history,
    reference: reference || undefined
  };
}

// Every 6 interviewer turns, the transcript so far is folded into a 5-line
// summary (interview_summary). → the new summary, or null if not due / failed
export const SUMMARY_EVERY = 6;
export function summaryDue(session) {
  const asked = session.history.filter(h => h.role === 'interviewer').length;
  return asked > 0 && asked % SUMMARY_EVERY === 0 && asked !== session.summaryAt;
}

// Only the turns since the last summary are sent, with that summary
export async function summarise(problem, session) {
  const asked = session.history.filter(h => h.role === 'interviewer').length;
  const turns = spoken(session);
  const text = await callInterviewer('interview_summary', problem, {
    interviewId: session.interviewId || undefined, durationMin: session.durationMin,
    stage: session.stage, summary: session.summary || '', history: turns.slice(session.summaryUpTo || 0)
  });
  const summary = String(text || '').replace(/<think>[\s\S]*?<\/think>/gi, '').trim().slice(0, 1500);
  return summary ? { summary, summaryAt: asked, summaryUpTo: turns.length } : null;
}

// Ending early: a fast candidate who has covered everything gets the
// scorecard instead of recycled questions. The prompt asks for this; these
// limits make sure of it even when the model keeps going.
const WRAP_UP = "That covers everything I wanted to ask. Great work, thanks for walking me through it. Your scorecard is ready.";
const MOVE_ON = "Okay, let's move on. What are the time and space complexity of your code?";
// Interviewer lines per late stage before moving on. Complexity: the
// complexity question, a possible correction, up to two follow-ups. Testing:
// a trace, a correction or edge case, a re-trace.
export const MAX_COMPLEXITY_TURNS = 4;
export const MAX_TESTING_TURNS = 4;
const LIMITS = { testing: MAX_TESTING_TURNS, complexity: MAX_COMPLEXITY_TURNS };
// Testing → on to complexity; complexity → the scorecard
const moveOn = stage => stage === 'testing'
  ? { reply: MOVE_ON, stage: 'complexity', hintGiven: false }
  : { reply: WRAP_UP, stage: 'feedback', hintGiven: false };

export function overstaying(session) {
  const limit = LIMITS[session.stage];
  return !!limit && session.history.filter(h => h.role === 'interviewer' && h.stage === session.stage).length >= limit;
}

export async function interviewerTurn(problem, session, event, { code, reference } = {}) {
  const payload = interviewPayload(session, event, code, reference);
  const ask = async extra => parseInterviewerReply(
    await callInterviewer('interview_turn', problem, { ...payload, ...extra }), session.stage);
  const problemOf = r => !r.reply ? null
    : PRE_CODING.includes(session.stage) && leakedTerms(r.reply, { problem, history: session.history, reference }).length ? 'leak'
    : repeatsEarlier(r.reply, session.history) ? 'repeat' : null;
  // Still in the same late stage past its limit → move on (the model's own
  // move to a later stage is kept)
  const done = r => r.stage === session.stage && event === 'answer' && overstaying(session) ? moveOn(session.stage) : r;

  const first = await ask();
  const reason = problemOf(first);
  if (!reason) return done(first);
  console.warn(`LeetHint: interviewer reply rejected (${reason}) — asking again`);
  let second = null;
  try { second = await ask({ rejected: { reason, draft: first.reply } }); } catch { /* keep the first draft below */ }
  const again = second && problemOf(second);
  if (second && !again) return done(second);
  // Still leaking → a safe nudge instead
  if ((again || reason) === 'leak') return { ...first, reply: SAFE_HINT, hintGiven: true };
  // Still repeating once the code is written → nothing new is left to ask in
  // this stage: move on instead of asking the same thing again
  if (LIMITS[session.stage]) return moveOn(session.stage);
  return done(second || first);
}

export async function scoreInterview(problem, session, { code, reference } = {}) {
  // The scorecard is graded once — it gets the whole transcript and the code
  const payload = interviewPayload(session, 'answer', code, reference, { full: true });
  payload.elapsedSec = Math.floor(((session.endedAt || Date.now()) - session.startedAt) / 1000);
  let card = parseScorecard(await callInterviewer('interview_score', problem, payload));
  if (!card) card = parseScorecard(await callInterviewer('interview_score', problem, payload));   // one retry
  if (!card) throw new Error('The scorecard could not be read — please retry.');
  return card;
}
