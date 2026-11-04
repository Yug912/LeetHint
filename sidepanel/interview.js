// sidepanel/interview.js — Mock Interview Mode (UI + session flow)
//
// A 30-minute voice interview with an AI interviewer on the open problem.
// While it runs the normal hint ladder is locked. The session is saved in
// chrome.storage.local after every change, so closing or reloading the panel
// resumes it (the timer runs from the saved start time).
//
//   start → interviewer turns (one at a time) → feedback / time up / End
//         → scorecard → saved to interviewHistory (shown on the Stats tab)

import { INTERVIEW_STAGES, INTERVIEW_MINUTES, STAGE_LABELS, SCORE_KEYS, SCORE_LABELS,
         interviewerTurn, scoreInterview, codeChangedMeaningfully, referenceFromHints } from '../api/interview.js';
import { speak, stopSpeaking, isSpeaking, onSpeakingChange, setMuted, isMuted,
         Listener, speechSupported, micPermission, openMicPermissionPage } from './voice.js';

const SESSION_KEY   = 'activeInterview';
const HISTORY_KEY   = 'interviewHistory';
const MUTE_KEY      = 'interviewMuted';
const DURATION_MS   = INTERVIEW_MINUTES * 60 * 1000;
const CODE_CHECK_MS = 60 * 1000;        // read the editor every minute
const IDLE_NUDGE_MS = 3 * 60 * 1000;    // "think out loud" after 3 quiet minutes
const MAX_SAVED     = 50;
const HOLD_MS       = 600;              // held longer than this = push-to-talk

let ctx = null;            // { getProblem(), getHintsFor(slug), showToast(msg), isReviewDue(slug), onScored(session, card) }
let session = null;        // the saved interview (see startInterview)
let viewOn = false;
let tickTimer = null;
let turnChain = Promise.resolve();
const queued = new Set();  // events waiting for their turn (no duplicates)
let busy = false;          // an interviewer request is in flight
let scoring = false;
let listener = null;
let micDownAt = 0;
const el = {};

const $ = id => document.getElementById(id);


// ─────────────────────────────────────────────
// 1. SETUP — called once from sidepanel.js
// ─────────────────────────────────────────────
export async function initInterview(context) {
  ctx = context;
  Object.assign(el, {
    bar: $('interview-bar'), start: $('btn-interview-start'), elsewhere: $('interview-elsewhere'),
    view: $('interview-view'), timer: $('iv-timer'), hints: $('iv-hints'), mute: $('iv-mute'),
    end: $('iv-end'), stages: $('iv-stages'), log: $('iv-log'), status: $('iv-status'),
    live: $('iv-live'), inputRow: $('iv-input'), mic: $('iv-mic'), text: $('iv-text'),
    send: $('iv-send'), scorecard: $('iv-scorecard')
  });
  if (!el.view) return;

  listener = new Listener({
    onTranscript: t => { el.live.textContent = t || 'Listening… speak now'; if (t) markActivity(); },
    onStateChange: () => updateControls(),
    onError: handleMicError
  });
  // Never listen while the interviewer is speaking
  onSpeakingChange(speakingNow => {
    if (speakingNow && listener.active) listener.abort();
    updateControls();
  });

  el.start.addEventListener('click', startInterview);
  el.end.addEventListener('click', onEndClick);
  el.mute.addEventListener('click', toggleMute);
  el.send.addEventListener('click', sendTyped);
  el.text.addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendTyped(); }
  });
  el.text.addEventListener('input', markActivity);
  el.mic.addEventListener('pointerdown', onMicDown);
  el.mic.addEventListener('pointerup', onMicUp);
  el.mic.addEventListener('pointerleave', onMicUp);

  chrome.runtime.onMessage.addListener(msg => {
    if (msg?.type === 'MIC_GRANTED') ctx.showToast('🎙️ Microphone ready — tap the mic to answer');
  });

  const saved = await chrome.storage.local.get([SESSION_KEY, MUTE_KEY]);
  session = saved[SESSION_KEY] || null;
  setMuted(!!saved[MUTE_KEY]);
  el.mute.textContent = isMuted() ? '🔇' : '🔊';
  renderStageChips();
  syncInterview(ctx.getProblem());
}

