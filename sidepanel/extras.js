// sidepanel/extras.js — the side panel's smaller features, kept out of
// sidepanel.js: pattern guess, confidence check, tilt detector, TLE warning,
// déjà vu, follow-ups, wrong-hint reports, streaks + CSV, own API key
// settings, the server's remote switches and its message banner.
//
// Logic lives in shared/patterns.js, shared/complexity.js and
// shared/insights.js (tested without Chrome); this file is only the DOM and
// chrome.storage around them. Every storage call is wrapped: a failure only
// means a feature shows less, never an error.

import { PATTERN_CHIPS, matchPattern, patternAccuracy, weakPatterns, canonicalPattern } from '../shared/patterns.js';
import { tleWarning } from '../shared/complexity.js';
import { calibration, CONFIDENCE_MIN, tiltCheck, easierProblem, dejaVu, streaks, activityDays, buildCsv } from '../shared/insights.js';
import { localDate } from '../shared/revision.js';
import { PROMPT_VERSION } from '../shared/prompts.js';
import { reportHint, getInstallId } from '../api/ai.js';
import { OWN_KEY_PROVIDERS, getOwnKey, setOwnKey, testOwnKey } from '../api/direct.js';
import { getRemoteConfig, CONFIG_DEFAULTS } from '../api/remote.js';
import { codeChangedMeaningfully } from '../api/interview.js';
import { readEditor } from './editor.js';

const $ = id => document.getElementById(id);
let ctx = null;   // { getProblem, getHints, getProgress, unlockNext, isInterviewing, showToast, switchTab, openProblem, renderServiceStatus }
let config = { ...CONFIG_DEFAULTS };
let ownKeySet = false;

const store = {
  get: async keys => { try { return await chrome.storage.local.get(keys); } catch { return {}; } },
  set: async obj => { try { await chrome.storage.local.set(obj); } catch {} }
};
const push = async (key, entry, max = 500) => {
  const { [key]: list = [] } = await store.get(key);
  list.push(entry);
  await store.set({ [key]: list.slice(-max) });
  return list;
};


// ─────────────────────────────────────────────
// SETUP
// ─────────────────────────────────────────────
export async function initExtras(context) {
  ctx = context;
  setupPatternGuess();
  setupConfidence();
  setupReport();
  setupTle();
  setupSettings();
  $('dejavu-close')?.addEventListener('click', () => { $('dejavu-row').hidden = true; dejavuHiddenFor = ctx.getProblem()?.slug; });
  ownKeySet = !!(await getOwnKey());
  await refreshRemoteConfig();
  setInterval(tiltTick, 60 * 1000);
}

// ── Remote switches (B4) ──
export const remote = () => config;
export const hasOwnKey = () => ownKeySet;

export async function refreshRemoteConfig() {
  config = await getRemoteConfig();
  const banner = $('remote-banner');
  if (banner) { banner.textContent = config.message; banner.hidden = !config.message; }
  renderTrialInfo();
  ctx?.onConfig?.(config);
  return config;
}

// "Free without a key: …" — the limits the server will apply (GET /config)
function renderTrialInfo() {
  const el = $('trial-info');
  if (!el) return;
  el.textContent = ownKeySet ? 'Using your own key — no daily limits from LeetHint.'
    : `Free without a key: Fix ${config.trialFixesPerDay}× a day${config.interview ? `, ${config.trialInterviewsPerWeek} mock interview (${config.trialInterviewMinutes} min) a week` : ''}. Hints are always free.`;
}


// ─────────────────────────────────────────────
// PROBLEM LIFECYCLE — called by sidepanel.js
// ─────────────────────────────────────────────
let current = '';          // slug the extras are showing
let dejavuHiddenFor = '';

export async function onProblemShown(problem) {
  current = problem?.slug || '';
  hideAll();
  if (!current) return;
  await Promise.all([showPatternGuess(problem), showConfidence(problem), showDejaVu(problem), startTilt(problem)]);
}

