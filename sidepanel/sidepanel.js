// sidepanel.js — Main logic for the LeetHint side panel
// Connects everything: problem data, hints, score, stats
// Loaded as an ES module (see sidepanel.html)

import { generateHints, validateSolutionCode, compareComplexity, checkBackend,
         translateSolution, translateAll, LANGUAGES } from '../api/ai.js';
import { initInterview, syncInterview, isInterviewActive, renderInterviewHistory } from './interview.js';

// ─────────────────────────────────────────────
// COMPANY DATABASE — loaded once from bundled JSON
// ─────────────────────────────────────────────
let companiesDB = null;

async function loadCompaniesDB() {
  try {
    const url = chrome.runtime.getURL('data/companies.json');
    const res  = await fetch(url);
    companiesDB = await res.json();
    console.log('LeetHint: companiesDB loaded,', Object.keys(companiesDB).length, 'problems');
  } catch (e) {
    console.log('LeetHint: could not load companies.json', e.message);
    companiesDB = {};
  }
}

// ─────────────────────────────────────────────
// STATE — everything about current session
// ─────────────────────────────────────────────
let state = {
  problem: null,          // {title, difficulty, slug, description}
  hints: null,            // {hint1..hint5, optimal_tc, optimal_sc, pattern}
  hintsUnlocked: 1,       // how many hints currently visible (1 = only hint1)
  score: 100,             // current score
  currentTab: 'hints'     // 'hints' or 'stats'
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
const SCORE_MAP = { 1: 100, 2: 80, 3: 60, 4: 40, solution: 20 };
const LEVEL_NAMES = { 1: 'SOLO', 2: 'SHARP', 3: 'GOOD', 4: 'GUIDE', solution: 'READ' };

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
  contentHints:   $('content-hints'),
  contentStats:   $('content-stats'),

  // States
  loadingState:   $('loading-state'),
  noProblemState: $('no-problem-state'),
  errorState:     $('error-state'),
  errorMessage:   $('error-message'),
  btnRetry:       $('btn-retry'),
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
  revisionCount:  $('revision-count'),
  revisionList:   $('revision-list'),
  aiStatus:       $('ai-status')
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

  // Background, non-blocking — the problem loads in parallel
  loadCompaniesDB();
  removeLegacyKeys();
  renderServiceStatus();

  await loadLanguagePreference();
  // Mock interview: needs the problem + its verified solution (hidden reference)
  await initInterview({
    getProblem:  () => state.problem,
    getHintsFor: slug => (state.problem?.slug === slug ? state.hints : null),
    showToast
  });
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
}

