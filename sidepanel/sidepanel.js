// sidepanel.js — Main logic for the LeetHint side panel
// Connects everything: problem data, hints, score, stats
// Loaded as an ES module (see sidepanel.html)

import { generateHints, validateSolutionCode, compareComplexity, checkBackend,
         translateSolution, fetchStaticHints, LANGUAGES } from '../api/ai.js';
import { CACHE_URL } from '../api/config.js';
import { loadCompanies } from '../api/companies.js';
import { initInterview, syncInterview, isInterviewActive, hasInterview, startInterview,
         renderInterviewHistory, setInterviewOptions } from './interview.js';
import * as extras from './extras.js';
import { initCompanies, renderCompanies } from './companies.js';
import { STEPS, SCORE_NAMES, QUEUE_SCORE_MAX, DEFAULT_DAILY_LIMIT, localDate, parseLocalDate, daysBetween,
         clampLimit, outcomeForScore, outcomeForInterview, interviewHintScore, newQueueItem, applyReview,
         markMastered, lastScore, lowerJoinScore, syncJoinScores, migrateQueue, planQueue,
         isDueToday } from '../shared/revision.js';

// ─────────────────────────────────────────────
// COMPANY DATABASE — from the cache site weekly, bundled copy as fallback
// ─────────────────────────────────────────────
let companiesDB = null;

// Fresher tags from the cache site once a week; the bundled copy is the
// fallback (first run offline, site down) — see api/companies.js
async function loadCompaniesDB() {
  const { data, source } = await loadCompanies({
    storage: chrome.storage.local, cacheUrl: CACHE_URL,
    bundledUrl: chrome.runtime.getURL('data/companies.json')
  });
  companiesDB = data;
  console.log('LeetHint: companiesDB loaded,', Object.keys(companiesDB).length, 'problems from', source);
  if (state.problem?.slug) renderCompanyTags(state.problem.slug);
}

// ─────────────────────────────────────────────
// STATE — everything about current session
// ─────────────────────────────────────────────
let state = {
  problem: null,          // {title, difficulty, slug, description}
  hints: null,            // {hint1..hint5, optimal_tc, optimal_sc, pattern}
  hintsUnlocked: 1,       // how many hints currently visible (1 = only hint1)
  score: 100,             // current score
  review: null,           // { slug, step, done } while this problem is a due revision (fresh attempt);
                          // done = recorded, but later unlocks still don't touch the first solve
  currentTab: 'hints'     // 'hints', 'revision' or 'stats'
};

// Generation nonce — prevents stale concurrent loadHints() calls from
// overwriting a newer result. Each call claims a unique ID; if a newer
// call has started by the time the async work finishes, the old call
// silently discards its result instead of overwriting.
let hintsGenerationId = 0;

// True while loadCurrentProblem() is fetching the problem (not while hints
// generate). Prevents PROBLEM_DETECTED from firing a duplicate load.
let isInitializing = false;

// A problem change that arrived while isInitializing — applied right after
let pendingProblem = null;
// Same, but only the slug is known (the tab's URL changed mid-fetch)
let pendingSlug = '';


// Score values for each level
const SCORE_MAP = { 1: 100, 2: 80, 3: 60, 4: 40, solution: 20 };   // names: SCORE_NAMES
const NEXT_CARD = { 1: 2, 2: 3, 3: 4, 4: 'solution' };

// ─────────────────────────────────────────────
// DOM REFERENCES — grab all elements once
// ─────────────────────────────────────────────
const $ = id => document.getElementById(id);

const DOM = {
  // Header
  problemTitle:   $('problem-title'),
  difficultyBadge: $('difficulty-badge'),
  problemNumber:  $('problem-number'),

  // Tabs
  tabHints:       $('tab-hints'),
  tabStats:       $('tab-stats'),
  tabRevision:    $('tab-revision'),
  tabCompanies:   $('tab-companies'),
  contentHints:   $('content-hints'),
  contentStats:   $('content-stats'),
  contentRevision: $('content-revision'),
  contentCompanies: $('content-companies'),

  // States
  loadingState:   $('loading-state'),
  noProblemState: $('no-problem-state'),
  errorState:     $('error-state'),
  errorMessage:   $('error-message'),
  btnRetry:       $('btn-retry'),
  btnAddKeyError: $('btn-add-key-error'),
  siteChanged:    $('site-changed-banner'),
  hintsLayout:    $('hints-layout'),
  loadingName:    $('loading-problem-name'),

  // Hint cards
  hintCards: {
    1:        $('hint-card-1'),
    2:        $('hint-card-2'),
    3:        $('hint-card-3'),
    4:        $('hint-card-4'),
    solution: $('hint-card-solution')
  },

  // Hint text containers
  hintTexts: {
    1:        $('hint-text-1'),
    2:        $('hint-text-2'),
    3:        $('hint-text-3'),
    4:        $('hint-text-4'),
    solution: $('hint-text-solution')
  },

  // Unlock buttons
  unlockBtns: {
    2:        $('unlock-hint-2'),
    3:        $('unlock-hint-3'),
    4:        $('unlock-hint-4'),
    solution: $('unlock-solution')
  },

  // Score segments
  scoreSegs: {
    1:        $('score-seg-1'),
    2:        $('score-seg-2'),
    3:        $('score-seg-3'),
    4:        $('score-seg-4'),
    solution: $('score-seg-solution')
  },

  // Explanation
  explanationInput: $('explanation-input'),

  // TC/SC
  tcInput:      $('tc-input'),
  scInput:      $('sc-input'),
  btnCheck:     $('btn-check-tcsc'),
  tcscResult:   $('tcsc-result'),
  optimalTcDisplay: $('optimal-tc-display'),
  optimalScDisplay: $('optimal-sc-display'),
  scBreakdown:      $('sc-breakdown'),
  tcMatchIcon:  $('tc-match-icon'),
  scMatchIcon:  $('sc-match-icon'),

  // Company tags
  companyTagsRow: $('company-tags-row'),
  companyBadges:  $('company-badges'),

  // Stats
  statTotal:    $('stat-total'),
  statAvg:      $('stat-avg-score'),
  statBest:     $('stat-best'),
  easyBar:      $('easy-bar'),
  mediumBar:    $('medium-bar'),
  hardBar:      $('hard-bar'),
  easyCount:    $('easy-count'),
  mediumCount:  $('medium-count'),
  hardCount:    $('hard-count'),
  distSolo:     $('dist-solo'),
  distSharp:    $('dist-sharp'),
  distGood:     $('dist-good'),
  distGuide:    $('dist-guide'),
  distRead:     $('dist-read'),
  distSoloCount:  $('dist-solo-count'),
  distSharpCount: $('dist-sharp-count'),
  distGoodCount:  $('dist-good-count'),
  distGuideCount: $('dist-guide-count'),
  distReadCount:  $('dist-read-count'),
  aiStatus:       $('ai-status'),

  // Revision (spaced repetition)
  revisionTabBadge:      $('revision-tab-badge'),
  revisionBar:           $('revision-bar'),
  revisionBarText:       $('revision-bar-text'),
  btnRevisionAdd:        $('btn-revision-add'),
  btnSolved:             $('btn-solved'),
  revisionLimit:         $('revision-limit'),
  revisionDueCount:      $('revision-due-count'),
  revisionDueList:       $('revision-due-list'),
  revisionUpcomingCount: $('revision-upcoming-count'),
  revisionUpcomingList:  $('revision-upcoming-list'),
  revisionMasteredCount: $('revision-mastered-count'),
  revisionMasteredList:  $('revision-mastered-list')
};