// The hint ladder is locked while this problem has an interview
export const isInterviewActive = slug => !!session && !!slug && session.slug === slug;
// Any interview at all (only one runs at a time)
export const hasInterview = () => !!session;

// Called whenever the panel's problem changes (or there is none)
export function syncInterview(problem) {
  if (!el.view) return;
  const slug = problem?.slug || '';
  const here = isInterviewActive(slug);
  el.bar.hidden = !slug || here;
  el.start.disabled = !!session && !here;
  el.elsewhere.hidden = !(session && !here);
  if (session && !here) el.elsewhere.textContent = `Interview in progress on “${session.title}” — open that problem to continue or end it.`;
  setView(here);
}

function setView(on) {
  document.body.classList.toggle('interview-mode', on);
  el.view.hidden = !on;
  const wasOn = viewOn;
  viewOn = on;
  if (on) {
    renderAll();
    if (!session.ended) startTicking();
    if (!wasOn) resume();
  } else if (wasOn) {
    stopTicking();
    stopSpeaking();
    if (listener?.active) listener.abort();
  }
}


// ─────────────────────────────────────────────
// 2. START / RESUME / END
// ─────────────────────────────────────────────
// Also called by the Revision tab's "Review as interview" once the problem is open
export async function startInterview() {
  const p = ctx.getProblem();
  if (!p?.slug || session) return false;
  const now = Date.now();
  session = {
    slug: p.slug, title: p.title, difficulty: p.difficulty, problemNumber: p.problemNumber,
    review: !!ctx.isReviewDue?.(p.slug),   // a due revision — the scorecard schedules the next one
    startedAt: now, stage: 'intro', history: [], hintsGiven: 0,
    lastActivityAt: now, lastNudgeAt: 0, lastCodeCheckAt: now,
    lastCode: (await readEditorCode(p.slug)) || '',   // starter template = baseline
    timeupSent: false, ended: false
  };
  await save();
  syncInterview(p);   // opens the view → resume() asks for the opening line
  return true;
}

// Continue a saved session after the panel was closed or reloaded
function resume() {
  if (!session || busy || queued.size) return;
  if (session.scorecard) return;                                    // just show it
  if (session.ended) return void finishInterview(session.endReason || 'ended');
  const elapsed = Date.now() - session.startedAt;
  if (elapsed > DURATION_MS + 5 * 60 * 1000 || (elapsed >= DURATION_MS && session.timeupSent)) {
    return void finishInterview('timeup');                          // time ran out while away
  }
  const last = session.history.at(-1);
  if (!last) queueTurn('start');
  else if (last.role === 'candidate') queueTurn('answer');          // never answered
}

// Two taps to end (native confirm() dialogs are unreliable in a side panel)
let endArmedUntil = 0;
function onEndClick() {
  if (!session) return;
  if (session.scorecard) return void dismissInterview();
  if (scoring) return;
  if (Date.now() > endArmedUntil) {
    endArmedUntil = Date.now() + 3000;
    el.end.textContent = 'Tap again to end';
    setTimeout(() => { if (Date.now() >= endArmedUntil) updateControls(); }, 3100);
    return;
  }
  endArmedUntil = 0;
  finishInterview('ended');
}

async function finishInterview(reason) {
  if (!session || scoring || session.scorecard) return;
  scoring = true;
  if (!session.ended) {
    session.ended = true;
    session.endedAt = Date.now();
    session.endReason = reason;
  }
  stopTicking();
  if (listener?.active) listener.abort();
  await save();
  renderAll();
  el.scorecard.hidden = false;
  el.scorecard.replaceChildren(textEl('p', '⏳ Writing your scorecard…', 'iv-scoring'));

  try {
    const slug = session.slug;
    const problem = ctx.getProblem();
    if (problem?.slug !== slug) throw new Error('Open the interview problem to get the scorecard.');
    const code = (await readEditorCode(slug)) ?? session.lastCode ?? '';
    session.finalCode = code;
    const card = await scoreInterview(problem, session, { code, reference: referenceFromHints(ctx.getHintsFor(slug)) });
    if (!session || session.slug !== slug) return;
    session.scorecard = card;
    await saveToHistory(session, card);
    await save();
    await ctx.onScored?.(session, card);
    renderAll();
  } catch (e) {
    const retry = textEl('button', '🔄 Retry scorecard', 'iv-retry');
    retry.addEventListener('click', () => finishInterview(reason));
    el.scorecard.replaceChildren(textEl('p', `⚠️ ${e.message}`, 'iv-scoring'), retry);
  } finally {
    scoring = false;
    updateControls();
  }
}