function switchTab(tab) {
  state.currentTab = tab;

  DOM.tabHints.classList.toggle('active', tab === 'hints');
  DOM.tabStats.classList.toggle('active', tab === 'stats');
  DOM.contentHints.classList.toggle('active', tab === 'hints');
  DOM.contentStats.classList.toggle('active', tab === 'stats');
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

  if (!problem) {
    showState('noProblem');
    syncInterview(null);
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
      // Cached from a reply whose code never arrived — fetch just the solution
      if (!cachedHints.hint5) fillMissingSolution(myId);
      else if (nearSolution()) prefetchAllTranslations();
      return;
    }
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
    if (nearSolution()) prefetchAllTranslations();
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
    if (nearSolution()) prefetchAllTranslations();
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

// Every other language in ONE request, started when the user gets close to
// the solution — problems solved with Hints 1-3 don't spend AI quota on it.
// Your own language already came with the hints.
const translateAllJobs = new Map();   // "slug:codeLength" → Promise

function prefetchAllTranslations() {
  const hints = state.hints;
  const problem = state.problem;
  const cpp = cppCodeOf(hints);
  if (!cpp || !problem?.slug) return null;
  const missing = languagesFor(problem).filter(l => l !== 'cpp' && !hints.translations?.[l]);
  if (!missing.length) return null;

  const key = `${problem.slug}:${cpp.length}`;
  if (!translateAllJobs.has(key)) {
    const job = translateAll(cpp, problem, missing)
      .then(async got => {
        // Into THIS problem's cached hints, even if the user moved on
        hints.translations = { ...hints.translations, ...got };
        await chrome.storage.local.set({ [`hints_v3_${problem.slug}`]: hints });
        console.log('LeetHint: translations ready →', Object.keys(got).join(', ') || 'none');
        return got;
      })
      .catch(e => { console.warn('LeetHint: translate-all failed →', e.message); return {}; })
      .finally(() => translateAllJobs.delete(key));
    translateAllJobs.set(key, job);
  }
  return translateAllJobs.get(key);
}

// Translation of the C++ code, from the problem's cache or the server.
// Concurrent requests for the same translation share one job.
async function getTranslation(cppCode, lang) {
  const hints = state.hints;
  const problem = state.problem;
  if (hints?.translations?.[lang]) return hints.translations[lang];

  // The all-languages request is running (or can start) — wait for it first
  const all = prefetchAllTranslations();
  if (all) {
    await all;
    if (hints?.translations?.[lang]) return hints.translations[lang];
  }

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
    </div>
  `;

  const codeEl   = el.querySelector('.solution-code');
  const select   = el.querySelector('.solution-lang-select');
  const fixBtn   = el.querySelector('.btn-validate-code');
  const copyBtn  = el.querySelector('.btn-copy-code');
  const transNote = el.querySelector('.solution-translated-note');
  let shownCode = code;   // what Copy copies

  async function showLanguage(lang) {
    const isCpp = lang === 'cpp';
    fixBtn.hidden = !isCpp;          // Fix works on the verified C++ version
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
        const fixed = await validateSolutionCode(code, state.problem);
        const note = await saveSolutionToCache(fixed);
        // Rebuild the card with the fixed code
        buildSolutionUI(el, fixed.code, '✅ Validated & fixed by AI — ready to submit' + note);
        showToast('✅ Solution validated and fixed!');
      } catch (e) {
        console.error('LeetHint: Validation failed →', e);
        fixBtn.textContent = '🔧 Fix';
        fixBtn.disabled = false;
        showToast('❌ Validation failed: ' + e.message);
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

  // Update stats
  updateStats();

  // Needing Hint 4 or the solution means this one is worth revisiting
  if (cardKey === 4 || cardKey === 'solution') {
    addToRevisionQueue();
    prefetchAllTranslations();   // every language ready by the time you look
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

  const progressKey   = `progress_${state.problem.slug}`;
  const explanationKey = `explanation_${state.problem.slug}`;

  const saved = await chrome.storage.local.get([progressKey, explanationKey]);

  if (saved[progressKey]) {
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
}


// ─────────────────────────────────────────────
// 9. STATS — Update & Render
// ─────────────────────────────────────────────
async function updateStats() {
  if (!state.problem) return;

  const { stats = {} } = await chrome.storage.local.get('stats');

  const slug       = state.problem.slug;
  const difficulty = (state.problem.difficulty || 'unknown').toLowerCase();
  const level      = state.hintsUnlocked;

  // Initialize if first time
  if (!stats.problems) stats.problems = {};
  if (!stats.byDifficulty) stats.byDifficulty = { easy: 0, medium: 0, hard: 0 };

  // Record this problem's current state
  const isNewProblem = !stats.problems[slug];
  stats.problems[slug] = { score: state.score, level, difficulty };

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

  await renderRevisionQueue();
  await renderInterviewHistory();
}


// ─────────────────────────────────────────────
// 9b. REVISION QUEUE
//     Problems where the user unlocked Hint 4 or the solution.
//     Stored as revisionQueue: { [slug]: { title, problemNumber, difficulty, level, addedAt } }
// ─────────────────────────────────────────────
async function addToRevisionQueue() {
  if (!state.problem?.slug) return;
  const { slug, title, problemNumber, difficulty } = state.problem;

  const { revisionQueue = {} } = await chrome.storage.local.get('revisionQueue');
  const existing = revisionQueue[slug];

  // Keep the original date so the queue stays oldest-first; just update the level
  revisionQueue[slug] = {
    title, problemNumber, difficulty,
    level:   state.hintsUnlocked,
    addedAt: existing?.addedAt || Date.now()
  };
  await chrome.storage.local.set({ revisionQueue });

  if (!existing) showToast('📌 Added to your Revision Queue');
}

async function removeFromRevisionQueue(slug) {
  const { revisionQueue = {} } = await chrome.storage.local.get('revisionQueue');
  delete revisionQueue[slug];
  await chrome.storage.local.set({ revisionQueue });
  await renderRevisionQueue();
  showToast('✅ Marked as revised');
}

async function renderRevisionQueue() {
  if (!DOM.revisionList) return;
  const { revisionQueue = {} } = await chrome.storage.local.get('revisionQueue');

  // Oldest first — those are the ones due for revision
  const entries = Object.entries(revisionQueue).sort(([, a], [, b]) => a.addedAt - b.addedAt);

  DOM.revisionCount.textContent = entries.length;
  DOM.revisionList.innerHTML = '';

  if (!entries.length) {
    const empty = document.createElement('li');
    empty.className = 'revision-empty';
    empty.textContent = 'Nothing to revise yet — nice work!';
    DOM.revisionList.appendChild(empty);
    return;
  }

  // Built with textContent (not innerHTML) — titles come from the page
  entries.forEach(([slug, item]) => {
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
    const added = new Date(item.addedAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
    meta.append(diff, ` · ${LEVEL_NAMES[item.level] || ''} · added ${added}`);

    info.append(link, meta);

    const done = document.createElement('button');
    done.className = 'btn-revision-done';
    done.textContent = '✓ Done';
    done.title = 'Re-solved it — remove from the queue';
    done.addEventListener('click', () => removeFromRevisionQueue(slug));

    li.append(info, done);
    DOM.revisionList.appendChild(li);
  });
}


// ─────────────────────────────────────────────
// 10. UI HELPERS
// ─────────────────────────────────────────────

// Show one of four states: 'loading' | 'noProblem' | 'error' | 'hints'
function showState(which, errorMsg = '') {
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
      resetTcScChecker();
      showState('noProblem');
      syncInterview(null);
    }).catch(() => {});
    return;
  }

  if (message.type === 'PROBLEM_DETECTED' || message.type === 'PROBLEM_CHANGED') {
    applyProblem(message.payload);
  }
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
