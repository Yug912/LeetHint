// sidepanel.js — Main logic for the LeetHint side panel
// Connects everything: problem data, hints, score, stats

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

// True while init() → loadCurrentProblem() is still in flight.
// Prevents PROBLEM_DETECTED message handler from firing a duplicate load.
let isInitializing = false;

// A problem change that arrived while isInitializing — applied right after
let pendingProblem = null;


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

  // API Banner
  apiBanner:      $('api-banner'),
  btnAddKey:      $('btn-add-key'),
  btnDismiss:     $('btn-dismiss'),
  apiKeySection:  $('api-key-section'),
  apiKeyInput:    $('api-key-input'),
  btnSaveKey:     $('btn-save-key'),
  btnCancelKey:   $('btn-cancel-key'),

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
  keyStatus:    $('key-status'),
  btnChangeKey: $('btn-change-key'),
  // OpenRouter key (recommended, highest priority)
  orKeyStatus:  $('or-key-status'),
  btnChangeOrKey: $('btn-change-or-key'),
  orKeySection: $('or-key-section'),
  orKeyInput:   $('or-key-input'),
  btnSaveOrKey: $('btn-save-or-key'),
  btnCancelOrKey: $('btn-cancel-or-key')
};


// ─────────────────────────────────────────────
// 1. INITIALISE — runs when panel opens
// ─────────────────────────────────────────────
async function init() {
  setupTabListeners();
  setupApiKeyListeners();
  setupOpenRouterKeyListeners();
  setupUnlockListeners();
  setupTcScListener();
  setupExplanationAutoSave();
  setupRetryListener();
  setupActiveTabWatcher();

  // Load bundled company DB in background (non-blocking)
  loadCompaniesDB();

  await checkApiKeyStatus();
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
// 3. API KEY BANNER & SETTINGS
// ─────────────────────────────────────────────
async function checkApiKeyStatus() {
  const { geminiApiKey, openRouterApiKey, apiBannerDismissed } = await chrome.storage.local.get([
    'geminiApiKey', 'openRouterApiKey', 'apiBannerDismissed'
  ]);

  // Update OpenRouter status
  if (DOM.orKeyStatus) {
    DOM.orKeyStatus.textContent = openRouterApiKey
      ? '✅ OpenRouter active — DeepSeek R1 solves, Gemini 2.5 Flash writes hints'
      : 'Not set — add for best results';
    if (DOM.btnChangeOrKey) DOM.btnChangeOrKey.textContent = openRouterApiKey ? 'Change' : 'Set Key';
  }

  // Update Gemini status
  if (geminiApiKey) {
    DOM.apiBanner.style.display = 'none';
    DOM.keyStatus.textContent = geminiApiKey ? '✅ Gemini key active (fallback)' : 'Not set';
  } else if (apiBannerDismissed) {
    DOM.apiBanner.style.display = 'none';
  }

  // Hide banner if OpenRouter is set (no need to ask for Gemini)
  if (openRouterApiKey) DOM.apiBanner.style.display = 'none';
}

function setupApiKeyListeners() {
  // "Add Key" → show input field
  DOM.btnAddKey.addEventListener('click', () => {
    DOM.apiBanner.style.display = 'none';
    DOM.apiKeySection.classList.add('visible');
    DOM.apiKeyInput.focus();
  });

  // "Maybe Later" → dismiss banner forever
  DOM.btnDismiss.addEventListener('click', async () => {
    DOM.apiBanner.style.display = 'none';
    await chrome.storage.local.set({ apiBannerDismissed: true });
  });

  // "Save" → save key
  DOM.btnSaveKey.addEventListener('click', saveApiKey);

  // "Cancel" → hide input
  DOM.btnCancelKey.addEventListener('click', () => {
    DOM.apiKeySection.classList.remove('visible');
  });

  // Settings tab "Change Key" button
  DOM.btnChangeKey.addEventListener('click', () => {
    switchTab('hints');
    DOM.apiBanner.style.display = 'none';
    DOM.apiKeySection.classList.add('visible');
    DOM.apiKeyInput.focus();
  });
}

async function saveApiKey() {
  const key = DOM.apiKeyInput.value.trim();
  if (!key) return;

  await chrome.storage.local.set({ geminiApiKey: key });
  DOM.apiKeySection.classList.remove('visible');
  DOM.keyStatus.textContent = '✅ Gemini key active (fallback)';
  DOM.apiKeyInput.value = '';
  if (DOM.btnChangeKey) DOM.btnChangeKey.textContent = 'Change';

  // Show brief confirmation
  showToast('✅ Gemini key saved!');
}

// ─────────────────────────────────────────────
// 3b. OPENROUTER KEY MANAGEMENT
// ─────────────────────────────────────────────
function setupOpenRouterKeyListeners() {
  if (!DOM.btnChangeOrKey) return;

  DOM.btnChangeOrKey.addEventListener('click', () => {
    switchTab('stats');
    DOM.orKeySection.classList.add('visible');
    DOM.orKeyInput.focus();
  });

  DOM.btnSaveOrKey.addEventListener('click', saveOpenRouterKey);

  DOM.btnCancelOrKey.addEventListener('click', () => {
    DOM.orKeySection.classList.remove('visible');
  });
}

async function saveOpenRouterKey() {
  const key = DOM.orKeyInput.value.trim();
  if (!key) return;

  await chrome.storage.local.set({ openRouterApiKey: key });
  DOM.orKeySection.classList.remove('visible');
  DOM.orKeyStatus.textContent = '✅ OpenRouter active — DeepSeek R1 solves, Gemini 2.5 Flash writes hints';
  DOM.btnChangeOrKey.textContent = 'Change';
  DOM.orKeyInput.value = '';
  DOM.apiBanner.style.display = 'none'; // hide banner — OR key is better

  // Invalidate all cached hints so they regenerate with the new key/model
  const all = await chrome.storage.local.get(null);
  const staleKeys = Object.keys(all).filter(k => k.startsWith('hints_'));
  if (staleKeys.length) await chrome.storage.local.remove(staleKeys);

  showToast('✅ OpenRouter key saved! Regenerating hints...');
}


// ─────────────────────────────────────────────
// 4. LOAD PROBLEM + GENERATE HINTS
// ─────────────────────────────────────────────
async function loadCurrentProblem() {
  isInitializing = true;
  showState('loading');

  try {
    // Ask service worker for current problem
    let response = await chrome.runtime.sendMessage({ type: 'GET_CURRENT_PROBLEM' });

    // If no data, LeetCode React might still be rendering — wait and retry once
    if (!response?.data) {
      await new Promise(r => setTimeout(r, 1500));
      response = await chrome.runtime.sendMessage({ type: 'GET_CURRENT_PROBLEM' });
    }

    if (!response?.data) {
      showState('noProblem');
      return;
    }

    state.problem = response.data;
    updateProblemHeader();
    await loadSavedProgress();
    await loadHints();
  } finally {
    // Always clear the flag so future PROBLEM_DETECTED messages are handled
    isInitializing = false;
  }

  // User switched problems while we were loading — catch up now
  if (pendingProblem) {
    const next = pendingProblem;
    pendingProblem = null;
    applyProblem(next);
  }
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
      return;
    }
  }

  // TC/SC comes from the same solve step as the hint 5 code, so it always
  // describes that code — no separate TC/SC cache that could drift from it.

  // Generate fresh hints directly (gemini.js loaded via script tag).
  // The reply is streamed: each finished hint is shown right away, while the
  // later hints and the solution are still being written.
  let partialShown = false;
  try {
    const hints = await generateHints(problem, {
      onPartial: partial => {
        if (myId !== hintsGenerationId) return;
        state.hints = { ...partial, hint5: '', generating: true };
        if (!partialShown) {
          partialShown = true;
          renderHints();
          showState('hints');
        } else {
          renderHintTexts();  // no unlock animation / scroll on every update
        }
      }
    });

    // Cache under THIS problem's key even if the user moved on — generation is
    // slow, so coming back to this problem should be instant
    await chrome.storage.local.set({ [cacheKey]: hints });

    // Don't render if a newer call has since started (e.g. user navigated away)
    if (myId !== hintsGenerationId) {
      console.log('LeetHint: stale loadHints() result cached but not shown, id', myId);
      return;
    }

    state.hints = hints;
    if (partialShown) {
      renderHintTexts();  // already on screen — just fill in the rest
    } else {
      renderHints();
      showState('hints');
    }
  } catch (e) {
    if (myId !== hintsGenerationId) return; // Stale error, ignore
    console.error('LeetHint: hint generation failed →', e);
    if (partialShown && state.hints?.hint1) {
      // Some hints already arrived — keep them; hint 5 offers "Generate Solution"
      state.hints.generating = false;
      renderHintTexts();
      showToast('❌ ' + e.message);
    } else {
      showState('error', e.message);
    }
  }
}