// Leave the scorecard → back to the normal hints
async function dismissInterview() {
  stopSpeaking();
  session = null;
  await chrome.storage.local.remove(SESSION_KEY);
  el.scorecard.hidden = true;
  syncInterview(ctx.getProblem());
}


// ─────────────────────────────────────────────
// 3. INTERVIEWER TURNS — strictly one at a time
// ─────────────────────────────────────────────
function queueTurn(event, codeOverride) {
  if (queued.has(event)) return;            // already waiting — one turn covers it
  queued.add(event);
  updateControls();
  turnChain = turnChain
    .then(() => { queued.delete(event); return runTurn(event, codeOverride); })
    .catch(e => console.warn('LeetHint: interview turn failed →', e));
}

const quiet = event => event === 'code' || event === 'nudge';

async function runTurn(event, codeOverride) {
  if (!session || session.scorecard || (session.ended && event !== 'timeup')) return;
  // Silent check-ins are dropped if the conversation has moved on meanwhile
  if (quiet(event) && (queued.has('answer') || isSpeaking() || listener.active)) return;

  const slug = session.slug;
  const problem = ctx.getProblem();
  if (problem?.slug !== slug) return;

  busy = true;
  if (!quiet(event)) setStatus('💭 Interviewer is thinking…');
  updateControls();
  let reply = '';
  try {
    const code = codeOverride ?? (await readEditorCode(slug)) ?? session.lastCode ?? '';
    const result = await interviewerTurn(problem, session, event, {
      code, reference: referenceFromHints(ctx.getHintsFor(slug))
    });
    if (!session || session.slug !== slug) return;

    session.stage = event === 'timeup' ? 'feedback' : result.stage;
    if (result.hintGiven) session.hintsGiven++;
    reply = result.reply;
    if (reply) addMessage('interviewer', reply, { hint: result.hintGiven });
    markActivity();   // the idle clock restarts after the interviewer speaks
    await save();
    setStatus('');
  } catch (e) {
    if (quiet(event)) { console.warn('LeetHint: interviewer check-in skipped →', e.message); return; }
    setStatus(`⚠️ ${e.message}`, () => queueTurn(event));
    return;
  } finally {
    busy = false;
    renderMeta();
    updateControls();
  }

  if (reply && viewOn) await speak(reply);
  if (session?.stage === 'feedback') finishInterview(event === 'timeup' ? 'timeup' : 'feedback');
}

function sendCandidate(text) {
  text = String(text || '').trim();
  if (!text || !session || session.ended) return;
  addMessage('candidate', text);
  markActivity();
  save();
  queueTurn('answer');
}

function sendTyped() {
  const text = el.text.value;
  if (!text.trim()) return;
  el.text.value = '';
  sendCandidate(text);
}

function markActivity() {
  if (!session) return;
  session.lastActivityAt = Date.now();
}


// ─────────────────────────────────────────────
// 4. TIMER, CODE WATCH AND NUDGES — one tick per second
// ─────────────────────────────────────────────
function startTicking() {
  stopTicking();
  tick();
  tickTimer = setInterval(tick, 1000);
}

function stopTicking() {
  clearInterval(tickTimer);
  tickTimer = null;
}

function tick() {
  if (!session || session.ended) return stopTicking();
  const now = Date.now();
  const left = Math.max(0, DURATION_MS - (now - session.startedAt));
  renderTimer(left);

  if (left === 0) {
    if (!session.timeupSent) { session.timeupSent = true; save(); queueTurn('timeup'); }
    return;
  }
  if (now - (session.lastCodeCheckAt || 0) >= CODE_CHECK_MS) {
    session.lastCodeCheckAt = now;
    checkCode();
  }
  const idle = now - session.lastActivityAt >= IDLE_NUDGE_MS && now - (session.lastNudgeAt || 0) >= IDLE_NUDGE_MS;
  if (idle && !busy && !queued.size && !isSpeaking() && !listener.active &&
      session.stage !== 'feedback' && session.history.some(h => h.role === 'interviewer')) {
    session.lastNudgeAt = now;
    save();
    queueTurn('nudge');
  }
}

