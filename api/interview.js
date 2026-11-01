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
// 4. SERVER CALLS
// ─────────────────────────────────────────────

// Only what the server reads, and only the recent transcript (it trims
// again, oldest first) — keeps every request small
function interviewPayload(session, event, code, reference) {
  const history = session.history
    .filter(h => h.role === 'interviewer' || h.role === 'candidate')
    .map(h => ({ role: h.role, text: h.text }));
  return {
    event,
    stage: session.stage,
    elapsedSec: Math.floor((Date.now() - session.startedAt) / 1000),
    hintsGiven: session.hintsGiven,
    code: code || '',
    history: history.length > 80 ? [...history.slice(0, 2), ...history.slice(-78)] : history,
    reference: reference || undefined
  };
}

export async function interviewerTurn(problem, session, event, { code, reference } = {}) {
  const raw = await callInterviewer('interview_turn', problem, interviewPayload(session, event, code, reference));
  return parseInterviewerReply(raw, session.stage);
}

export async function scoreInterview(problem, session, { code, reference } = {}) {
  const payload = interviewPayload(session, 'answer', code, reference);
  payload.elapsedSec = Math.floor(((session.endedAt || Date.now()) - session.startedAt) / 1000);
  let card = parseScorecard(await callInterviewer('interview_score', problem, payload));
  if (!card) card = parseScorecard(await callInterviewer('interview_score', problem, payload));   // one retry
  if (!card) throw new Error('The scorecard could not be read — please retry.');
  return card;
}