export async function onHintsReady(hints) {
  const problem = ctx.getProblem();
  if (!problem?.slug || problem.slug !== current || !hints || hints.generating) return;
  await settlePendingGuess(problem, hints);
  showDejaVu(problem, hints);
  $('hint-tools').hidden = false;
  $('report-picker').hidden = true;
  $('report-thanks').hidden = true;
  $('btn-report').hidden = false;
  const { stats = {} } = await store.get('stats');
  const entry = stats.problems?.[problem.slug];
  if (entry && entry.solved !== false) showFollowUps(hints);
}

// Accepted (or "I solved it"): score = this attempt's score
export async function onSolved(problem, { score }) {
  if (!problem?.slug) return;
  await push('activityLog', localDate(), 400);
  // Confidence: the latest open answer for this problem gets its outcome
  const { confidenceLog = [] } = await store.get('confidenceLog');
  for (let i = confidenceLog.length - 1; i >= 0; i--) {
    const e = confidenceLog[i];
    if (e.slug === problem.slug && e.solo === null) { e.solo = score === 100; break; }
  }
  await store.set({ confidenceLog });
  $('confidence-row').hidden = true;
  const t = tiltFor(problem.slug);
  if (t) { t.solved = true; saveTilt(); }
  const hints = ctx.getHints();
  if (hints && !hints.generating) showFollowUps(hints);
}

// A revision done today counts for the streak too
export const onReviewed = () => push('activityLog', localDate(), 400);

function hideAll() {
  for (const id of ['pattern-guess', 'pattern-result', 'confidence-row', 'dejavu-row', 'tilt-card', 'hint-tools', 'followups-section', 'tle-warning']) {
    const el = $(id);
    if (el) el.hidden = true;
  }
  $('hint-content-1')?.classList.remove('awaiting-guess');
}


// ─────────────────────────────────────────────
// PATTERN GUESS (B10) — before Hint 1, skippable
// ─────────────────────────────────────────────
let pendingGuess = null;   // { slug, guess } waiting for the hints' pattern

function setupPatternGuess() {
  const chips = $('pattern-chips');
  if (!chips) return;
  chips.replaceChildren(...PATTERN_CHIPS.map(name => {
    const b = document.createElement('button');
    b.className = 'chip-btn';
    b.textContent = name;
    b.addEventListener('click', () => makeGuess(name));
    return b;
  }));
  $('pattern-skip').addEventListener('click', () => makeGuess(null));
}

async function showPatternGuess(problem) {
  const { patternGuesses = [] } = await store.get('patternGuesses');
  if (problem.slug !== current) return;
  const progress = ctx.getProgress();
  const already = patternGuesses.some(g => g.slug === problem.slug);
  // Only on a fresh attempt: nothing unlocked yet, no interview running
  if (already || progress.hintsUnlocked !== 1 || ctx.isInterviewing(problem.slug)) return;
  $('pattern-guess').hidden = false;
  $('hint-content-1').classList.add('awaiting-guess');
}

async function makeGuess(guess) {
  const problem = ctx.getProblem();
  if (!problem?.slug) return;
  $('pattern-guess').hidden = true;
  $('hint-content-1').classList.remove('awaiting-guess');
  if (!guess) {
    await push('patternGuesses', { slug: problem.slug, guess: null, skipped: true, date: localDate() });
    return;
  }
  pendingGuess = { slug: problem.slug, guess };
  const hints = ctx.getHints();
  if (hints && !hints.generating && hints.pattern) await settlePendingGuess(problem, hints);
  else showGuessResult(`You guessed ${guess} — checking when the hints arrive…`);
}