// Read the editor; a meaningful change counts as activity, and during the
// coding stage the interviewer may ask one short question about it
async function checkCode() {
  const slug = session?.slug;
  const code = await readEditorCode(slug);
  if (code == null || !session || session.slug !== slug) return;
  if (!codeChangedMeaningfully(session.lastCode || '', code)) return;
  session.lastCode = code;
  markActivity();
  save();
  if (session.stage === 'coding' && !busy && !queued.size && !isSpeaking() && !listener.active) {
    queueTurn('code', code);
  }
}

// The LeetCode editor is Monaco, which only puts the VISIBLE lines in the
// page, so read its model in the page's own JS world. Only for the tab that
// is showing the interview problem.
async function readEditorCode(slug) {
  if (!slug) return null;
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const onProblem = new RegExp(`leetcode\\.com/problems/${slug}(?:[/?#]|$)`, 'i').test(tab?.url || '');
    if (!tab?.id || !onProblem) return null;
    const [res] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, world: 'MAIN', func: readMonacoCode });
    return typeof res?.result === 'string' ? res.result : null;
  } catch (e) {
    console.warn('LeetHint: could not read the editor →', e.message);
    return null;
  }
}

// Runs INSIDE the LeetCode page (serialised by executeScript) — self-contained
function readMonacoCode() {
  const api = window.monaco?.editor;
  if (api) {
    const fromEditors = (api.getEditors?.() || []).map(e => e.getModel?.()).filter(Boolean);
    const pool = (fromEditors.length ? fromEditors : api.getModels?.() || []).filter(m => !m.isDisposed?.());
    // The code editor, not the test-case box: a real language, the most text
    const best = pool.filter(m => (m.getLanguageId?.() || '') !== 'plaintext')
                     .sort((a, b) => b.getValueLength() - a.getValueLength())[0] || pool[0];
    if (best) return best.getValue();
  }
  const lines = document.querySelectorAll('.monaco-editor .view-lines .view-line');
  return lines.length ? [...lines].map(l => l.textContent.replace(/ /g, ' ')).join('\n') : null;
}


// ─────────────────────────────────────────────
// 5. MICROPHONE — tap to start/stop, or hold to talk
// ─────────────────────────────────────────────
async function onMicDown(e) {
  e.preventDefault();
  if (isSpeaking()) { stopSpeaking(); return; }       // tap while it talks = skip
  if (listener.active) { await stopListeningAndSend(); return; }
  if (!session || session.ended || !(await ensureMic())) return;
  if (listener.start()) micDownAt = Date.now();
}

function onMicUp() {
  if (listener?.active && micDownAt && Date.now() - micDownAt > HOLD_MS) stopListeningAndSend();
  micDownAt = 0;
}

async function stopListeningAndSend() {
  micDownAt = 0;
  const text = await listener.stop();
  if (text) sendCandidate(text);
  else ctx.showToast("🎙️ Didn't catch that — try again or type it");
}

async function ensureMic() {
  if (!speechSupported()) {
    ctx.showToast('Voice answers need Chrome speech recognition — type your answer instead');
    return false;
  }
  const state = await micPermission();
  if (state === 'granted') return true;
  ctx.showToast(state === 'denied'
    ? '🎙️ Microphone is blocked — allow it in the tab that opened'
    : '🎙️ Click “Allow” in the tab that just opened, then come back');
  await openMicPermissionPage();
  return false;
}

function handleMicError(kind) {
  if (kind === 'not-allowed') {
    ctx.showToast('🎙️ Microphone permission needed — opening it in a tab');
    openMicPermissionPage();
  } else if (kind === 'network') {
    ctx.showToast('🎙️ Voice recognition needs an internet connection');
  } else if (kind === 'unsupported') {
    ctx.showToast('Voice answers are not supported here — type your answer instead');
  }
}

async function toggleMute() {
  setMuted(!isMuted());
  el.mute.textContent = isMuted() ? '🔇' : '🔊';
  el.mute.title = isMuted() ? 'Unmute interviewer' : 'Mute interviewer';
  await chrome.storage.local.set({ [MUTE_KEY]: isMuted() });
}


