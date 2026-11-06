// sidepanel/learning.js
// Local learning features in the side panel (plans 4.1–4.6). Everything is
// stored in chrome.storage.local and nothing is sent anywhere. The logic
// lives in shared/patterns.js, shared/complexity.js and shared/insights.js.
//
//   4.1 Pattern guess   — chips before Hint 1 → patternGuesses, Stats bars
//   4.2 Confidence      — "Will you solve this without hints?" → confidenceLog
//   4.3 Tilt detector   — failed submissions / long stalls → one gentle card
//   4.4 TLE warning     — on Run/Submit and from "Check speed"
//   4.5 Déjà vu         — a similar problem you solved before
//   4.6 Streaks + CSV   — Stats tab

import { PATTERN_CHIPS, matchPattern, primaryPattern, patternAccuracy, weakPatterns } from '../shared/patterns.js';
import { tleWarning, parseMaxBound } from '../shared/complexity.js';
import { confidenceSummary, resolveConfidence, tiltReason, easierProblem, findDejaVu,
         streaks, activityDays, buildCsv } from '../shared/insights.js';
import { localDate } from '../shared/revision.js';
import { codeChangedMeaningfully } from '../api/interview.js';
import { readEditor } from './editor.js';

let ctx = null;   // { getState(), unlockNext() → bool, showToast(msg), isInterviewActive(slug) }
const $ = id => document.getElementById(id);
const el = {};

// chrome.storage helpers that never throw
async function load(keys) {
  try { return await chrome.storage.local.get(keys); } catch { return {}; }
}
async function store(obj) {
  try { await chrome.storage.local.set(obj); } catch { /* storage full or gone — feature just skips */ }
}

const MAX_LOG = 500;
const TILT_CHECK_MS = 60 * 1000;


// ─────────────────────────────────────────────
// SETUP
// ─────────────────────────────────────────────
export function initLearning(context) {
  ctx = context;
  for (const id of ['confidence-row', 'pattern-guess', 'pattern-chips', 'pattern-result', 'dejavu-row', 'dejavu-text',
                    'dejavu-open', 'dejavu-close', 'tilt-card', 'tilt-text', 'tilt-break', 'tilt-hint', 'tilt-easier',
                    'tilt-close', 'btn-check-speed', 'speed-ok', 'speed-warning', 'speed-warning-text',
                    'speed-warning-close', 'streak-current', 'streak-best', 'btn-export-csv', 'pattern-stats',
                    'pattern-bars', 'confidence-stats', 'confidence-headline', 'confidence-list', 'tilt-stats',
                    'tilt-summary', 'weak-patterns', 'hint-card-1']) {
    el[id.replace(/-(\w)/g, (_, c) => c.toUpperCase())] = $(id);
  }

  // Pattern chips
  if (el.patternChips) {
    el.patternChips.replaceChildren(...[...PATTERN_CHIPS, 'Skip'].map(name => {
      const b = document.createElement('button');
      b.className = name === 'Skip' ? 'learn-skip' : 'learn-chip';
      b.textContent = name;
      b.dataset.pattern = name;
      return b;
    }));
    el.patternChips.addEventListener('click', e => {
      const name = e.target.closest('[data-pattern]')?.dataset.pattern;
      if (name) onPatternGuess(name === 'Skip' ? '' : name);
    });
  }
  el.confidenceRow?.addEventListener('click', e => {
    const answer = e.target.closest('[data-confidence]')?.dataset.confidence;
    if (answer) onConfidence(answer);
  });
  el.dejavuClose?.addEventListener('click', () => { el.dejavuRow.hidden = true; });
  el.dejavuOpen?.addEventListener('click', () => openProblem(el.dejavuOpen.dataset.slug));
  el.tiltBreak?.addEventListener('click', () => closeTilt('break', '☕ Back in 5 — your progress is saved'));
  el.tiltHint?.addEventListener('click', () => {
    const opened = ctx.unlockNext?.();
    closeTilt('hint', opened ? '' : 'Every hint is already open');
  });
  el.tiltEasier?.addEventListener('click', () => { closeTilt('easier'); openProblem(el.tiltEasier.dataset.slug); });
  el.tiltClose?.addEventListener('click', () => closeTilt('dismiss'));
  el.btnCheckSpeed?.addEventListener('click', () => checkSpeed({ manual: true }));
  el.speedWarningClose?.addEventListener('click', () => {
    el.speedWarning.hidden = true;
    dismissedSpeedFor = lastWarnedCode;
  });
  el.btnExportCsv?.addEventListener('click', exportCsv);

  setInterval(tiltTick, TILT_CHECK_MS);
}

function openProblem(slug) {
  if (!slug) return;
  const url = `https://leetcode.com/problems/${slug}/`;
  chrome.tabs.update({ url }).catch(() => window.open(url, '_blank'));
}