async function settlePendingGuess(problem, hints) {
  if (!pendingGuess || pendingGuess.slug !== problem.slug) return;
  const { guess } = pendingGuess;
  pendingGuess = null;
  const correct = matchPattern(guess, { pattern: hints.pattern, topicTags: problem.topicTags || [] });
  await push('patternGuesses', { slug: problem.slug, guess, correct, pattern: hints.pattern || '', date: localDate() });
  const real = canonicalPattern(hints.pattern) || hints.pattern || 'Other';
  showGuessResult(correct ? `✓ ${guess} — right.` : `You guessed ${guess}; it's ${real}.`, correct);
}

function showGuessResult(text, right = false) {
  const el = $('pattern-result');
  el.textContent = text;
  el.classList.toggle('right', right);
  el.hidden = false;
}


// ─────────────────────────────────────────────
// CONFIDENCE (B11) — "Will you solve this without hints?"
// ─────────────────────────────────────────────
const skippedConfidence = new Set();

function setupConfidence() {
  $('confidence-row')?.querySelectorAll('[data-answer]').forEach(b => b.addEventListener('click', async () => {
    const problem = ctx.getProblem();
    $('confidence-row').hidden = true;
    if (!problem?.slug) return;
    if (b.dataset.answer === 'skip') { skippedConfidence.add(problem.slug); return; }
    await push('confidenceLog', { slug: problem.slug, answer: b.dataset.answer,
                                  difficulty: String(problem.difficulty || '').toLowerCase(), date: localDate(), solo: null });
  }));
}

async function showConfidence(problem) {
  if (skippedConfidence.has(problem.slug) || ctx.isInterviewing(problem.slug)) return;
  const [{ confidenceLog = [] }, { stats = {} }] = await Promise.all([store.get('confidenceLog'), store.get('stats')]);
  if (problem.slug !== current) return;
  const progress = ctx.getProgress();
  const solvedBefore = stats.problems?.[problem.slug]?.solved;
  const answered = confidenceLog.some(e => e.slug === problem.slug && (e.date === localDate() || !progress.review));
  // A fresh attempt only: new problem (or a due review), nothing unlocked yet
  if (answered || progress.hintsUnlocked !== 1 || (solvedBefore && !progress.review)) return;
  $('confidence-row').hidden = false;
}


// ─────────────────────────────────────────────
// DÉJÀ VU (B14)
// ─────────────────────────────────────────────
async function showDejaVu(problem, hints) {
  if (dejavuHiddenFor === problem.slug) return;
  const { stats = {} } = await store.get('stats');
  if (problem.slug !== current) return;
  const match = dejaVu({ slug: problem.slug, pattern: hints?.pattern || '', topicTags: problem.topicTags || [] }, stats.problems || {});
  const row = $('dejavu-row');
  if (!match) { row.hidden = true; return; }
  const link = $('dejavu-link');
  link.textContent = match.message;
  link.href = `https://leetcode.com/problems/${match.slug}/`;
  link.onclick = e => { e.preventDefault(); ctx.openProblem(match.slug); };
  row.hidden = false;
}


// ─────────────────────────────────────────────
// TILT (B12) — gentle help when it's going badly, once per problem
// ─────────────────────────────────────────────
let tilt = {};   // { [slug]: { openedAt, failures, lastChangeAt, lastCode, difficulty, solved, shown, day } }

const tiltFor = slug => tilt[slug];
const saveTilt = () => store.set({ tiltState: tilt });

async function startTilt(problem) {
  const { tiltState = {}, stats = {} } = await store.get(['tiltState', 'stats']);
  const today = localDate();
  // Keep only today's problems
  tilt = Object.fromEntries(Object.entries(tiltState).filter(([, t]) => t.day === today));
  if (!tilt[problem.slug]) {
    const now = Date.now();
    tilt[problem.slug] = { openedAt: now, failures: [], lastChangeAt: now, lastCode: null,
                           difficulty: String(problem.difficulty || '').toLowerCase(),
                           solved: stats.problems?.[problem.slug]?.solved === true && !ctx.getProgress().review,
                           shown: false, day: today };
  }
  await saveTilt();
}