// ─────────────────────────────────────────────
// 6. RENDERING (all text through textContent — no HTML from the model)
// ─────────────────────────────────────────────
function textEl(tag, text, className) {
  const n = document.createElement(tag);
  if (className) n.className = className;
  n.textContent = text;
  return n;
}

function addMessage(role, text, { hint = false } = {}) {
  session.history.push({ role, text, at: Date.now(), ...(hint ? { hint: true } : {}) });
  el.log.appendChild(messageEl(session.history.at(-1)));
  el.log.scrollTop = el.log.scrollHeight;
}

function messageEl(m) {
  const row = document.createElement('div');
  row.className = `iv-msg iv-${m.role}`;
  row.appendChild(textEl('span', m.role === 'interviewer' ? 'Interviewer' : 'You', 'iv-who'));
  row.appendChild(textEl('p', m.text));
  if (m.hint) row.appendChild(textEl('span', 'hint given', 'iv-hint-tag'));
  return row;
}

function renderAll() {
  if (!session) return;
  el.log.replaceChildren(...session.history.map(messageEl));
  el.log.scrollTop = el.log.scrollHeight;
  renderMeta();
  renderTimer(session.ended ? Math.max(0, DURATION_MS - ((session.endedAt || Date.now()) - session.startedAt))
                            : Math.max(0, DURATION_MS - (Date.now() - session.startedAt)));
  if (session.scorecard) renderScorecard(session.scorecard);
  else if (!scoring) el.scorecard.hidden = true;
  updateControls();
}

function renderStageChips() {
  el.stages.replaceChildren(...INTERVIEW_STAGES.map(s => {
    const li = textEl('li', STAGE_LABELS[s]);
    li.dataset.stage = s;
    return li;
  }));
}

function renderMeta() {
  if (!session) return;
  const current = INTERVIEW_STAGES.indexOf(session.stage);
  [...el.stages.children].forEach((li, i) => {
    li.classList.toggle('done', i < current);
    li.classList.toggle('current', i === current);
  });
  el.hints.textContent = `${session.hintsGiven} hint${session.hintsGiven === 1 ? '' : 's'}`;
}

const fmtClock = ms => {
  const s = Math.ceil(ms / 1000);
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
};

function renderTimer(leftMs) {
  el.timer.textContent = fmtClock(leftMs);
  el.timer.classList.toggle('low', leftMs < 5 * 60 * 1000);
}

function setStatus(text, retry) {
  el.status.replaceChildren();
  if (!text) { el.status.hidden = true; return; }
  el.status.hidden = false;
  el.status.appendChild(textEl('span', text));
  if (retry) {
    const b = textEl('button', 'Retry', 'iv-link');
    b.addEventListener('click', () => { setStatus(''); retry(); });
    el.status.appendChild(b);
  }
}

function updateControls() {
  if (!el.view) return;
  const ended = !session || session.ended;
  const speakingNow = isSpeaking();
  const listening = !!listener?.active;

  el.inputRow.hidden = ended;
  el.mic.classList.toggle('listening', listening);
  el.mic.textContent = speakingNow ? '⏭' : listening ? '⏹' : '🎙️';
  el.mic.title = speakingNow ? 'Skip — stop the interviewer talking'
               : listening ? 'Stop and send' : 'Tap to talk (tap again to send), or hold to talk';
  el.live.hidden = !listening;
  if (listening && !el.live.textContent) el.live.textContent = 'Listening… speak now';
  if (!listening) el.live.textContent = '';
  el.send.disabled = ended;
  el.end.textContent = session?.scorecard ? 'Back to hints' : Date.now() < endArmedUntil ? 'Tap again to end' : 'End';
  el.end.disabled = scoring;

  if (speakingNow && !busy) setStatus('🔊 Interviewer is speaking…');
  else if (!speakingNow && !busy && el.status.textContent.startsWith('🔊')) setStatus('');
}