// ─────────────────────────────────────────────
// HOOKS — called by sidepanel.js
// ─────────────────────────────────────────────

// A problem is on screen (its saved progress is loaded)
export async function onProblemShown() {
  const { problem, hintsUnlocked, solved, review } = ctx.getState();
  hideAll();
  if (!problem?.slug) return;
  resetTilt(problem);
  const slug = problem.slug;
  const { confidenceLog = [], patternGuesses = [] } = await load(['confidenceLog', 'patternGuesses']);
  if (ctx.getState().problem?.slug !== slug) return;   // moved on meanwhile

  const fresh = hintsUnlocked === 1 && !solved && !ctx.isInterviewActive?.(slug);
  // Asked once per problem — a review is a fresh attempt, so it asks again
  const asked = (log) => log.some(e => e.slug === slug && (!review || e.date === localDate()));
  el.confidenceRow.hidden = !(fresh && !asked(confidenceLog));
  const guessOpen = fresh && !asked(patternGuesses);
  el.patternGuess.hidden = !guessOpen;
  el.hintCard1?.classList.toggle('awaiting-guess', guessOpen);
  pendingGuess = null;
  showDejaVu();
}

// No problem on screen
export function onNoProblem() {
  hideAll();
  tilt = null;
}

// The hints (or a new version of them) are ready
export function onHintsReady() {
  if (pendingGuess) finishGuess();
  showDejaVu();
}

// A hint was unlocked — that's progress
export function onHintUnlocked() {
  if (tilt) tilt.lastProgressAt = Date.now();
  // Moving past Hint 1 without guessing = skipped
  if (!el.patternGuess.hidden) onPatternGuess('');
  el.confidenceRow.hidden = true;
}

// Solved (Accepted or "I solved it") at this score
export async function onSolved(slug, score) {
  if (tilt?.slug === slug) tilt.solved = true;
  el.tiltCard.hidden = true;
  const { confidenceLog = [] } = await load('confidenceLog');
  const r = resolveConfidence(confidenceLog, slug, score);
  if (r.changed) await store({ confidenceLog: r.log });
  await logActivity();
}

// A revision was recorded — counts for the streak
export const onReviewed = () => logActivity();

// LeetCode reported Wrong Answer / TLE / Runtime Error for this problem
export function onFailed(slug, verdict) {
  if (!tilt || tilt.slug !== slug) return;
  tilt.failures.push(Date.now());
  tilt.lastVerdict = verdict;
  evaluateTilt();
}

// Run or Submit was pressed
export function onCodeRun(slug) {
  if (ctx.getState().problem?.slug !== slug) return;
  if (tilt) tilt.lastProgressAt = Date.now();
  checkSpeed({ manual: false });
}

function hideAll() {
  for (const k of ['confidenceRow', 'patternGuess', 'patternResult', 'dejavuRow', 'tiltCard', 'speedWarning', 'speedOk']) {
    if (el[k]) el[k].hidden = true;
  }
  el.hintCard1?.classList.remove('awaiting-guess');
}


// ─────────────────────────────────────────────
// 4.2 CONFIDENCE
// ─────────────────────────────────────────────
async function onConfidence(answer) {
  el.confidenceRow.hidden = true;
  if (answer === 'skip') return;
  const { problem } = ctx.getState();
  if (!problem?.slug) return;
  const { confidenceLog = [] } = await load('confidenceLog');
  confidenceLog.push({ slug: problem.slug, answer, difficulty: String(problem.difficulty || '').toLowerCase(), date: localDate(), solo: null });
  await store({ confidenceLog: confidenceLog.slice(-MAX_LOG) });
}


// ─────────────────────────────────────────────
// 4.1 PATTERN GUESS
// ─────────────────────────────────────────────
let pendingGuess = null;   // { slug, guess } waiting for the hints' pattern

function onPatternGuess(guess) {
  el.patternGuess.hidden = true;
  el.hintCard1?.classList.remove('awaiting-guess');
  const { problem } = ctx.getState();
  if (!guess || !problem?.slug) return;
  pendingGuess = { slug: problem.slug, guess };
  const hints = ctx.getState().hints;
  if (hints && !hints.generating && hints.pattern) finishGuess();
  else {
    el.patternResult.textContent = `Guess saved: ${guess}. You'll see how it compares as the hints open.`;
    el.patternResult.hidden = false;
  }
}