export async function onFailed(slug, verdict) {
  const t = tiltFor(slug);
  if (!t) return;
  t.failures.push(Date.now());
  t.lastVerdict = verdict;
  await saveTilt();
  showTiltIfNeeded(slug);
}

// Every minute: has the code changed? Is it time for the card?
async function tiltTick() {
  const slug = current;
  const t = tiltFor(slug);
  if (!t || t.shown || t.solved || document.visibilityState !== 'visible') return;
  const ed = await readEditor(slug);
  if (ed && slug === current) {
    if (t.lastCode === null) t.lastCode = ed.code;              // the baseline
    else if (codeChangedMeaningfully(t.lastCode, ed.code)) { t.lastCode = ed.code; t.lastChangeAt = Date.now(); }
    await saveTilt();
  }
  showTiltIfNeeded(slug);
}

async function showTiltIfNeeded(slug) {
  const t = tiltFor(slug);
  if (slug !== current || ctx.isInterviewing(slug)) return;
  const hit = tiltCheck(t);
  if (!hit) return;
  t.shown = true;
  await saveTilt();
  const problem = ctx.getProblem();
  const { stats = {} } = await store.get('stats');
  const easier = easierProblem({ slug, pattern: ctx.getHints()?.pattern, difficulty: problem?.difficulty }, stats.problems || {});
  $('tilt-title').textContent = hit.reason === 'failures'
    ? 'Three wrong submissions in 10 minutes — a short break usually beats another quick try.'
    : `You've been on this for ${hit.minutes} minutes without much change. That's normal on hard ones.`;
  const actions = $('tilt-actions');
  actions.replaceChildren();
  const button = (label, fn) => {
    const b = document.createElement('button');
    b.className = 'chip-btn';
    b.textContent = label;
    b.addEventListener('click', () => { $('tilt-card').hidden = true; push('tiltLog', { slug, reason: hit.reason, action: label, date: localDate() }, 300); fn?.(); });
    actions.appendChild(b);
  };
  button('Take 5 minutes', () => ctx.showToast('⏸ Fresh eyes help — come back in 5'));
  if (ctx.getProgress().hintsUnlocked !== 'solution') button('Unlock the next hint', () => ctx.unlockNext());
  if (easier) button(`Try ${easier.title}`, () => ctx.openProblem(easier.slug));
  $('tilt-card').hidden = false;
  push('tiltLog', { slug, reason: hit.reason, action: 'shown', date: localDate() }, 300);
}


// ─────────────────────────────────────────────
// TLE WARNING (B13) — on Run/Submit and from "Check speed"
// ─────────────────────────────────────────────
let dismissedCode = '';

function setupTle() {
  $('btn-check-speed')?.addEventListener('click', () => checkSpeed({ manual: true }));
  $('tle-close')?.addEventListener('click', () => { $('tle-warning').hidden = true; dismissedCode = lastChecked; });
}

let lastChecked = '';
export async function checkSpeed({ manual = false } = {}) {
  const problem = ctx.getProblem();
  if (!problem?.slug) return;
  const ed = await readEditor(problem.slug);
  const box = $('tle-warning');
  if (!ed?.code?.trim()) {
    if (manual) ctx.showToast('Open the problem\'s LeetCode tab to check your code');
    return;
  }
  lastChecked = ed.code;
  if (!manual && ed.code === dismissedCode) return;
  const w = tleWarning(problem.description, ed.code, ed.lang);
  if (!w && !manual) { box.hidden = true; return; }
  $('tle-text').textContent = w ? `⏱ ${w.message}` : '✓ No obvious time-limit risk for these constraints.';
  box.classList.toggle('ok', !w);
  box.hidden = false;
}