// ─────────────────────────────────────────────
// 1. INITIALISE — runs when panel opens
// ─────────────────────────────────────────────
async function init() {
  setupTabListeners();
  setupUnlockListeners();
  setupTcScListener();
  setupExplanationAutoSave();
  setupRetryListener();
  setupActiveTabWatcher();
  setupRevisionListeners();

  // Background, non-blocking — the problem loads in parallel
  loadCompaniesDB();
  removeLegacyKeys();
  // (the server status is checked only when Settings comes into view — extras.js)
  extras.initExtras({
    getProblem:  () => state.problem,
    getHints:    () => state.hints,
    getProgress: () => ({ hintsUnlocked: state.hintsUnlocked, score: state.score, review: !!state.review && !state.review.done }),
    unlockNext:  () => unlockHint(NEXT_CARD[state.hintsUnlocked]),
    isInterviewing: slug => isInterviewActive(slug),
    showToast, switchTab,
    openProblem: slug => { chrome.tabs.update({ url: `https://leetcode.com/problems/${slug}/` }); switchTab('hints'); },
    renderServiceStatus,
    onConfig: cfg => setInterviewOptions({ allowed: cfg.interview, trialMinutes: extras.hasOwnKey() ? 0 : cfg.trialInterviewMinutes })
  });
  DOM.btnAddKeyError?.addEventListener('click', () => extras.openOwnKeySettings());

  await loadLanguagePreference();
  // Mock interview: needs the problem + its verified solution (hidden reference)
  await initInterview({
    getProblem:  () => state.problem,
    getHintsFor: slug => (state.problem?.slug === slug ? state.hints : null),
    showToast,
    isReviewDue: slug => state.review?.slug === slug && !state.review.done,
    onScored:    onInterviewScored,
    openKeySettings: () => extras.openOwnKeySettings()
  });
  renderRevision();   // migrates an old-format queue + the tab badge
  initCompanies({ switchTab, showToast }).catch(e => console.warn('LeetHint: Companies tab unavailable →', e.message));
  await loadCurrentProblem();
}


// ─────────────────────────────────────────────
// 2. TAB SWITCHING
// ─────────────────────────────────────────────
function setupTabListeners() {
  DOM.tabHints.addEventListener('click', () => switchTab('hints'));
  DOM.tabStats.addEventListener('click', () => {
    switchTab('stats');
    renderStats(); // Refresh stats when tab opens
  });
  DOM.tabRevision.addEventListener('click', () => {
    switchTab('revision');
    renderRevision();
  });
  DOM.tabCompanies?.addEventListener('click', () => {
    switchTab('companies');
    renderCompanies();   // re-reads what's solved each time
  });
}

function switchTab(tab) {
  state.currentTab = tab;

  DOM.tabHints.classList.toggle('active', tab === 'hints');
  DOM.tabStats.classList.toggle('active', tab === 'stats');
  DOM.tabRevision.classList.toggle('active', tab === 'revision');
  DOM.contentHints.classList.toggle('active', tab === 'hints');
  DOM.contentStats.classList.toggle('active', tab === 'stats');
  DOM.contentRevision.classList.toggle('active', tab === 'revision');
  DOM.tabCompanies?.classList.toggle('active', tab === 'companies');
  DOM.contentCompanies?.classList.toggle('active', tab === 'companies');
}


// ─────────────────────────────────────────────
// 3. AI SERVICE STATUS — zero configuration
//    All AI calls go through the LeetHint server, which holds the API keys.
//    The Settings card just shows whether that server is reachable.
// ─────────────────────────────────────────────

// Keys from the old bring-your-own-key version — no longer used, so don't
// leave them lying around in local storage
const LEGACY_KEYS = ['geminiApiKey', 'openRouterApiKey', 'groqApiKey', 'cerebrasApiKey',
                     'geminiModel', 'providerCooldowns', 'apiBannerDismissed'];

async function removeLegacyKeys() {
  await chrome.storage.local.remove(LEGACY_KEYS).catch(() => {});
}

async function renderServiceStatus() {
  if (!DOM.aiStatus) return;
  DOM.aiStatus.textContent = 'Checking…';
  const health = await checkBackend();
  DOM.aiStatus.textContent = health.ok
    ? `✅ Connected — no setup needed${health.providers?.length ? ` (${health.providers.join(', ')})` : ''}`
    : '⚠️ Can\'t reach the LeetHint server — hints fall back to Chrome\'s built-in AI';
}


// ─────────────────────────────────────────────
// 4. LOAD PROBLEM + GENERATE HINTS
// ─────────────────────────────────────────────
// "two-sum" → "Two Sum" — shown instantly while the real data loads
const titleFromSlug = slug => slug.split('-').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');

// Ask the service worker for the problem; quick short retries in case
// LeetCode is still rendering (instead of one long fixed wait)
async function fetchCurrentProblem() {
  for (let attempt = 0; attempt < 5; attempt++) {
    const response = await chrome.runtime.sendMessage({ type: 'GET_CURRENT_PROBLEM' }).catch(() => null);
    if (response?.data) return response.data;
    await new Promise(r => setTimeout(r, 300));
  }
  return null;
}

// slugHint: the slug from the tab URL, if known — names the loading screen at once
async function loadCurrentProblem(slugHint = '') {
  isInitializing = true;
  state.hints = null;
  state.review = null;
  resetTcScChecker();
  if (slugHint) DOM.loadingName.textContent = titleFromSlug(slugHint);
  showState('loading');

  let problem = null;
  try {
    problem = await fetchCurrentProblem();
  } finally {
    // Cleared as soon as the PROBLEM is known — NOT after hint generation,
    // which can take a while and would otherwise block switching problems
    isInitializing = false;
  }

  // User switched problems while we were fetching — the newer one wins
  const nextSlug = pendingSlug;
  pendingSlug = '';
  if (pendingProblem) {
    const next = pendingProblem;
    pendingProblem = null;
    if (next?.slug !== problem?.slug) {
      applyProblem(next);
      return;
    }
  }
  if (nextSlug && nextSlug !== problem?.slug?.toLowerCase()) {
    loadCurrentProblem(nextSlug);
    return;
  }

  // Nothing could be read from the page, but the tab IS a problem (LeetCode
  // changed its page): carry on with the slug from the URL — the static
  // hint file is found by slug alone
  if (!problem) {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true }).catch(() => []);
    const slug = slugFromUrl(tab?.url);
    if (slug) problem = { slug, title: titleFromSlug(slug), difficulty: '', problemNumber: '', description: '', topicTags: [], codeSnippets: {} };
  }

  if (!problem) {
    showState('noProblem');
    syncInterview(null);
    pendingInterviewSlug = '';
    return;
  }

  state.problem = problem;
  updateProblemHeader();
  await loadSavedProgress();
  loadHints();   // not awaited — it guards itself against newer loads
}

function updateProblemHeader() {
  const { title, difficulty, problemNumber, slug } = state.problem;

  DOM.problemTitle.textContent = title || 'Unknown Problem';

  // Set difficulty badge
  const diff = (difficulty || 'unknown').toLowerCase();
  DOM.difficultyBadge.textContent = difficulty || '?';
  DOM.difficultyBadge.className = `difficulty-badge ${diff}`;

  DOM.problemNumber.textContent = problemNumber ? `#${problemNumber}` : '';

  // Render company tags from bundled DB
  renderCompanyTags(slug);

  // Show the interview for this problem, or the "Start" button
  syncInterview(state.problem);
  renderRevisionBar();
}

function renderCompanyTags(slug) {
  if (!DOM.companyTagsRow || !DOM.companyBadges) return;

  DOM.companyBadges.innerHTML = '';

  // Look up from bundled DB
  const companies = (companiesDB && slug) ? (companiesDB[slug] || null) : undefined;

  if (Array.isArray(companies) && companies.length > 0) {
    companies.forEach(name => {
      const badge = document.createElement('span');
      badge.className = 'company-badge';
      badge.textContent = name;
      DOM.companyBadges.appendChild(badge);
    });
    DOM.companyTagsRow.style.display = 'flex';
  } else if (companiesDB !== null) {
    // DB is loaded but this problem has no data
    const msg = document.createElement('span');
    msg.className = 'company-no-data';
    msg.textContent = 'No company data available for this problem';
    DOM.companyBadges.appendChild(msg);
    DOM.companyTagsRow.style.display = 'flex';
  } else {
    // DB not yet loaded — hide
    DOM.companyTagsRow.style.display = 'none';
  }
}