async function finishGuess() {
  const g = pendingGuess;
  const { problem, hints } = ctx.getState();
  if (!g || problem?.slug !== g.slug) { pendingGuess = null; return; }
  if (hints?.generating) return;   // the pattern isn't known yet — wait for onHintsReady
  pendingGuess = null;
  const known = { pattern: hints?.pattern && hints.pattern !== 'Unknown' ? hints.pattern : '', topicTags: problem.topicTags || [] };
  const correct = matchPattern(g.guess, known);
  // Not revealed here — the pattern would give Hint 1 away
  el.patternResult.textContent = correct ? `✅ Good read — ${g.guess} fits this problem.` : `Noted: ${g.guess}. Compare with the hints as you go.`;
  el.patternResult.hidden = false;
  const { patternGuesses = [] } = await load('patternGuesses');
  patternGuesses.push({ slug: g.slug, guess: g.guess, correct, pattern: primaryPattern(known), date: localDate() });
  await store({ patternGuesses: patternGuesses.slice(-MAX_LOG) });
}


// ─────────────────────────────────────────────
// 4.5 DÉJÀ VU
// ─────────────────────────────────────────────
const dejaVuClosed = new Set();

async function showDejaVu() {
  const { problem, hints } = ctx.getState();
  if (!problem?.slug || dejaVuClosed.has(problem.slug)) return;
  const { stats = {} } = await load('stats');
  if (ctx.getState().problem?.slug !== problem.slug) return;
  const match = findDejaVu({ slug: problem.slug, pattern: hints?.pattern || '', topicTags: problem.topicTags || [] }, stats.problems || {});
  if (!match) { el.dejavuRow.hidden = true; return; }
  el.dejavuText.textContent = match.message;
  el.dejavuOpen.dataset.slug = match.slug;
  el.dejavuRow.hidden = false;
  el.dejavuClose.onclick = () => { dejaVuClosed.add(problem.slug); el.dejavuRow.hidden = true; };
}


// ─────────────────────────────────────────────
// 4.3 TILT DETECTOR
// ─────────────────────────────────────────────
let tilt = null;   // { slug, difficulty, failures, openedAt, lastProgressAt, shown, solved, lastCode }

async function resetTilt(problem) {
  const { solved } = ctx.getState();
  const now = Date.now();
  tilt = { slug: problem.slug, difficulty: problem.difficulty, failures: [], openedAt: now, lastProgressAt: now,
           shown: false, solved: !!solved, lastCode: null };
  const { tiltShown = {} } = await load('tiltShown');
  if (tilt?.slug === problem.slug && tiltShown[problem.slug]) tilt.shown = true;   // once per problem
}

async function tiltTick() {
  if (!tilt || tilt.shown || tilt.solved || document.hidden) return;
  if (ctx.isInterviewActive?.(tilt.slug)) return;
  const editor = await readEditor(tilt.slug);
  if (editor && tilt) {
    if (tilt.lastCode !== null && codeChangedMeaningfully(tilt.lastCode, editor.code)) tilt.lastProgressAt = Date.now();
    tilt.lastCode = editor.code;
  }
  evaluateTilt();
}

async function evaluateTilt() {
  if (!tilt || ctx.isInterviewActive?.(tilt.slug)) return;
  const reason = tiltReason(tilt);
  if (!reason) return;
  tilt.shown = true;
  const slug = tilt.slug;
  const { tiltShown = {}, stats = {} } = await load(['tiltShown', 'stats']);
  tiltShown[slug] = localDate();
  await store({ tiltShown });

  const { problem, hints, hintsUnlocked } = ctx.getState();
  if (problem?.slug !== slug) return;
  el.tiltText.textContent = reason === 'failures'
    ? 'Three tries that didn\'t pass in a few minutes — that happens to everyone on this kind of problem. A short reset often helps more than another submit.'
    : 'You\'ve been on this one a while without a change. Stepping back for a moment, or a small nudge, usually gets things moving.';
  el.tiltHint.hidden = hintsUnlocked === 'solution';
  const easier = easierProblem({ slug, pattern: hints?.pattern || '', difficulty: problem.difficulty }, stats.problems || {});
  el.tiltEasier.hidden = !easier;
  if (easier) {
    el.tiltEasier.textContent = `🪜 Warm up on ${easier.title}`;
    el.tiltEasier.dataset.slug = easier.slug;
  }
  el.tiltCard.hidden = false;
  el.tiltCard.dataset.reason = reason;
  logTilt(slug, reason, 'shown');
}

function closeTilt(action, toast = '') {
  el.tiltCard.hidden = true;
  if (tilt) logTilt(tilt.slug, el.tiltCard.dataset.reason || '', action);
  if (toast) ctx.showToast(toast);
}

async function logTilt(slug, reason, action) {
  const { tiltLog = [] } = await load('tiltLog');
  tiltLog.push({ slug, reason, action, date: localDate() });
  await store({ tiltLog: tiltLog.slice(-MAX_LOG) });
}


// ─────────────────────────────────────────────
// 4.4 TLE WARNING
// ─────────────────────────────────────────────
let lastWarnedCode = null;
let dismissedSpeedFor = null;

