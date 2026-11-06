// sidepanel/editor.js
// Reads (never writes) the LeetCode editor: its code and language, for the
// TLE warning and the tilt detector's "code changed" signal. Monaco only puts
// the VISIBLE lines in the page, so its model is read in the page's own JS
// world — only on the active tab, only when it shows this problem.

export async function readEditor(slug) {
  if (!slug) return null;
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const onProblem = new RegExp(`leetcode\\.com/problems/${slug}(?:[/?#]|$)`, 'i').test(tab?.url || '');
    if (!tab?.id || !onProblem) return null;
    const [res] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, world: 'MAIN', func: readMonacoModel });
    const r = res?.result;
    return r && typeof r.code === 'string' ? r : null;
  } catch {
    return null;
  }
}

// Runs inside the page — must be self-contained
function readMonacoModel() {
  const api = window.monaco?.editor;
  if (!api) return null;
  const fromEditors = (api.getEditors?.() || []).map(e => e.getModel?.()).filter(Boolean);
  const pool = (fromEditors.length ? fromEditors : api.getModels?.() || []).filter(m => !m.isDisposed?.());
  const best = pool.filter(m => (m.getLanguageId?.() || '') !== 'plaintext')
                   .sort((a, b) => b.getValueLength() - a.getValueLength())[0];
  return best ? { code: best.getValue(), language: best.getLanguageId?.() || '' } : null;
}
