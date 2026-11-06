// content.js
// Runs directly on LeetCode problem pages
// Job: Extract problem data and send it to the side panel via service worker

// ─────────────────────────────────────────────
// 1. EXTRACT PROBLEM DATA FROM DOM
// ─────────────────────────────────────────────

// needDifficulty: false skips the full-page difficulty scan (when the API already has it)
function getProblemData(needDifficulty = true) {
  // --- TITLE ---
  const titleEl =
    document.querySelector('.text-title-large a') ||
    document.querySelector('[data-cy="question-title"]') ||
    document.querySelector('h1');

  let title = '';
  if (titleEl) {
    title = titleEl.textContent.trim();
  } else {
    const pageTitle = document.title;
    title = pageTitle.replace(' - LeetCode', '').trim();
  }

  // --- DIFFICULTY --- (walks every element, so only when needed)
  let difficulty = 'Unknown';
  const allElements = needDifficulty ? document.querySelectorAll('*') : [];
  for (const el of allElements) {
    const text = el.textContent.trim();
    if (
      (text === 'Easy' || text === 'Medium' || text === 'Hard') &&
      el.children.length === 0
    ) {
      difficulty = text;
      break;
    }
  }

  // --- SLUG & NUMBER ---
  const slug = getCurrentSlug();

  const numberEl = document.querySelector('.text-label-3') ||
                   document.querySelector('[data-cy="question-number"]');
  const problemNumber = numberEl ? numberEl.textContent.trim().replace('.', '') : '';

  // --- DESCRIPTION ---
  // LeetCode class names change frequently — try many selectors in order
  const descEl =
    document.querySelector('[data-track-load="description_content"]') || // Most stable
    document.querySelector('.elfjS') ||                                   // 2023 class
    document.querySelector('[class*="question-content"]') ||              // Wildcard
    document.querySelector('.question-content') ||                        // Old UI
    document.querySelector('[data-key="description-content"]') ||
    document.querySelector('.content__u3I1') ||
    // Last resort: find the description tab panel
    document.querySelector('[role="tabpanel"] .prose') ||
    document.querySelector('[role="tabpanel"]');

  // Use innerHTML → htmlToText (not innerText) so 10<sup>5</sup> becomes 10^5, not "105"
  let description = descEl ? htmlToText(descEl.innerHTML) : '';

  // Extra fallback: grab text from description tab area
  if (!description) {
    const tabPanel = document.querySelector('[data-layout-path="/c0/ts0/t0"]') ||
                     document.querySelector('[class*="description"]');
    if (tabPanel) description = htmlToText(tabPanel.innerHTML);
  }

  return { title, difficulty, slug, problemNumber, description };
}