async function checkSpeed({ manual }) {
  const { problem } = ctx.getState();
  if (!problem?.slug) return;
  const editor = await readEditor(problem.slug);
  if (ctx.getState().problem?.slug !== problem.slug) return;
  el.speedOk.hidden = true;
  if (!editor?.code?.trim()) {
    if (manual) { el.speedOk.textContent = 'Couldn\'t read the editor — click into the LeetCode tab and try again.'; el.speedOk.hidden = false; }
    return;
  }
  const n = parseMaxBound(problem.description);
  const warning = tleWarning(editor.code, editor.language, problem.description);
  if (!warning) {
    el.speedWarning.hidden = true;
    if (manual) {
      el.speedOk.textContent = n ? `Looks fine for inputs up to ${n.toLocaleString()} (heuristic).` : 'No input size found in the constraints — nothing to compare against.';
      el.speedOk.hidden = false;
    }
    return;
  }
  lastWarnedCode = editor.code;
  if (!manual && dismissedSpeedFor === editor.code) return;   // dismissed for this exact code
  el.speedWarningText.textContent = `⚠️ ${warning.message}`;
  el.speedWarning.hidden = false;
}


// ─────────────────────────────────────────────
// 4.6 STREAKS + CSV, and the Stats / Revision cards
// ─────────────────────────────────────────────
async function logActivity() {
  const { activityLog = [] } = await load('activityLog');
  const today = localDate();
  if (activityLog.includes(today)) return;
  activityLog.push(today);
  await store({ activityLog: activityLog.slice(-800) });
}

export async function renderLearningStats() {
  const data = await load(['stats', 'revisionQueue', 'activityLog', 'patternGuesses', 'confidenceLog', 'tiltLog']);
  const { current, best } = streaks(activityDays(data));
  if (el.streakCurrent) el.streakCurrent.textContent = current;
  if (el.streakBest) el.streakBest.textContent = best;

  // Pattern recognition bars
  const acc = patternAccuracy(data.patternGuesses || []);
  el.patternStats.hidden = !acc.length;
  el.patternBars.replaceChildren(...acc.map(r => {
    const row = document.createElement('div');
    row.className = 'dist-item';
    const name = document.createElement('span');
    name.className = 'dist-level';
    name.textContent = r.pattern;
    const wrap = document.createElement('div');
    wrap.className = 'dist-bar-wrap';
    const bar = document.createElement('div');
    bar.className = 'dist-bar';
    bar.style.width = `${r.pct}%`;
    wrap.append(bar);
    const count = document.createElement('span');
    count.className = 'dist-count';
    count.textContent = `${r.pct}%`;
    count.title = `${r.correct} of ${r.total} guesses right`;
    row.append(name, wrap, count);
    return row;
  }));

  // Confidence card
  const conf = confidenceSummary(data.confidenceLog || []);
  el.confidenceStats.hidden = !conf;
  if (conf) {
    el.confidenceHeadline.textContent = `${conf.headline} — overall ${conf.verdict}.`;
    el.confidenceList.replaceChildren(...conf.byDifficulty.map(d => {
      const li = document.createElement('li');
      const name = d.difficulty[0].toUpperCase() + d.difficulty.slice(1);
      li.textContent = `${name}: ${d.verdict}` + (d.yesSoloPct === null ? '' : ` (Yes → alone ${d.yesSoloPct}%)`) + ` · ${d.total} answers`;
      return li;
    }));
  }

  // Tilt summary
  const shown = (data.tiltLog || []).filter(t => t.action === 'shown');
  el.tiltStats.hidden = !shown.length;
  if (shown.length) {
    const took = a => (data.tiltLog || []).filter(t => t.action === a).length;
    el.tiltSummary.textContent = `${shown.length} tough moment${shown.length === 1 ? '' : 's'} spotted · ${took('break')} break${took('break') === 1 ? '' : 's'} taken · ${took('hint')} hint${took('hint') === 1 ? '' : 's'} unlocked from the card.`;
  }
}

// Revision tab: patterns you recognise less than half the time
export async function renderWeakPatterns() {
  if (!el.weakPatterns) return;
  const { patternGuesses = [] } = await load('patternGuesses');
  const weak = weakPatterns(patternGuesses).slice(0, 3);
  el.weakPatterns.hidden = !weak.length;
  el.weakPatterns.textContent = weak.length
    ? `🎯 Worth more practice: ${weak.map(w => `${w.pattern} (${w.pct}% recognised)`).join(', ')}.`
    : '';
}

async function exportCsv() {
  const data = await load(['stats', 'revisionQueue', 'interviewHistory']);
  const blob = new Blob(['﻿' + buildCsv(data)], { type: 'text/csv;charset=utf-8' });   // BOM: Excel reads UTF-8
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `leethint-${localDate()}.csv`;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}