function renderScorecard(card) {
  const wrap = document.createElement('div');
  wrap.appendChild(textEl('h3', 'Scorecard', 'iv-card-title'));
  wrap.appendChild(textEl('span', card.signal, `iv-signal iv-signal-${card.signal.replace(/\s+/g, '-').toLowerCase()}`));

  const meta = [`${Math.max(1, Math.round(((session.endedAt || Date.now()) - session.startedAt) / 60000))} min`,
                `${session.hintsGiven} hint${session.hintsGiven === 1 ? '' : 's'}`,
                `reached ${STAGE_LABELS[session.stage] || session.stage}`].join(' · ');
  wrap.appendChild(textEl('p', meta, 'iv-card-meta'));
  wrap.appendChild(scoreRows(card));

  if (card.improvements.length) {
    wrap.appendChild(textEl('h4', 'Top things to improve', 'iv-card-sub'));
    const ol = document.createElement('ol');
    ol.className = 'iv-improve';
    card.improvements.forEach(t => ol.appendChild(textEl('li', t)));
    wrap.appendChild(ol);
  }
  el.scorecard.replaceChildren(wrap);
  el.scorecard.hidden = false;
}

function scoreRows(card) {
  const list = document.createElement('div');
  list.className = 'iv-scores';
  for (const k of SCORE_KEYS) {
    const row = document.createElement('div');
    row.className = 'iv-score-row';
    const head = document.createElement('div');
    head.className = 'iv-score-head';
    head.appendChild(textEl('span', SCORE_LABELS[k]));
    head.appendChild(textEl('span', '●'.repeat(card[k].score) + '○'.repeat(4 - card[k].score), `iv-dots s${card[k].score}`));
    row.appendChild(head);
    if (card[k].comment) row.appendChild(textEl('p', card[k].comment, 'iv-score-comment'));
    list.appendChild(row);
  }
  return list;
}


// ─────────────────────────────────────────────
// 7. STORAGE + STATS TAB
// ─────────────────────────────────────────────
async function save() {
  if (session) await chrome.storage.local.set({ [SESSION_KEY]: session }).catch(() => {});
}

async function saveToHistory(s, card) {
  const { [HISTORY_KEY]: list = [] } = await chrome.storage.local.get(HISTORY_KEY);
  list.unshift({
    slug: s.slug, title: s.title, difficulty: s.difficulty, problemNumber: s.problemNumber,
    date: s.startedAt,
    durationSec: Math.round(((s.endedAt || Date.now()) - s.startedAt) / 1000),
    hintsUsed: s.hintsGiven,
    stageReached: s.stage,
    endReason: s.endReason,
    scorecard: card
  });
  await chrome.storage.local.set({ [HISTORY_KEY]: list.slice(0, MAX_SAVED) });
}

// Stats tab: past interviews, newest first; click one for its scorecard
export async function renderInterviewHistory() {
  const listEl = $('interview-history');
  const countEl = $('interview-count');
  if (!listEl) return;
  const { [HISTORY_KEY]: list = [] } = await chrome.storage.local.get(HISTORY_KEY);
  countEl.textContent = list.length;
  listEl.replaceChildren();
  if (!list.length) {
    listEl.appendChild(textEl('li', 'No mock interviews yet — start one from the Hints tab.', 'revision-empty'));
    return;
  }
  for (const item of list.slice(0, 15)) {
    const li = document.createElement('li');
    li.className = 'interview-item';
    const btn = document.createElement('button');
    btn.className = 'interview-summary';
    btn.setAttribute('aria-expanded', 'false');
    btn.appendChild(textEl('span', `${item.problemNumber ? item.problemNumber + '. ' : ''}${item.title || item.slug}`, 'interview-title'));
    btn.appendChild(textEl('span', item.scorecard.signal, `iv-signal iv-signal-${item.scorecard.signal.replace(/\s+/g, '-').toLowerCase()}`));
    const date = new Date(item.date).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
    btn.appendChild(textEl('span', `${date} · ${Math.max(1, Math.round(item.durationSec / 60))} min · ${item.hintsUsed} hint${item.hintsUsed === 1 ? '' : 's'}`, 'revision-meta'));

    const details = document.createElement('div');
    details.className = 'interview-details';
    details.hidden = true;
    details.appendChild(scoreRows(item.scorecard));
    if (item.scorecard.improvements?.length) {
      const ol = document.createElement('ol');
      ol.className = 'iv-improve';
      item.scorecard.improvements.forEach(t => ol.appendChild(textEl('li', t)));
      details.appendChild(ol);
    }
    btn.addEventListener('click', () => {
      details.hidden = !details.hidden;
      btn.setAttribute('aria-expanded', String(!details.hidden));
    });
    li.append(btn, details);
    listEl.appendChild(li);
  }
}