// Convert LeetCode problem HTML to plain text WITHOUT losing meaning.
// innerText flattens superscripts: "n <= 10<sup>5</sup>" → "n <= 105", which makes
// the AI think brute force is fine. Keep exponents/subscripts explicit instead.
function htmlToText(html) {
  const marked = String(html || '')
    .replace(/<sup>\s*([\s\S]*?)\s*<\/sup>/gi, '^$1')
    .replace(/<sub>\s*([\s\S]*?)\s*<\/sub>/gi, '_$1')
    .replace(/<img[^>]*>/gi, ' [image] ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<li[^>]*>/gi, '\n- ')
    .replace(/<\/(p|div|pre|ul|ol|h\d)>/gi, '\n');
  const doc = new DOMParser().parseFromString(marked, 'text/html');
  return (doc.body.textContent || '')
    .replace(/ /g, ' ')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}


// ─────────────────────────────────────────────
// 1b. ENRICH FROM LEETCODE GRAPHQL
// ─────────────────────────────────────────────
// The DOM is a moving target; LeetCode's own API gives the exact statement,
// the real C++ signature, topic tags and official hints — all of which make
// the AI's hints much more accurate. Same-origin, so no extra permissions.

const graphqlCache = {};

async function fetchQuestionData(slug) {
  if (!slug) return null;
  if (graphqlCache[slug]) return graphqlCache[slug];

  const query = `query questionData($titleSlug: String!) {
    question(titleSlug: $titleSlug) {
      questionFrontendId title difficulty content hints
      topicTags { name }
      codeSnippets { langSlug code }
    }
  }`;

  const csrf = (document.cookie.match(/csrftoken=([^;]+)/) || [])[1] || '';
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5000);

  try {
    const res = await fetch('/graphql', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-csrftoken': csrf },
      body: JSON.stringify({ query, variables: { titleSlug: slug } }),
      signal: controller.signal
    });
    if (!res.ok) return null;
    const q = (await res.json())?.data?.question;
    if (q) graphqlCache[slug] = q;
    return q || null;
  } catch (e) {
    console.log('LeetHint: GraphQL fetch failed, using DOM only', e.message);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// After SPA navigation the OLD problem's DOM lingers for a moment. The title
// link (<a href="/problems/<slug>/">) tells us whether the DOM is current.
function domMatchesSlug(slug) {
  const link = document.querySelector('.text-title-large a');
  if (!link) return true; // unknown layout — can't tell, assume current
  return (link.getAttribute('href') || '').toLowerCase().includes(`/problems/${slug.toLowerCase()}`);
}

async function waitForDomOf(slug, timeoutMs = 6000) {
  const start = Date.now();
  while (!domMatchesSlug(slug) && Date.now() - start < timeoutMs) {
    await new Promise(r => setTimeout(r, 250));
  }
}

async function getEnrichedProblemData() {
  const slug = getCurrentSlug();
  const q = await fetchQuestionData(slug);

  // No API data → we depend on the DOM, so make sure it's the NEW problem's DOM
  if (!q) await waitForDomOf(slug);
  const data = getProblemData(!q?.difficulty);
  if (!q) return data;

  // Premium-locked problems return content: null — keep DOM description then
  const apiDescription = q.content ? htmlToText(q.content) : '';
  // LeetCode's exact starter code per language — used to translate the solution
  const codeSnippets = {};
  for (const s of q.codeSnippets || []) {
    if (SNIPPET_LANGS.includes(s.langSlug)) codeSnippets[s.langSlug] = s.code;
  }

  return {
    ...data,
    title:         q.title || data.title,
    difficulty:    q.difficulty || data.difficulty,
    problemNumber: q.questionFrontendId || data.problemNumber,
    description:   apiDescription || data.description,
    topicTags:     (q.topicTags || []).map(t => t.name),
    officialHints: (q.hints || []).map(htmlToText),
    cppSnippet:    codeSnippets.cpp || '',
    codeSnippets
  };
}

// Same keys as LANGUAGES in shared/prompts.js (content scripts can't import modules)
const SNIPPET_LANGS = ['cpp', 'java', 'python3', 'c', 'javascript', 'typescript', 'csharp', 'golang', 'kotlin', 'swift', 'rust'];


// ─────────────────────────────────────────────
// 2. WAIT FOR LEETCODE TO FINISH RENDERING
// ─────────────────────────────────────────────
// LeetCode is React-based → DOM loads AFTER the JS runs
// We use MutationObserver to detect when content is ready

function waitForProblemAndExtract() {
  // Check if problem title is already in DOM
  const alreadyLoaded = document.querySelector('.text-title-large') ||
                        document.querySelector('[data-cy="question-title"]') ||
                        document.querySelector('h1');

  if (alreadyLoaded) {
    // DOM is ready, extract and send immediately
    sendProblemData();
    return;
  }

  // DOM not ready yet — watch for changes
  const observer = new MutationObserver(() => {
    const titleEl = document.querySelector('.text-title-large') ||
                    document.querySelector('[data-cy="question-title"]') ||
                    document.querySelector('h1');

    if (titleEl && titleEl.textContent.trim()) {
      observer.disconnect(); // Stop watching
      sendProblemData();
    }
  });

  observer.observe(document.body, {
    childList: true,   // Watch for added/removed child elements
    subtree: true      // Watch ALL descendants, not just direct children
  });
}


// ─────────────────────────────────────────────
// 3. SEND DATA TO SERVICE WORKER
// ─────────────────────────────────────────────
// Content script → Service Worker → Side Panel
// Direct content script ↔ side panel messaging is NOT possible

async function sendProblemData(retryCount = 0) {
  const data = await getEnrichedProblemData();

  // Only send if we actually got a title
  if (!data.title) return;

  // User navigated again while we were fetching — that newer nav will send its own
  if (data.slug !== getCurrentSlug()) return;

  // If description is empty, LeetCode might still be rendering
  // Retry up to 3 times with increasing delays
  if (!data.description && retryCount < 3) {
    console.log(`LeetHint: description empty, retrying in ${(retryCount + 1) * 1000}ms...`);
    setTimeout(() => sendProblemData(retryCount + 1), (retryCount + 1) * 1000);
    return;
  }

  console.log(`LeetHint: Sending problem "${data.title}", desc length: ${data.description.length}`);

  try {
    await chrome.runtime.sendMessage({
      type: 'PROBLEM_DETECTED',
      payload: data
    });
  } catch (e) {
    console.log('LeetHint: could not send message', e.message);
  }
}



// ─────────────────────────────────────────────
// 4. LISTEN FOR REQUESTS FROM SIDE PANEL
// ─────────────────────────────────────────────
// Side panel can ask: "hey content script, give me current problem data"

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'GET_PROBLEM_DATA') {
    getEnrichedProblemData().then(data => sendResponse({ success: true, data }));
  }
  return true; // Keep channel open for async
});


