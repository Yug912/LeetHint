// service-worker.js
// Ephemeral background script — NO global state variables!
// All state lives in chrome.storage

// AI generation happens in sidepanel.js (has window access)
// Service worker only handles storage + tab management

// ─────────────────────────────────────────────
// SIDE PANEL — per tab, only on LeetCode problem pages
// The panel is DISABLED globally and enabled per tab. A tab-specific panel
// is hidden automatically when you switch to another tab (e.g. a new tab)
// and comes back when you return. Opening it with { windowId } instead would
// make it window-wide — it would then follow you into every tab.
// ─────────────────────────────────────────────
const PANEL_PATH = 'sidepanel/sidepanel.html';
const isProblemUrl = url => /^https:\/\/leetcode\.com\/problems\/[^/?#]+/.test(url || '');

function syncPanelForTab(tabId, url) {
  return chrome.sidePanel.setOptions(
    isProblemUrl(url) ? { tabId, path: PANEL_PATH, enabled: true } : { tabId, enabled: false }
  ).catch(() => {});   // tab may have closed meanwhile
}

// Global default off, then enable it for LeetCode tabs that are already open
async function initPanels() {
  await chrome.sidePanel.setOptions({ enabled: false });
  const tabs = await chrome.tabs.query({});
  await Promise.all(tabs.map(t => syncPanelForTab(t.id, t.url)));
}
chrome.runtime.onInstalled.addListener(initPanels);
chrome.runtime.onStartup.addListener(initPanels);

// Open the panel for THIS tab when the icon is clicked on a LeetCode problem.
// Not awaited before open(): sidePanel.open() must run while the click still
// counts as a user gesture. Both calls are queued in order.
chrome.action.onClicked.addListener((tab) => {
  if (!isProblemUrl(tab.url)) return;
  chrome.sidePanel.setOptions({ tabId: tab.id, path: PANEL_PATH, enabled: true });
  chrome.sidePanel.open({ tabId: tab.id }).catch(e => console.warn('LeetHint SW: could not open panel', e.message));
});

// Keep each tab's panel in step with its URL — including in-page (SPA)
// navigation, which changes the URL without a 'complete' load
chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (!changeInfo.url && changeInfo.status !== 'complete') return;
  const url = changeInfo.url || tab.url;

  await syncPanelForTab(tabId, url);

  // Only send NO_PROBLEM if this tab explicitly navigated to a non-LeetCode URL
  // (Don't fire on tab switches — only on actual page navigations)
  if (!isProblemUrl(url) && url && !url.startsWith('chrome://') && !url.startsWith('chrome-extension://')) {
    await chrome.storage.local.remove('currentProblem');
    chrome.runtime.sendMessage({ type: 'NO_PROBLEM', tabId }).catch(() => {});
  }
});


// ─────────────────────────────────────────────
// SPA NAVIGATION DETECTION (the correct way)
// chrome.webNavigation.onHistoryStateUpdated fires when LeetCode's
// React router calls history.pushState() — i.e. navigates between problems.
// tabs.onUpdated with status:'complete' does NOT fire for SPA navigation.
// ─────────────────────────────────────────────

let lastDetectedSlug = '';

// Get problem data from the tab's content script, injecting it first if it
// isn't there (e.g. tab opened before the extension was installed/reloaded).
// Polls briefly instead of sleeping a fixed second after injecting.
async function askContentScript(tabId) {
  try {
    const res = await chrome.tabs.sendMessage(tabId, { type: 'GET_PROBLEM_DATA' });
    if (res?.data?.title) return res.data;
  } catch (e) {
    console.log('LeetHint SW: content script not ready, injecting...');
    await chrome.scripting.executeScript({ target: { tabId }, files: ['content/content.js'] }).catch(() => {});
  }
  for (let attempt = 0; attempt < 8; attempt++) {
    const res = await chrome.tabs.sendMessage(tabId, { type: 'GET_PROBLEM_DATA' }).catch(() => null);
    if (res?.data?.title) return res.data;
    await new Promise(r => setTimeout(r, 150));
  }
  return null;
}

chrome.webNavigation.onHistoryStateUpdated.addListener(async (details) => {
  const url  = details.url || '';
  const match = url.match(/leetcode\.com\/problems\/([^/?#]+)/);
  if (!match) return;

  const newSlug = match[1].toLowerCase();
  if (newSlug === lastDetectedSlug) return;   // Same problem — ignore
  lastDetectedSlug = newSlug;

  console.log('LeetHint SW: SPA nav detected → slug:', newSlug);

  // Clear stale cached problem immediately
  await chrome.storage.local.remove('currentProblem');

  // Brief pause so a rapid second navigation can cancel this one. The content
  // script fetches by slug from the API, so it doesn't need React to re-render.
  await new Promise(r => setTimeout(r, 150));

  // Verify tab still has the same slug (user didn't navigate again)
  try {
    const tab = await chrome.tabs.get(details.tabId);
    if (!tab.url || !tab.url.includes(newSlug)) {
      console.log('LeetHint SW: slug changed again, aborting');
      return;
    }

    // Ask content script for fresh problem data
    const data = await askContentScript(details.tabId);

    if (data?.title) {
      console.log('LeetHint SW: New problem →', data.title);
      await chrome.storage.local.set({ currentProblem: data });
      // Broadcast to sidepanel
      chrome.runtime.sendMessage({ type: 'PROBLEM_DETECTED', payload: data }).catch(() => {});
    } else {
      console.warn('LeetHint SW: Could not extract problem data for slug:', newSlug);
    }
  } catch (e) {
    console.warn('LeetHint SW: onHistoryStateUpdated handler error:', e.message);
  }
}, {
  url: [{ hostContains: 'leetcode.com', pathContains: '/problems/' }]
});




// Handle messages from content script and side panel
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  (async () => {

    // Content script detected a problem — store it
    if (message.type === 'PROBLEM_DETECTED') {
      await chrome.storage.local.set({
        currentProblem: message.payload
      });
      sendResponse({ success: true });
    }

    // Side panel is asking for the current problem
    if (message.type === 'GET_CURRENT_PROBLEM') {
      try {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

        if (!tab?.url?.includes('leetcode.com/problems/')) {
          // Not on a LeetCode problem page — clear stale data
          await chrome.storage.local.remove('currentProblem');
          sendResponse({ success: true, data: null });
          return;
        }

        // ── FAST PATH: return cached data — only if it's for THIS tab's problem ──
        const tabSlug = (tab.url.match(/leetcode\.com\/problems\/([^/?#]+)/)?.[1] || '').toLowerCase();
        const stored = await chrome.storage.local.get('currentProblem');
        if (stored.currentProblem?.title && stored.currentProblem.slug?.toLowerCase() === tabSlug) {
          sendResponse({ success: true, data: stored.currentProblem });
          return;
        }

        // ── SLOW PATH: storage empty — ask content script directly ──
        const data = await askContentScript(tab.id);
        if (data?.title) {
          await chrome.storage.local.set({ currentProblem: data });
          sendResponse({ success: true, data });
          return;
        }

      } catch (e) {
        console.log('LeetHint SW: tab query failed', e.message);
      }

      // Final fallback
      sendResponse({ success: true, data: null });
    }

  })();
  return true; // Keep channel open for async response
});