// ─────────────────────────────────────────────
// FOLLOW-UPS (B6) — after a solve, answers hidden until clicked
// ─────────────────────────────────────────────
function showFollowUps(hints) {
  const list = $('followups-list');
  const items = (hints.followUps || []).filter(f => f?.q && f?.a);
  if (!items.length) { $('followups-section').hidden = true; return; }
  list.replaceChildren(...items.map(({ q, a }) => {
    const d = document.createElement('details');
    d.className = 'followup';
    const s = document.createElement('summary');
    s.textContent = q;
    const p = document.createElement('p');
    p.textContent = a;
    d.append(s, p);
    return d;
  }));
  $('followups-section').hidden = false;
}


// ─────────────────────────────────────────────
// REPORT A WRONG HINT (B6)
// ─────────────────────────────────────────────
const reported = new Set();

function setupReport() {
  $('btn-report')?.addEventListener('click', () => {
    if (reported.has(current)) return;
    $('report-picker').hidden = !$('report-picker').hidden;
  });
  $('report-picker')?.querySelectorAll('[data-reason]').forEach(b => b.addEventListener('click', async () => {
    const problem = ctx.getProblem();
    if (!problem?.slug) return;
    $('report-picker').hidden = true;
    $('btn-report').hidden = true;
    reported.add(problem.slug);
    const ok = await reportHint({ slug: problem.slug, promptVersion: ctx.getHints()?.promptVersion || PROMPT_VERSION, reason: b.dataset.reason });
    // An older server without /v1/report → the link just goes away
    if (ok && problem.slug === current) $('report-thanks').hidden = false;
  }));
}


// ─────────────────────────────────────────────
// STATS + REVISION TABS (B10, B11, B15)
// ─────────────────────────────────────────────
export async function renderStatsExtras() {
  const data = await store.get(['stats', 'revisionQueue', 'activityLog', 'patternGuesses', 'confidenceLog']);
  const s = streaks(activityDays(data));
  $('stat-streak').textContent = s.current;
  $('stat-best-streak').textContent = s.best;

  // Pattern recognition bars (patterns with 3+ guesses)
  const guesses = (data.patternGuesses || []).filter(g => g.guess && typeof g.correct === 'boolean');
  const acc = patternAccuracy(guesses);
  $('pattern-stats').hidden = !acc.length;
  $('pattern-bars').replaceChildren(...acc.map(e => {
    const row = document.createElement('div');
    row.className = 'pattern-bar-row';
    const name = document.createElement('span');
    name.textContent = e.pattern;
    const wrap = document.createElement('div');
    wrap.className = 'pattern-bar-wrap';
    const bar = document.createElement('div');
    bar.className = `pattern-bar${e.pct < 50 ? ' weak' : ''}`;
    bar.style.width = `${e.pct}%`;
    wrap.appendChild(bar);
    const count = document.createElement('span');
    count.className = 'pattern-bar-count';
    count.textContent = `${e.correct}/${e.total}`;
    row.append(name, wrap, count);
    return row;
  }));

  // Confidence calibration (after 10 answered)
  const cal = calibration(data.confidenceLog || []);
  $('confidence-card').hidden = !cal;
  if (cal) {
    const verdict = { overconfident: 'You tend to be overconfident', underconfident: 'You tend to be underconfident', 'well-calibrated': 'You are well-calibrated' }[cal.verdict];
    $('confidence-summary').textContent = (cal.yesSoloPct === null ? '' : `When you say Yes, you solve it alone ${cal.yesSoloPct}% of the time. `) + `${verdict}.`;
    $('confidence-by-difficulty').replaceChildren(...Object.entries(cal.byDifficulty).map(([d, j]) => {
      const p = document.createElement('p');
      p.className = 'confidence-diff';
      p.textContent = `${d[0].toUpperCase() + d.slice(1)}: ${j.verdict} — expected ${Math.round(j.predicted * 100)}%, solved alone ${Math.round(j.actual * 100)}% (${j.count})`;
      return p;
    }));
  } else {
    const answered = (data.confidenceLog || []).filter(e => typeof e.solo === 'boolean').length;
    $('confidence-summary').textContent = `${answered}/${CONFIDENCE_MIN} answered`;
  }

  const id = await getInstallId();
  $('install-id').textContent = id || 'not created yet';
}