// ─────────────────────────────────────────────
// 5. HANDLE SPA NAVIGATION — robust 3-layer approach
// ─────────────────────────────────────────────
// LeetCode is a React SPA. When navigating between problems:
//   - The PAGE does NOT reload
//   - URL changes via history.pushState (not hashchange, not popstate alone)
//   - The old DOM is still present briefly during transition
//
// Fix: URL poll + popstate + title mutation as triple safety net.
// Always verify the SLUG changed before re-sending, and always wait for new DOM.

let lastSlug = '';         // Track by slug, not full URL (avoids query-param false positives)
let navDebounceTimer = null;

function getCurrentSlug() {
  const parts = window.location.pathname.split('/');
  // pathname is /problems/<slug>/... — index 2
  return (parts[2] || '').toLowerCase();
}

function onNavigate() {
  const slug = getCurrentSlug();
  if (!slug || !window.location.pathname.includes('/problems/')) return;
  if (slug === lastSlug) return;   // Same problem — ignore

  lastSlug = slug;
  console.log('LeetHint: Navigation detected → new slug:', slug);

  // Clear any pending debounce
  clearTimeout(navDebounceTimer);

  // Short debounce only — data is fetched by slug from the API, so there is
  // no need to wait for React to re-render (the DOM fallback waits by itself)
  navDebounceTimer = setTimeout(() => {
    waitForNewProblemAndExtract(slug);
  }, 150);
}

// The old title element is still on screen right after navigation, so
// "a title exists" proves nothing. getEnrichedProblemData() fetches by URL
// slug (and waits for the DOM to match the slug if the API is unavailable).
function waitForNewProblemAndExtract(expectedSlug) {
  if (getCurrentSlug() !== expectedSlug) return; // URL changed again — newer nav wins
  sendProblemData();
}

// ── Layer 1: URL poll ────────────────────────────────────────────────────────
// Patching history.pushState here does NOT work: content scripts run in an
// isolated JS world, so LeetCode's own pushState calls never hit our patch.
// A cheap 300ms slug check catches every navigation the other layers miss.
setInterval(onNavigate, 300);

// ── Layer 2: popstate (browser back/forward buttons) ─────────────────────────
window.addEventListener('popstate', onNavigate);