async function loadHints() {
  // Claim this generation slot — any older concurrent call will be a lower ID
  const myId = ++hintsGenerationId;

  // Capture the problem now — state.problem may change during the awaits below
  const problem = state.problem;
  DOM.loadingName.textContent = problem.title;
  showState('loading');

  // Check cache first
  const cacheKey = `hints_v3_${problem.slug}`; // v3: verified hint 4 pitfalls + SC breakdown
  const cached = await chrome.storage.local.get(cacheKey);

  // If a newer loadHints() started while we were awaiting, drop this result
  if (myId !== hintsGenerationId) {
    console.log('LeetHint: stale loadHints() call dropped (cache check), id', myId);
    return;
  }

  if (cached[cacheKey]) {
    const cachedHints = cached[cacheKey];

    // If the cached hints have no TC/SC, treat them as stale and regenerate.
    // (Missing code is NOT a reason — regenerating everything would burn API
    // quota; hint 5 shows a "Generate Solution" button for that instead.)
    const tcMissing = !cachedHints.optimal_tc;
    const scMissing = !cachedHints.optimal_sc;
    if (tcMissing || scMissing) {
      console.log('LeetHint: Cached hints incomplete — invalidating and regenerating...');
      await chrome.storage.local.remove(cacheKey);
      // Fall through to fresh generation below
    } else {
      state.hints = cachedHints;
      renderHints();
      showState('hints');
      extras.onHintsReady(state.hints);
      // Cached from a reply whose code never arrived — fetch just the solution
      if (!cachedHints.hint5) fillMissingSolution(myId);
      else if (nearSolution()) prefetchMyTranslation();
      return;
    }
  }

  // LeetCode's page couldn't be read (no statement): only the static file,
  // found by the slug in the URL, can still give correct hints
  if (!problem.description) {
    DOM.siteChanged.hidden = false;
    const fromFile = await fetchStaticHints(problem.slug);
    if (myId !== hintsGenerationId) return;
    if (fromFile) {
      state.hints = fromFile;
      await chrome.storage.local.set({ [cacheKey]: fromFile }).catch(() => {});   // not saved → still shown
      renderHints();
      showState('hints');
      extras.onHintsReady(state.hints);
    } else {
      showState('error', 'LeetCode changed its page, so this problem can\'t be read right now. An update is coming.');
    }
    return;
  }

  // TC/SC comes from the same solve step as the hint 5 code, so it always
  // describes that code — no separate TC/SC cache that could drift from it.

  // Show the hints layout straight away instead of a full-screen spinner;
  // the reply is streamed, so Hint 1 fills in word by word as it's written.
  state.hints = { hint1: '', hint2: '', hint3: '', hint4: '', hint5: '', generating: true };
  renderHints();
  showState('hints');

  let frame = 0;
  try {
    const hints = await generateHints(problem, {
      language: solutionLanguage,   // your language's code arrives in the same reply
      // Every free AI model busy → the server puts us in line; say so in Hint 1
      onWait: ({ position, waitSec }) => {
        if (myId !== hintsGenerationId || state.hints?.hint1) return;
        DOM.hintTexts[1].innerHTML = `<span class="hint-pending hint-waiting">⏳ High demand — you're in line${position > 1 ? ` (#${position})` : ''}, trying again in ~${waitSec} s…</span>`;
      },
      onPartial: partial => {
        if (myId !== hintsGenerationId) return;
        state.hints = { ...partial, hint5: '', generating: true };
        // Stream updates arrive many times a second — render at most once per frame
        if (!frame) {
          frame = requestAnimationFrame(() => {
            frame = 0;
            if (myId === hintsGenerationId) renderHintTexts();
          });
        }
      }
    });
    cancelAnimationFrame(frame);

    // Cache under THIS problem's key even if the user moved on — generation is
    // slow, so coming back to this problem should be instant
    await chrome.storage.local.set({ [cacheKey]: hints });

    // Don't render if a newer call has since started (e.g. user navigated away)
    if (myId !== hintsGenerationId) {
      console.log('LeetHint: stale loadHints() result cached but not shown, id', myId);
      return;
    }

    state.hints = hints;
    renderHintTexts();  // already on screen — just fill in the rest
    extras.onHintsReady(state.hints);
    if (nearSolution()) prefetchMyTranslation();
  } catch (e) {
    cancelAnimationFrame(frame);
    if (myId !== hintsGenerationId) return; // Stale error, ignore
    console.error('LeetHint: hint generation failed →', e);
    if (state.hints?.hint1) {
      // Some hints already arrived — keep them; hint 5 offers "Generate Solution"
      state.hints.generating = false;
      renderHintTexts();
      showToast('❌ ' + e.message);
    } else {
      showState('error', e.message);
      // Out of free trials → the fix is a free key of their own
      DOM.btnAddKeyError.hidden = e.code !== 'trial_used';
    }
  }
}

// Hints are cached but hint 5 is empty — request only the solution (any
// provider with capacity) and store it, so the problem is complete next time
async function fillMissingSolution(myId) {
  const problem = state.problem;
  state.hints.generating = true;
  renderHintTexts();
  try {
    const solved = await validateSolutionCode('', problem);
    if (myId !== hintsGenerationId) return;   // user moved on
    state.hints.generating = false;
    await saveSolutionToCache(solved);
    if (nearSolution()) prefetchMyTranslation();
  } catch (e) {
    if (myId !== hintsGenerationId) return;
    state.hints.generating = false;
    console.warn('LeetHint: could not fill missing solution →', e.message);
  }
  renderHintTexts();
}

function renderHints() {
  if (!state.hints) return;
  renderHintTexts();
  applyUnlockState(state.hintsUnlocked);
}

const PENDING_HTML  = '<span class="hint-pending">⏳ Thinking…</span>';
const SOLUTION_PENDING_HTML = '<span class="hint-pending">⏳ Still being written…</span>';
const CURSOR_HTML   = '<span class="hint-cursor" aria-hidden="true"></span>';

function renderHintTexts() {
  if (!state.hints) return;

  const hintKeys = ['hint1', 'hint2', 'hint3', 'hint4', 'hint5'];
  const cardKeys = [1, 2, 3, 4, 'solution'];

  hintKeys.forEach((key, i) => {
    const cardKey = cardKeys[i];
    const text = state.hints[key] || '';
    if (cardKey === 'solution') {
      if (!text && state.hints.generating) DOM.hintTexts.solution.innerHTML = SOLUTION_PENDING_HTML;
      else renderSolutionCard(text);
    } else if (DOM.hintTexts[cardKey]) {
      const live = state.hints.generating && state.hints.streaming === key;
      DOM.hintTexts[cardKey].innerHTML = (!text && state.hints.generating)
        ? PENDING_HTML
        : formatHintText(text) + (live ? CURSOR_HTML : '');
    }
  });
}

// Renders the solution card with a syntax-highlighted code block + Copy button
function renderSolutionCard(raw) {
  const el = DOM.hintTexts['solution'];
  if (!el) return;

  // Extract fenced code block if present
  const fenceMatch = raw.match(/```(?:cpp|c\+\+)?\s*([\s\S]*?)```/i);
  // Extract code from fence, or use raw text if no fence found
  let code = (fenceMatch ? fenceMatch[1] : raw).trim();

  // Post-process: strip #include, using namespace std, and std:: prefix (LeetCode provides these)
  code = code
    .split('\n')
    .filter(line => !line.trimStart().startsWith('#include') &&
                    !line.trim().startsWith('using namespace std'))
    .join('\n')
    .replace(/std::/g, '')  // remove all std:: prefixes
    .replace(/^\n+/, '')    // remove leading blank lines
    .trim();

  // If no code could be extracted, show a friendly retry message
  if (!code) {
    el.innerHTML = `
      <div class="solution-empty-msg">
        ⚠️ Solution model returned no code.<br>
        Click <strong>🔧 Fix</strong> to generate via the validator, or reload hints.
      </div>
    `;
    // Add a quick Fix button even in the empty state
    const fixBtn = document.createElement('button');
    fixBtn.textContent = '🔧 Generate Solution';
    fixBtn.className = 'btn-validate-code';
    fixBtn.style.margin = '8px 0 0 0';
    fixBtn.addEventListener('click', async () => {
      fixBtn.textContent = '⏳ Generating...';
      fixBtn.disabled = true;
      try {
        const fixed = await validateSolutionCode('', state.problem);
        const note = await saveSolutionToCache(fixed);
        buildSolutionUI(el, fixed.code, '✅ Generated by AI validator' + note);
        showToast('✅ Solution generated!');
      } catch (e) {
        fixBtn.textContent = '🔧 Generate Solution';
        fixBtn.disabled = false;
        showToast('❌ ' + e.message);
      }
    });
    el.appendChild(fixBtn);
    return;
  }

  // Everything after the closing fence = approach note
  const afterFence = fenceMatch ? raw.slice(raw.indexOf('```', raw.indexOf(fenceMatch[0]) + 3) + 3).trim() : '';

  buildSolutionUI(el, code, afterFence);
}


// Persist generated/fixed code into the hints cache so reopening the problem
// shows it again instead of spending another API request.
// The optimal TC/SC follow the code: a fix can change the implementation
// (e.g. recursion → iteration), and with it the space complexity.
// Returns a short " · TC … · SC …" note for the card.
async function saveSolutionToCache({ code, tc, sc, scBreakdown }) {
  if (!state.hints || !state.problem?.slug || !code) return '';
  const note = [tc && `TC ${tc}`, sc && `SC ${sc}`].filter(Boolean).map(x => ' · ' + x).join('');
  state.hints.hint5 = '```cpp\n' + code + '\n```' + (note ? `\nApproach:${note}` : '');
  state.hints.translations = {};   // they were made from the old code
  if (tc) state.hints.optimal_tc = tc;
  if (sc) {
    state.hints.optimal_sc = sc;
    state.hints.sc_breakdown = scBreakdown || '';
  }
  await chrome.storage.local.set({ [`hints_v3_${state.problem.slug}`]: state.hints });

  // Checker already showing a result → refresh it against the new implementation
  if (DOM.tcscResult?.style.display === 'block' && DOM.tcInput.value.trim() && DOM.scInput.value.trim()) {
    checkTcSc();
  }
  return note;
}

// ── Solution language ──
// C++ is the verified solution (its TC/SC is derived from that code); other
// languages are translations of it, made on demand and cached per problem.
let solutionLanguage = 'cpp';
const translationJobs = new Map();   // "slug:lang:codeLength" → Promise<code>

async function loadLanguagePreference() {
  const { solutionLanguage: saved } = await chrome.storage.local.get('solutionLanguage');
  if (saved && LANGUAGES[saved]) solutionLanguage = saved;
}

// Languages LeetCode offers for this problem (all of them if unknown)
function languagesFor(problem) {
  const offered = problem?.codeSnippets;
  return Object.keys(LANGUAGES).filter(l => l === 'cpp' || !offered || Object.keys(offered).length === 0 || offered[l]);
}

// The verified C++ code inside hint 5
const cppCodeOf = hints => (hints?.hint5 || '').match(/```cpp\n([\s\S]*?)```/)?.[1]?.trim() || '';

// Hint 4 or the solution unlocked — the code is about to be needed
const nearSolution = () => state.hintsUnlocked === 4 || state.hintsUnlocked === 'solution';

// Your language normally arrives with the hints. When the server shared hints
// another user generated in a different language, yours is translated here —
// only near the solution, so problems solved with Hints 1-3 spend nothing.
// Any other language is translated only if you switch to it.
function prefetchMyTranslation() {
  const cpp = cppCodeOf(state.hints);
  if (!cpp || !state.problem?.slug || solutionLanguage === 'cpp') return;
  if (!languagesFor(state.problem).includes(solutionLanguage)) return;
  getTranslation(cpp, solutionLanguage)
    .catch(e => console.warn('LeetHint: translation prefetch failed →', e.message));
}

// Translation of the C++ code, from the problem's cache or the server.
// Concurrent requests for the same translation share one job.
async function getTranslation(cppCode, lang) {
  const hints = state.hints;
  const problem = state.problem;
  if (hints?.translations?.[lang]) return hints.translations[lang];

  const jobKey = `${problem.slug}:${lang}:${cppCode.length}`;
  if (!translationJobs.has(jobKey)) {
    const job = translateSolution(cppCode, problem, lang)
      .then(async code => {
        // Save into THIS problem's cached hints, even if the user moved on
        hints.translations = { ...hints.translations, [lang]: code };
        await chrome.storage.local.set({ [`hints_v3_${problem.slug}`]: hints });
        return code;
      })
      .finally(() => translationJobs.delete(jobKey));
    translationJobs.set(jobKey, job);
  }
  return translationJobs.get(jobKey);
}

// Builds (or rebuilds) the solution card UI with code + buttons
function buildSolutionUI(el, code, approachNote) {
  const escape = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const langs = languagesFor(state.problem);
  if (!langs.includes(solutionLanguage)) solutionLanguage = 'cpp';

  el.innerHTML = `
    <div class="solution-code-wrap">
      <div class="solution-code-header">
        <select class="solution-lang-select" title="Solution language" aria-label="Solution language">
          ${langs.map(l => `<option value="${l}"${l === solutionLanguage ? ' selected' : ''}>${LANGUAGES[l].name}</option>`).join('')}
        </select>
        <div class="solution-header-btns">
          <button class="btn-validate-code" title="Validate &amp; fix with AI">🔧 Fix</button>
          <button class="btn-copy-code" title="Copy code">📋 Copy</button>
        </div>
      </div>
      <pre class="solution-pre"><code class="solution-code"></code></pre>
      ${approachNote ? `<p class="solution-approach">${escape(approachNote)}</p>` : ''}
      <p class="solution-translated-note" hidden>Translated from the verified C++ solution — same algorithm, same TC/SC.</p>
      ${/hard/i.test(state.problem?.difficulty || '') ? `<p class="solution-hard-note">⚠️ Hard problem — AI solutions are sometimes wrong here even when every example passes. If LeetCode rejects it, paste what it shows below and press 🔧 Fix.</p>` : ''}
      <details class="solution-failure">
        <summary>Got Wrong Answer or Compile Error on LeetCode?</summary>
        <textarea class="solution-failure-input" rows="4" placeholder="Paste the failing Input, Output and Expected (or the compile error), then press 🔧 Fix"></textarea>
      </details>
    </div>
  `;

  const codeEl   = el.querySelector('.solution-code');
  const select   = el.querySelector('.solution-lang-select');
  const fixBtn   = el.querySelector('.btn-validate-code');
  const copyBtn  = el.querySelector('.btn-copy-code');
  const transNote = el.querySelector('.solution-translated-note');
  const failureBox = el.querySelector('.solution-failure');
  const failureInput = el.querySelector('.solution-failure-input');
  let shownCode = code;   // what Copy copies

  async function showLanguage(lang) {
    const isCpp = lang === 'cpp';
    fixBtn.hidden = !isCpp || !extras.remote().fix;   // Fix works on the verified C++ version (and can be switched off remotely)
    failureBox.hidden = !isCpp;
    transNote.hidden = isCpp;
    if (isCpp) {
      shownCode = code;
      codeEl.textContent = code;
      return;
    }
    shownCode = '';
    codeEl.textContent = `⏳ Translating to ${LANGUAGES[lang].name}…`;
    try {
      const translated = await getTranslation(code, lang);
      if (select.value !== lang || !el.contains(codeEl)) return;   // user picked another / card rebuilt
      shownCode = translated;
      codeEl.textContent = translated;
    } catch (e) {
      if (select.value !== lang) return;
      codeEl.textContent = `⚠️ Couldn't translate to ${LANGUAGES[lang].name}: ${e.message}`;
    }
  }

  select.addEventListener('change', () => {
    solutionLanguage = select.value;
    chrome.storage.local.set({ solutionLanguage }).catch(() => {});
    showLanguage(solutionLanguage);
  });
  showLanguage(solutionLanguage);

  // Wire Copy button
  if (copyBtn) {
    copyBtn.addEventListener('click', () => {
      if (!shownCode) return showToast('⏳ Still translating…');
      navigator.clipboard.writeText(shownCode).then(() => {
        copyBtn.textContent = '✅ Copied!';
        setTimeout(() => { copyBtn.textContent = '📋 Copy'; }, 2000);
      });
    });
  }

  // Wire Fix with AI button
  if (fixBtn) {
    fixBtn.addEventListener('click', async () => {
      fixBtn.textContent = '⏳ Fixing...';
      fixBtn.disabled = true;
      try {
        // LeetCode's failing test (if pasted) is the strongest clue for the fix
        const failure = failureInput.value.trim();
        const fixed = await validateSolutionCode(code, state.problem, failure);
        const note = await saveSolutionToCache(fixed);
        // Rebuild the card with the fixed code
        buildSolutionUI(el, fixed.code, (failure ? '✅ Fixed using the failing test — try submitting again' : '✅ Validated & fixed by AI — ready to submit') + note);
        showToast('✅ Solution validated and fixed!');
      } catch (e) {
        console.error('LeetHint: Validation failed →', e);
        fixBtn.textContent = '🔧 Fix';
        fixBtn.disabled = false;
        showToast(e.code === 'trial_used' ? '⏳ ' + e.message : '❌ Validation failed: ' + e.message);
        if (e.code === 'trial_used' && !el.querySelector('.btn-add-key')) {
          const add = document.createElement('button');
          add.className = 'btn-check btn-add-key';
          add.textContent = 'Add a free key';
          add.addEventListener('click', () => extras.openOwnKeySettings());
          failureBox.after(add);
        }
      }
    });
  }
}


// Convert hint text to HTML — handles code blocks + newlines
function formatHintText(text) {
  // Escape HTML first to prevent XSS
  const escape = s => s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');

  // Split out ```code blocks``` first; everything else is plain text that must
  // be escaped too — otherwise "nums[i] <target" is parsed as an HTML tag and vanishes
  return text.split(/(```\w*\n?[\s\S]*?```)/g).map(part => {
    const block = part.match(/^```(\w*)\n?([\s\S]*?)```$/);
    if (block) {
      return `<pre class="hint-code-block"><code class="lang-${block[1] || 'cpp'}">${escape(block[2].trim())}</code></pre>`;
    }
    return escape(part)
      // Inline `code`
      .replace(/`([^`]+)`/g, (_, code) => `<code class="hint-inline-code">${code}</code>`)
      // **bold** (used for edge-case names in hint 4)
      .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
      // Newlines → <br> (outside code blocks)
      .replace(/\n/g, '<br>');
  }).join('');
}


// ─────────────────────────────────────────────
// 5. UNLOCK LOGIC + SCORE BAR
// ─────────────────────────────────────────────
function setupUnlockListeners() {
  // Map: button id → which card to unlock next
  const unlockMap = {
    'unlock-hint-2':   2,
    'unlock-hint-3':   3,
    'unlock-hint-4':   4,
    'unlock-solution': 'solution'
  };

  Object.entries(unlockMap).forEach(([btnId, nextCard]) => {
    const btn = $(btnId);
    if (btn) {
      btn.addEventListener('click', () => unlockHint(nextCard));
    }
  });
}

function unlockHint(cardKey) {
  // The hint ladder is locked during a mock interview on this problem
  if (isInterviewActive(state.problem?.slug)) return;

  // Update state
  if (cardKey === 'solution') {
    state.hintsUnlocked = 'solution';
    state.score = 20;
  } else {
    state.hintsUnlocked = cardKey;
    state.score = SCORE_MAP[cardKey];
  }

  // Apply visual changes
  applyUnlockState(state.hintsUnlocked);

  // Save progress
  saveProgress();

  // A review attempt only counts once it's solved — the first solve's stats
  // and the queue entry stay as they are
  if (state.review) {
    if (cardKey === 4 || cardKey === 'solution') prefetchMyTranslation();
    return;
  }

  // Update stats
  updateStats();

  // Needing Hint 4 or the solution means this one is worth revisiting
  if (cardKey === 4 || cardKey === 'solution') {
    addToRevisionQueue();
    prefetchMyTranslation();   // your language ready by the time you look
  }
}

function applyUnlockState(unlockedLevel) {
  // Card order
  const order = [1, 2, 3, 4, 'solution'];
  const unlockedIndex = order.indexOf(unlockedLevel);

  order.forEach((key, index) => {
    const card = DOM.hintCards[key];
    const seg  = DOM.scoreSegs[key];
    if (!card || !seg) return;

    if (index < unlockedIndex) {
      // Previously unlocked — open but not current
      card.classList.remove('locked');
      card.classList.add('open');
      seg.classList.remove('locked', 'active');
      seg.classList.add('passed');

    } else if (index === unlockedIndex) {
      // Currently active — open with glow + pop animation
      card.classList.remove('locked');
      card.classList.add('open');
      seg.classList.remove('locked', 'passed');
      seg.classList.add('active');

      // Pop animation — remove & re-add to retrigger
      card.classList.remove('just-unlocked');
      void card.offsetWidth; // force reflow
      card.classList.add('just-unlocked');

      // Scroll to this card smoothly
      setTimeout(() => card.scrollIntoView({ behavior: 'smooth', block: 'nearest' }), 100);

    } else {
      // Still locked
      card.classList.remove('open');
      card.classList.add('locked');
      seg.classList.remove('active', 'passed');
      seg.classList.add('locked');
    }
  });

  // Update score number in active segment with pulse
  const activeScoreEl = DOM.scoreSegs[unlockedLevel]?.querySelector('.score-number');
  if (activeScoreEl) {
    activeScoreEl.style.color = 'var(--accent-green)';
    activeScoreEl.style.animation = 'none';
    void activeScoreEl.offsetWidth;
    activeScoreEl.style.animation = 'scorePulse 0.5s ease';
  }
}


// ─────────────────────────────────────────────
// 6. EXPLANATION AUTO-SAVE
// ─────────────────────────────────────────────
function setupExplanationAutoSave() {
  let debounceTimer;

  DOM.explanationInput.addEventListener('input', () => {
    // Debounce — save only after user stops typing for 800ms
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(async () => {
      if (!state.problem?.slug) return;
      const key = `explanation_${state.problem.slug}`;
      await chrome.storage.local.set({ [key]: DOM.explanationInput.value });
    }, 800);
  });
}


// ─────────────────────────────────────────────
// 7. TC/SC CHECKER
// ─────────────────────────────────────────────
function setupTcScListener() {
  DOM.btnCheck.addEventListener('click', checkTcSc);
}

function checkTcSc() {
  if (!state.hints) {
    showToast('⏳ Hints not loaded yet');
    return;
  }

  const userTc = DOM.tcInput.value.trim();
  const userSc = DOM.scInput.value.trim();

  if (!userTc || !userSc) {
    showToast('Enter both TC and SC first');
    return;
  }

  const optimalTc = state.hints.optimal_tc || '';
  const optimalSc = state.hints.optimal_sc || '';

  // compareComplexity (api/gemini.js) matches equivalent forms: m+n = n+m, n² = n^2 ...
  const tcMatch = compareComplexity(userTc, optimalTc);
  const scMatch = compareComplexity(userSc, optimalSc);

  // Show results
  DOM.optimalTcDisplay.textContent = optimalTc || 'N/A';
  DOM.optimalScDisplay.textContent = optimalSc || 'N/A';

  // SC depends on the implementation — show what in the hint 5 code uses memory
  const breakdown = (state.hints.sc_breakdown || '').trim();
  if (DOM.scBreakdown) {
    DOM.scBreakdown.textContent = breakdown ? 'Space in this solution:\n' + breakdown : '';
    DOM.scBreakdown.hidden = !breakdown;
  }
  DOM.tcMatchIcon.textContent = tcMatch ? '✅' : '❌';
  DOM.scMatchIcon.textContent = scMatch ? '✅' : '❌';
  DOM.tcscResult.style.display = 'block';
}

function resetTcScChecker() {
  if (DOM.siteChanged) DOM.siteChanged.hidden = true;
  if (DOM.tcInput)  DOM.tcInput.value  = '';
  if (DOM.scInput)  DOM.scInput.value  = '';
  if (DOM.tcscResult) DOM.tcscResult.style.display = 'none';
  if (DOM.optimalTcDisplay) DOM.optimalTcDisplay.textContent = '';
  if (DOM.optimalScDisplay) DOM.optimalScDisplay.textContent = '';
  if (DOM.scBreakdown) { DOM.scBreakdown.textContent = ''; DOM.scBreakdown.hidden = true; }
  if (DOM.tcMatchIcon) DOM.tcMatchIcon.textContent = '';
  if (DOM.scMatchIcon) DOM.scMatchIcon.textContent = '';
  // Also clear company tags
  if (DOM.companyTagsRow) DOM.companyTagsRow.style.display = 'none';
  if (DOM.companyBadges)  DOM.companyBadges.innerHTML = '';
}

// ─────────────────────────────────────────────
// 8. PROGRESS SAVE & LOAD
// ─────────────────────────────────────────────
async function saveProgress() {
  if (!state.problem?.slug) return;

  // A review keeps its own progress, so the first attempt's is never overwritten
  if (state.review) {
    await chrome.storage.local.set({
      [REVIEW_PROGRESS + state.problem.slug]: { date: localDate(), hintsUnlocked: state.hintsUnlocked, score: state.score }
    });
    return;
  }

  const progressKey = `progress_${state.problem.slug}`;
  await chrome.storage.local.set({
    [progressKey]: {
      hintsUnlocked: state.hintsUnlocked,
      score: state.score
    }
  });
}

async function loadSavedProgress() {
  if (!state.problem?.slug) return;

  const slug           = state.problem.slug;
  const progressKey    = `progress_${slug}`;
  const explanationKey = `explanation_${slug}`;
  const reviewKey      = REVIEW_PROGRESS + slug;

  // Due for revision today → a fresh attempt
  const { queue, limit } = await getRevisionData();
  state.review = isDueToday(queue, slug, { limit }) ? { slug, step: queue[slug].step } : null;

  const saved = await chrome.storage.local.get([progressKey, explanationKey, reviewKey]);

  if (state.review) {
    // Hints locked and score 100 — earlier hints and the solution are not
    // shown. Only today's attempt is restored (e.g. the panel was reopened).
    const today = saved[reviewKey]?.date === localDate() ? saved[reviewKey] : null;
    state.hintsUnlocked = today?.hintsUnlocked || 1;
    state.score         = today?.score || 100;
  } else if (saved[progressKey]) {
    state.hintsUnlocked = saved[progressKey].hintsUnlocked || 1;
    state.score         = saved[progressKey].score || 100;
  } else {
    // Fresh problem — reset to default
    state.hintsUnlocked = 1;
    state.score = 100;
  }

  // Restore explanation text — clear it when this problem has none, so the
  // previous problem's text isn't shown (and auto-saved) under this one
  DOM.explanationInput.value = saved[explanationKey] || '';

  renderRevisionBar();
  startPendingInterview();
  extras.onProblemShown(state.problem);
}


// ─────────────────────────────────────────────
// 9. STATS — Update & Render
// ─────────────────────────────────────────────
// solved: an Accepted submission (or "✓ I solved it"). Entries from before
// solve detection have no flag — they were logged as solved, so they count.
async function updateStats({ solved = false } = {}) {
  if (!state.problem) return;

  const { stats = {} } = await chrome.storage.local.get('stats');

  const slug       = state.problem.slug;
  const difficulty = (state.problem.difficulty || 'unknown').toLowerCase();
  const level      = state.hintsUnlocked;

  // Initialize if first time
  if (!stats.problems) stats.problems = {};
  if (!stats.byDifficulty) stats.byDifficulty = { easy: 0, medium: 0, hard: 0 };

  // Record this problem's current state
  const prev = stats.problems[slug];
  const isNewProblem = !prev;
  const isSolved = solved || (prev ? prev.solved !== false : false);
  // title / pattern / tags / solvedOn: for déjà-vu links, the CSV and streaks
  stats.problems[slug] = { score: state.score, level, difficulty, solved: isSolved,
                           title: state.problem.title || prev?.title || '', problemNumber: state.problem.problemNumber || prev?.problemNumber || '',
                           pattern: state.hints?.pattern || prev?.pattern || '', topicTags: state.problem.topicTags || prev?.topicTags || [],
                           solvedOn: prev?.solvedOn || (solved ? localDate() : undefined) };

  // Update difficulty count (only for new problems)
  if (isNewProblem && stats.byDifficulty[difficulty] !== undefined) {
    stats.byDifficulty[difficulty]++;
  }

  const allProblems = Object.values(stats.problems);

  // Level distribution — rebuilt from each problem's CURRENT level, so
  // unlocking hint 2 → 3 → 4 on one problem counts it once, not three times
  stats.byLevel = { 1: 0, 2: 0, 3: 0, 4: 0, solution: 0 };
  allProblems.forEach(p => { stats.byLevel[p.level] = (stats.byLevel[p.level] || 0) + 1; });

  // Recalculate totals
  stats.totalProblems = allProblems.length;
  stats.avgScore = Math.round(
    allProblems.reduce((sum, p) => sum + p.score, 0) / allProblems.length
  );
  stats.bestScore = Math.max(...allProblems.map(p => p.score));

  await chrome.storage.local.set({ stats });
}

async function renderStats() {
  const { stats = {} } = await chrome.storage.local.get('stats');

  const total = stats.totalProblems || 0;
  DOM.statTotal.textContent = total;
  DOM.statAvg.textContent   = stats.avgScore   ? `${stats.avgScore}` : '—';
  DOM.statBest.textContent  = stats.bestScore  ? `${stats.bestScore}` : '—';

  // Difficulty bars
  const diff = stats.byDifficulty || { easy: 0, medium: 0, hard: 0 };
  const maxDiff = Math.max(diff.easy, diff.medium, diff.hard, 1);

  DOM.easyCount.textContent   = diff.easy;
  DOM.mediumCount.textContent = diff.medium;
  DOM.hardCount.textContent   = diff.hard;
  DOM.easyBar.style.width     = `${(diff.easy / maxDiff) * 100}%`;
  DOM.mediumBar.style.width   = `${(diff.medium / maxDiff) * 100}%`;
  DOM.hardBar.style.width     = `${(diff.hard / maxDiff) * 100}%`;

  // Hint level distribution
  const byLevel = stats.byLevel || {};
  const maxLevel = Math.max(...Object.values(byLevel), 1);

  const levelMap = {
    1: [DOM.distSolo,  DOM.distSoloCount],
    2: [DOM.distSharp, DOM.distSharpCount],
    3: [DOM.distGood,  DOM.distGoodCount],
    4: [DOM.distGuide, DOM.distGuideCount],
    solution: [DOM.distRead, DOM.distReadCount]
  };

  Object.entries(levelMap).forEach(([key, [bar, count]]) => {
    const val = byLevel[key] || 0;
    bar.style.width     = `${(val / maxLevel) * 100}%`;
    count.textContent   = val;
  });

  await renderInterviewHistory();
  await extras.renderStatsExtras();
}


// ─────────────────────────────────────────────
// 9b. REVISION — spaced repetition (logic in shared/revision.js)
//     revisionQueue: { [slug]: item } — see shared/revision.js for the item.
//     A problem joins when Hint 4 or the solution is opened, or when it is
//     solved with a score of 60 or lower — never twice. Due problems are
//     reviewed as a fresh attempt; the score of that attempt (or the mock
//     interview's scorecard) picks the next interval: 1 → 3 → 7 → 21 → 60 days.
// ─────────────────────────────────────────────
const REVIEW_PROGRESS = 'review_progress_';   // + slug: { date, hintsUnlocked, score }

// "Review as interview" → start the interview once that problem is open
let pendingInterviewSlug = '';
// The same Accepted result can be reported twice (button + shortcut, re-render)
let lastSolve = { slug: '', at: 0 };

// The queue (old-format items migrated) and the daily limit
async function getRevisionData() {
  const { revisionQueue = {}, revisionDailyLimit = DEFAULT_DAILY_LIMIT } =
    await chrome.storage.local.get(['revisionQueue', 'revisionDailyLimit']);
  const limit = clampLimit(revisionDailyLimit);
  const migrated = migrateQueue(revisionQueue, limit);

  // Not reviewed yet → the score follows the first attempt's saved progress
  // (e.g. the solution opened after Hint 4 → READ)
  const unreviewed = Object.keys(migrated.queue)
    .filter(slug => !migrated.queue[slug].mastered && !migrated.queue[slug].history?.length);
  const progress = unreviewed.length
    ? await chrome.storage.local.get(unreviewed.map(slug => `progress_${slug}`))
    : {};
  const scores = Object.fromEntries(unreviewed.map(slug => [slug, progress[`progress_${slug}`]?.score]));
  const synced = syncJoinScores(migrated.queue, scores);

  const queue = synced.queue;
  if (migrated.changed || synced.changed) await chrome.storage.local.set({ revisionQueue: queue });
  return { queue, limit };
}

function setupRevisionListeners() {
  DOM.btnSolved?.addEventListener('click', () => onProblemSolved(state.problem?.slug, { manual: true }));
  DOM.btnRevisionAdd?.addEventListener('click', () => addToRevisionQueue({ manual: true }));
  DOM.revisionLimit?.addEventListener('change', () => {
    const limit = clampLimit(DOM.revisionLimit.value);
    DOM.revisionLimit.value = limit;
    chrome.storage.local.set({ revisionDailyLimit: limit }).catch(() => {});
  });
  // One place that redraws after any change — this panel's, the service
  // worker's migration, or a panel in another window
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (changes.revisionQueue || changes.revisionDailyLimit) renderRevision();
    if (changes.revisionQueue || changes.revisionDailyLimit || changes.stats) renderRevisionBar();
  });
}

// ── Solves ──────────────────────────────────
// First solve → main stats (each problem counted once) and, at GOOD or
// lower, the queue. A solve during a due review → the schedule only.
async function onProblemSolved(slug, { manual = false } = {}) {
  const problem = state.problem;
  if (!problem?.slug || problem.slug.toLowerCase() !== String(slug || '').toLowerCase()) return;
  // During a mock interview the scorecard decides how this attempt counts
  if (isInterviewActive(problem.slug)) {
    if (manual) showToast('🎙️ The interview scorecard will record this one');
    return;
  }
  if (lastSolve.slug === problem.slug && Date.now() - lastSolve.at < 10000) return;
  lastSolve = { slug: problem.slug, at: Date.now() };

  const score = state.score;
  const name = SCORE_NAMES[score] || '';

  if (state.review?.done) {
    if (manual) showToast('🔁 Today’s review is already recorded');
    return;
  }
  if (state.review) {
    const outcome = outcomeForScore(score);
    const item = await recordReview(problem.slug, { score, outcome, via: manual ? 'manual' : 'solve' });
    if (item) showToast(reviewMessage(item, outcome, `${name} (${score})`));
    await extras.onSolved(problem, { score });
    return;
  }

  await updateStats({ solved: true });
  await extras.onSolved(problem, { score });
  const queued = score <= QUEUE_SCORE_MAX && await addToRevisionQueue();
  if (!queued) showToast(`✅ Solved — ${name} (${score})`);
}

// Mock interview finished on a due problem → schedule from the scorecard
async function onInterviewScored(session, card) {
  if (!session?.review) return;
  try {
    const outcome = outcomeForInterview(card.signal, session.hintsGiven);
    const item = await recordReview(session.slug, {
      score: interviewHintScore(session.hintsGiven), outcome, via: 'interview', signal: card.signal
    });
    if (item) showToast(reviewMessage(item, outcome, card.signal));
  } catch (e) {
    console.warn('LeetHint: could not schedule the interview review →', e.message);
  }
}

async function recordReview(slug, { score, outcome, via, signal }) {
  const { queue } = await getRevisionData();
  const item = queue[slug];
  if (!item || item.mastered) return null;
  queue[slug] = applyReview(item, { score, outcome, via, signal, today: localDate() });
  if (state.review?.slug === slug) state.review.done = true;   // done for today
  await chrome.storage.local.set({ revisionQueue: queue });
  await chrome.storage.local.remove(REVIEW_PROGRESS + slug);
  return queue[slug];
}

function reviewMessage(item, outcome, result) {
  if (item.mastered) return `🏆 ${result} at the 60-day step — mastered!`;
  const days = STEPS[item.step];
  const what = outcome === 'up' ? 'up a step' : outcome === 'repeat' ? 'same step' : 'back to the start';
  return `🔁 Review: ${result} — ${what}, next in ${days} day${days === 1 ? '' : 's'}`;
}

// ── Joining the queue ───────────────────────
// manual: the "Add to revision" button — also restarts a mastered problem.
// Returns true when it was added.
async function addToRevisionQueue({ manual = false } = {}) {
  if (!state.problem?.slug) return false;
  const { slug } = state.problem;
  const { queue } = await getRevisionData();
  const existing = queue[slug];
  if (existing && !(manual && existing.mastered)) {
    // Never added twice — but Hint 4 → solution on the same attempt lowers
    // its score from GUIDE to READ
    const lowered = lowerJoinScore(existing, state.score);
    if (lowered !== existing) await chrome.storage.local.set({ revisionQueue: { ...queue, [slug]: lowered } });
    return false;
  }

  const today = localDate();
  queue[slug] = existing
    ? { ...newQueueItem(state.problem, state.score, today), addedAt: existing.addedAt, history: existing.history || [] }
    : newQueueItem(state.problem, state.score, today);
  await chrome.storage.local.set({ revisionQueue: queue });
  showToast('📌 Added to your Revision Queue — first review tomorrow');
  return true;
}

async function markRevisionDone(slug) {
  const { queue } = await getRevisionData();
  if (!queue[slug]) return;
  queue[slug] = markMastered(queue[slug], localDate());
  if (state.review?.slug === slug) state.review.done = true;
  await chrome.storage.local.set({ revisionQueue: queue });
  await chrome.storage.local.remove(REVIEW_PROGRESS + slug);
  showToast('🏆 Marked as mastered');
}

async function reviewAsInterview(slug) {
  if (hasInterview()) {
    showToast('🎙️ Finish or end the current mock interview first');
    return;
  }
  switchTab('hints');
  if (state.problem?.slug === slug && !isInitializing) {
    startInterview();
    return;
  }
  pendingInterviewSlug = slug;
  chrome.tabs.update({ url: `https://leetcode.com/problems/${slug}/` });
}

// Called once a problem's progress (and review state) is loaded
function startPendingInterview() {
  if (!pendingInterviewSlug) return;
  const slug = pendingInterviewSlug;
  pendingInterviewSlug = '';
  if (state.problem?.slug === slug) startInterview();
}

// ── Rendering ───────────────────────────────
const formatDay = day => {
  const n = daysBetween(localDate(), day);
  if (n === 0) return 'today';
  if (n === 1) return 'tomorrow';
  return parseLocalDate(day).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
};

// Hints tab: this problem's place in the queue
async function renderRevisionBar() {
  if (!DOM.revisionBar) return;
  const slug = state.problem?.slug;
  if (!slug) { DOM.revisionBar.hidden = true; return; }

  const [{ queue, limit }, { stats = {} }] = await Promise.all([getRevisionData(), chrome.storage.local.get('stats')]);
  if (state.problem?.slug !== slug) return;
  const item = queue[slug];
  const entry = stats.problems?.[slug];
  const solved = !!entry && entry.solved !== false;

  let text = '', canAdd = false;
  const reviewing = !!state.review && !state.review.done;
  if (reviewing && item) {
    text = `🔁 Review · step ${item.step + 1} of ${STEPS.length} — solve it again without hints`;
  } else if (item?.mastered) {
    text = '🏆 Mastered';
    canAdd = true;
  } else if (item) {
    const planned = planQueue(queue, { limit }).upcoming.find(e => e.slug === slug)?.date || item.nextDue;
    text = `📌 In revision · next review ${formatDay(planned)}`;
  } else if (solved) {
    text = '✅ Solved';
    canAdd = true;
  }
  DOM.revisionBar.hidden = !text;
  DOM.revisionBar.classList.toggle('is-review', reviewing);
  DOM.revisionBarText.textContent = text;
  DOM.btnRevisionAdd.hidden = !canAdd;
}

// Revision tab + the tab's badge
async function renderRevision() {
  if (!DOM.revisionDueList) return;
  const { queue, limit } = await getRevisionData();
  const { dueToday, upcoming, mastered } = planQueue(queue, { limit });

  if (document.activeElement !== DOM.revisionLimit) DOM.revisionLimit.value = limit;
  DOM.revisionTabBadge.textContent = dueToday.length;
  DOM.revisionTabBadge.hidden = !dueToday.length;
  DOM.revisionDueCount.textContent = dueToday.length;
  DOM.revisionUpcomingCount.textContent = upcoming.length;
  DOM.revisionMasteredCount.textContent = mastered.length;

  fillRevisionList(DOM.revisionDueList, dueToday, 'due', 'Nothing due today — nice work!');
  fillRevisionList(DOM.revisionUpcomingList, upcoming, 'upcoming',
    'No upcoming reviews. Problems join when you open Hint 4 or the solution, or solve one with a score of 60 or lower.');
  fillRevisionList(DOM.revisionMasteredList, mastered, 'mastered', 'Nothing mastered yet.');
  extras.renderRevisionExtras();
}

function fillRevisionList(listEl, entries, kind, emptyText) {
  listEl.innerHTML = '';
  if (!entries.length) {
    const empty = document.createElement('li');
    empty.className = 'revision-empty';
    empty.textContent = emptyText;
    listEl.appendChild(empty);
    return;
  }
  entries.forEach(e => listEl.appendChild(revisionRow(e, kind)));
}

// Built with textContent (not innerHTML) — titles come from the page
function revisionRow({ slug, item, overdueDays, date }, kind) {
  const li = document.createElement('li');
  li.className = 'revision-item';

  const info = document.createElement('div');
  info.className = 'revision-info';

  const link = document.createElement('a');
  link.className = 'revision-title';
  link.href = `https://leetcode.com/problems/${slug}/`;
  link.textContent = `${item.problemNumber ? item.problemNumber + '. ' : ''}${item.title || slug}`;
  link.title = link.textContent;
  link.addEventListener('click', e => {
    e.preventDefault();
    // Open in the current LeetCode tab — the tab watcher then loads it in the panel
    chrome.tabs.update({ url: link.href });
    switchTab('hints');
  });

  const meta = document.createElement('span');
  meta.className = 'revision-meta';
  const diff = document.createElement('span');
  const diffName = item.difficulty || 'Unknown';
  diff.className = `${diffName.toLowerCase()}-text`;
  diff.textContent = diffName;

  const step = kind === 'mastered'
    ? `mastered ${formatDay(item.masteredOn)}`
    : `step ${item.step + 1}/${STEPS.length} · ${STEPS[item.step]}d`;
  const last = SCORE_NAMES[lastScore(item)];
  meta.append(diff, ` · ${step}${last ? ` · last ${last}` : ''}`);

  if (kind === 'due') {
    const due = document.createElement('span');
    due.className = overdueDays > 0 ? 'revision-overdue' : '';
    due.textContent = overdueDays > 0 ? ` · ${overdueDays} day${overdueDays === 1 ? '' : 's'} overdue` : ' · due today';
    meta.append(due);
  } else if (kind === 'upcoming') {
    // Rolled over by the daily limit → its original date is earlier
    meta.append(` · due ${formatDay(date)}${date > item.nextDue ? ' (rolled over)' : ''}`);
  }

  info.append(link, meta);
  li.append(info);
  if (kind === 'mastered') return li;

  const actions = document.createElement('div');
  actions.className = 'revision-actions';
  if (kind === 'due') {
    const iv = document.createElement('button');
    iv.className = 'btn-revision-done';
    iv.textContent = '🎙️ Interview';
    iv.title = 'Review as a mock interview — the scorecard sets the next review';
    iv.addEventListener('click', () => reviewAsInterview(slug));
    actions.append(iv);
  }
  const done = document.createElement('button');
  done.className = 'btn-revision-done';
  done.textContent = '✓ Done';
  done.title = 'I know this one — mark it as mastered';
  done.addEventListener('click', () => markRevisionDone(slug));
  actions.append(done);
  li.append(actions);
  return li;
}


// ─────────────────────────────────────────────
// 10. UI HELPERS
// ─────────────────────────────────────────────

// Show one of four states: 'loading' | 'noProblem' | 'error' | 'hints'
function showState(which, errorMsg = '') {
  if (which !== 'error' && DOM.btnAddKeyError) DOM.btnAddKeyError.hidden = true;
  DOM.loadingState.classList.toggle('visible',   which === 'loading');
  DOM.noProblemState.classList.toggle('visible', which === 'noProblem');
  DOM.errorState.style.display  = which === 'error' ? 'flex' : 'none';
  DOM.hintsLayout.style.display = which === 'hints' ? 'grid' : 'none';
  if (which === 'error' && errorMsg) {
    DOM.errorMessage.textContent = errorMsg;
  }
}

function setupRetryListener() {
  DOM.btnRetry.addEventListener('click', () => loadHints());
}

// Brief toast notification
function showToast(message) {
  // Remove existing toast if any
  document.querySelector('.leethint-toast')?.remove();

  const toast = document.createElement('div');
  toast.className = 'leethint-toast';
  toast.textContent = message;
  toast.style.cssText = `
    position: fixed; bottom: 16px; left: 50%; transform: translateX(-50%);
    background: #1c2128; border: 1px solid #30363d; color: #e6edf3;
    padding: 8px 16px; border-radius: 8px; font-size: 12px;
    z-index: 9999; white-space: normal; max-width: 90vw; text-align: center;
    animation: fadeSlideIn 0.3s ease;
  `;
  document.body.appendChild(toast);
  // Long messages (e.g. quota errors) need time to be read
  setTimeout(() => toast.remove(), message.length > 80 ? 8000 : 3000);
}

// ─────────────────────────────────────────────
// 11. LISTEN FOR PROBLEM CHANGES
//     Content script sends PROBLEM_DETECTED when:
//     - Page first loads
//     - User navigates to a new problem (SPA)
// ─────────────────────────────────────────────
chrome.runtime.onMessage.addListener((message) => {
  // ── Non-LeetCode page → clear everything ──────────────────────────
  // Only when it's the tab this panel is showing — a background tab
  // loading some other site must not wipe the panel
  if (message.type === 'NO_PROBLEM') {
    chrome.tabs.query({ active: true, currentWindow: true }).then(([tab]) => {
      if (message.tabId && tab?.id !== message.tabId) return;
      state.problem       = null;
      state.hints         = null;
      state.hintsUnlocked = 1;
      state.score         = 100;
      state.review        = null;
      resetTcScChecker();
      showState('noProblem');
      syncInterview(null);
      renderRevisionBar();
      extras.onProblemShown(null);
    }).catch(() => {});
    return;
  }

  if (message.type === 'PROBLEM_DETECTED' || message.type === 'PROBLEM_CHANGED') {
    applyProblem(message.payload);
  }

  // Content script saw an Accepted submission
  if (message.type === 'PROBLEM_SOLVED') onProblemSolved(message.slug);
  // …a Wrong Answer / Time Limit Exceeded / Runtime Error (tilt detector)
  if (message.type === 'PROBLEM_FAILED' && message.slug === state.problem?.slug) extras.onFailed(message.slug, message.verdict);
  // Run or Submit pressed → a quick look for time-limit risks
  if (message.type === 'CODE_SUBMITTED' && message.slug === state.problem?.slug) extras.checkSpeed();
});

function applyProblem(newProblem) {
  // init()/loadCurrentProblem() still running — don't start a duplicate load,
  // but remember this problem so it's applied once that finishes (never dropped)
  if (isInitializing) {
    console.log('LeetHint: problem change queued — load still in flight');
    pendingProblem = newProblem;
    return;
  }

  // Ignore if it's the same problem we already have
  if (newProblem?.slug && newProblem.slug === state.problem?.slug) return;

  console.log('LeetHint: Problem changed →', newProblem?.title);

  // Reset state for new problem — including TC/SC checker
  state.hints        = null;
  state.hintsUnlocked = 1;
  state.score        = 100;
  state.review       = null;
  resetTcScChecker();

  if (newProblem?.title) {
    // We already have the data from the message — use it directly
    state.problem = newProblem;

    updateProblemHeader();
    loadSavedProgress().then(() => loadHints());
  } else {
    // No data in message — fetch fresh
    loadCurrentProblem();
  }
}


// ─────────────────────────────────────────────
// 12. WATCH THE ACTIVE TAB DIRECTLY
//     Messages from the page can be missed (service worker asleep, content
//     script orphaned after an extension reload, switching between two
//     LeetCode tabs). The URL is the source of truth — if its slug differs
//     from what the panel shows, reload the problem.
// ─────────────────────────────────────────────
let panelWindowId = null;

function slugFromUrl(url) {
  return (String(url || '').match(/leetcode\.com\/problems\/([^/?#]+)/)?.[1] || '').toLowerCase();
}

function syncWithTab(tab) {
  if (!tab?.active || (panelWindowId !== null && tab.windowId !== panelWindowId)) return;
  const slug = slugFromUrl(tab.url);
  if (!slug || slug === state.problem?.slug?.toLowerCase()) return;
  if (isInitializing) {
    pendingSlug = slug;   // checked again once the in-flight fetch finishes
    return;
  }
  console.log('LeetHint: active tab now on', slug, '— reloading panel');
  loadCurrentProblem(slug);
}

function setupActiveTabWatcher() {
  chrome.windows.getCurrent().then(w => { panelWindowId = w.id; }).catch(() => {});

  chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
    if (changeInfo.url) syncWithTab(tab);
  });
  chrome.tabs.onActivated.addListener(({ tabId }) => {
    chrome.tabs.get(tabId).then(syncWithTab).catch(() => {});
  });
}


// ─────────────────────────────────────────────
// KICK OFF
// ─────────────────────────────────────────────
init();