// Revision tab: patterns recognised under 50% → solved problems to practise
export async function renderRevisionExtras() {
  const { patternGuesses = [], stats = {} } = await store.get(['patternGuesses', 'stats']);
  const weak = weakPatterns(patternGuesses.filter(g => g.guess && typeof g.correct === 'boolean'));
  $('weak-patterns').hidden = !weak.length;
  if (!weak.length) return;
  const practise = slugPattern => Object.entries(stats.problems || {})
    .filter(([, p]) => canonicalPattern(p.pattern) === slugPattern && p.title).slice(0, 2).map(([, p]) => p.title);
  $('weak-patterns-text').textContent = weak.map(w => {
    const ex = practise(w.pattern);
    return `${w.pattern}: spotted ${w.correct} of ${w.total}${ex.length ? ` — re-solve ${ex.join(', ')}` : ''}`;
  }).join(' · ');
}


// ─────────────────────────────────────────────
// SETTINGS — own key (B7), CSV (B15), server status only when seen (B3)
// ─────────────────────────────────────────────
function setupSettings() {
  const provider = $('own-key-provider'), input = $('own-key-input'), status = $('own-key-status');
  if (!provider) return;
  const note = () => { $('own-key-note').textContent = `Your key is stored on this computer and sent only to ${OWN_KEY_PROVIDERS[provider.value].name}.`; };
  provider.addEventListener('change', note);

  getOwnKey().then(k => {
    if (k) { provider.value = k.provider; input.value = k.key; $('btn-remove-key').hidden = false; status.textContent = '✓ Key saved'; status.className = 'settings-hint own-key-status ok'; }
    note();
  });

  $('btn-test-key').addEventListener('click', async () => {
    const key = input.value.trim();
    if (!key) { status.textContent = 'Paste a key first.'; status.className = 'settings-hint own-key-status bad'; return; }
    status.textContent = 'Testing…';
    status.className = 'settings-hint own-key-status';
    try {
      await testOwnKey(provider.value, key);
      await setOwnKey(provider.value, key);
      ownKeySet = true;
      status.textContent = '✓ Key works — saved on this computer';
      status.className = 'settings-hint own-key-status ok';
      $('btn-remove-key').hidden = false;
      renderTrialInfo();
      ctx.onConfig?.(config);
    } catch (e) {
      status.textContent = e.message;
      status.className = 'settings-hint own-key-status bad';
    }
  });

  $('btn-remove-key').addEventListener('click', async () => {
    await setOwnKey(provider.value, '');
    ownKeySet = false;
    input.value = '';
    $('btn-remove-key').hidden = true;
    status.textContent = 'Key removed.';
    status.className = 'settings-hint own-key-status';
    renderTrialInfo();
    ctx.onConfig?.(config);
  });

  $('btn-export-csv').addEventListener('click', async () => {
    const data = await store.get(['stats', 'revisionQueue', 'interviewHistory']);
    const url = URL.createObjectURL(new Blob([buildCsv(data)], { type: 'text/csv;charset=utf-8' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = `leethint-${localDate()}.csv`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  });

  // /health only once Settings is actually on screen, once per panel open
  const section = $('own-key-settings')?.closest('.settings-section');
  if (section && 'IntersectionObserver' in window) {
    const seen = new IntersectionObserver(entries => {
      if (!entries.some(e => e.isIntersecting)) return;
      seen.disconnect();
      ctx.renderServiceStatus();
    });
    seen.observe(section);
  }
}

// "Add a free key" buttons (trial used up) → the own-key settings
export function openOwnKeySettings() {
  ctx.switchTab('stats');
  setTimeout(() => {
    $('own-key-settings')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    $('own-key-input')?.focus();
  }, 50);
}