function renderHints() {
  if (!state.hints) return;
  renderHintTexts();
  applyUnlockState(state.hintsUnlocked);
}

const PENDING_HTML = '<span class="hint-pending">⏳ Still being written…</span>';

function renderHintTexts() {
  if (!state.hints) return;

  const hintKeys = ['hint1', 'hint2', 'hint3', 'hint4', 'hint5'];
  const cardKeys = [1, 2, 3, 4, 'solution'];

  hintKeys.forEach((key, i) => {
    const cardKey = cardKeys[i];
    const text = state.hints[key] || '';
    if (cardKey === 'solution') {
      if (!text && state.hints.generating) DOM.hintTexts.solution.innerHTML = PENDING_HTML;
      else renderSolutionCard(text);
    } else if (DOM.hintTexts[cardKey]) {
      DOM.hintTexts[cardKey].innerHTML = (!text && state.hints.generating) ? PENDING_HTML : formatHintText(text);
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

// Builds (or rebuilds) the solution card UI with code + buttons
function buildSolutionUI(el, code, approachNote) {
  const escape = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  el.innerHTML = `
    <div class="solution-code-wrap">
      <div class="solution-code-header">
        <span class="solution-lang-badge">C++</span>
        <div class="solution-header-btns">
          <button class="btn-validate-code" title="Validate &amp; fix with AI">🔧 Fix</button>
          <button class="btn-copy-code" title="Copy code">📋 Copy</button>
        </div>
      </div>
      <pre class="solution-pre"><code class="solution-code">${escape(code)}</code></pre>
      ${approachNote ? `<p class="solution-approach">${escape(approachNote)}</p>` : ''}
    </div>
  `;

  // Wire Copy button
  const copyBtn = el.querySelector('.btn-copy-code');
  if (copyBtn) {
    copyBtn.addEventListener('click', () => {
      navigator.clipboard.writeText(code).then(() => {
        copyBtn.textContent = '✅ Copied!';
        setTimeout(() => { copyBtn.textContent = '📋 Copy'; }, 2000);
      });
    });
  }

  // Wire Fix with AI button
  const fixBtn = el.querySelector('.btn-validate-code');
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

  // Restore explanation text
  if (saved[explanationKey]) {
    DOM.explanationInput.value = saved[explanationKey];
  }
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
  if (!stats.byLevel) stats.byLevel = { 1: 0, 2: 0, 3: 0, 4: 0, solution: 0 };

  // Record this problem's current state
  const isNewProblem = !stats.problems[slug];
  stats.problems[slug] = { score: state.score, level, difficulty };

  // Update difficulty count (only for new problems)
  if (isNewProblem && stats.byDifficulty[difficulty] !== undefined) {
    stats.byDifficulty[difficulty]++;
  }

  // Update level distribution
  // Reset old level count for this problem, add new
  stats.byLevel[level] = (stats.byLevel[level] || 0) + 1;

  // Recalculate totals
  const allProblems = Object.values(stats.problems);
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
  if (message.type === 'NO_PROBLEM') {
    state.problem       = null;
    state.hints         = null;
    state.hintsUnlocked = 1;
    state.score         = 100;
    resetTcScChecker();
    showState('noProblem');
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

    // Clear stale hints immediately so the UI never shows the wrong problem
    if (DOM.hintsContainer) DOM.hintsContainer.innerHTML = '';
    if (DOM.tcValue) DOM.tcValue.textContent = '—';
    if (DOM.scValue) DOM.scValue.textContent = '—';

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
  if (isInitializing) return; // the in-flight load (or its queued follow-up) handles it
  console.log('LeetHint: active tab now on', slug, '— reloading panel');
  loadCurrentProblem();
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