// ── Layer 3: MutationObserver on <title> as final fallback ───────────────────
const titleObserver = new MutationObserver(onNavigate);
const titleEl = document.querySelector('title') || document.head;
titleObserver.observe(titleEl, { childList: true, subtree: true, characterData: true });


// ─────────────────────────────────────────────
// 6. SOLVE DETECTION — read-only
//    Only LISTENS to the page: never adds, changes or patches anything.
//    A solve = an "Accepted" submission result shown soon after the user
//    pressed Submit (button or Ctrl/Cmd+Enter). Old accepted submissions
//    opened from the Submissions tab don't count — no Submit was pressed.
// ─────────────────────────────────────────────
const SUBMIT_WINDOW_MS = 2 * 60 * 1000;
// Results reported as PROBLEM_FAILED (for the tilt detector)
const FAIL_VERDICTS = ['Wrong Answer', 'Time Limit Exceeded', 'Runtime Error'];

function watchForSolves() {
  if (window.__leethintSolveWatch) return;   // re-injected content script
  window.__leethintSolveWatch = true;

  // sawPending: the previous result has gone (or isn't "Accepted") since
  // Submit was pressed, so an old "Accepted" still on screen isn't counted
  // armedText: the result already on screen when Submit was pressed — that
  // one is old; a different final result (or any after a pending state) is new
  let armedUntil = 0, armedSlug = '', armedText = '', sawPending = false, checkTimer = null;
  const resultEl = () => document.querySelector('[data-e2e-locator="submission-result"]');
  const verdictOf = text => (text === 'Accepted' ? 'Accepted' : FAIL_VERDICTS.find(v => text.startsWith(v)) || '');
  const arm = () => {
    armedUntil = Date.now() + SUBMIT_WINDOW_MS;
    armedSlug = getCurrentSlug();
    armedText = resultEl()?.textContent.trim() || '';
    sawPending = false;
    if (!checkTimer) checkTimer = setTimeout(check, 400);
  };
  // Run / Submit pressed → the side panel may check the code's speed (TLE warning)
  const reportRun = kind => chrome.runtime.sendMessage({ type: 'CODE_RUN', slug: getCurrentSlug(), kind }).catch(() => {});

  document.addEventListener('click', e => {
    if (e.target.closest?.('[data-e2e-locator="console-submit-button"]')) { arm(); reportRun('submit'); }
    else if (e.target.closest?.('[data-e2e-locator="console-run-button"]')) reportRun('run');
  }, true);
  document.addEventListener('keydown', e => {
    if (!(e.ctrlKey || e.metaKey)) return;
    if (e.key === 'Enter') { arm(); reportRun('submit'); }
    else if (e.key === "'") reportRun('run');
  }, true);

  // The result panel of THIS submission: "Accepted" → solved; Wrong Answer,
  // Time Limit Exceeded or Runtime Error → failed
  function check() {
    checkTimer = null;
    if (!armedUntil || Date.now() > armedUntil) { armedUntil = 0; return; }
    const text = resultEl()?.textContent.trim() || '';
    const verdict = verdictOf(text);
    if (!verdict) { sawPending = true; return; }
    if (!sawPending && text === armedText) return;   // still the old result
    if (armedSlug !== getCurrentSlug()) { armedUntil = 0; return; }
    armedUntil = 0;   // one result per Submit
    chrome.runtime.sendMessage(verdict === 'Accepted'
      ? { type: 'PROBLEM_SOLVED', slug: armedSlug }
      : { type: 'PROBLEM_FAILED', slug: armedSlug, verdict }).catch(() => {});
  }

  // Cheap: only look while a submission is pending, at most every 400ms
  new MutationObserver(() => {
    if (armedUntil && !checkTimer) checkTimer = setTimeout(check, 400);
  }).observe(document.body, { childList: true, subtree: true, characterData: true });
}


// ─────────────────────────────────────────────
// 7. KICK OFF ON LOAD
// ─────────────────────────────────────────────
lastSlug = getCurrentSlug();
waitForProblemAndExtract();
watchForSolves();

