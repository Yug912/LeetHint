// sidepanel/editor.js — read (never change) the code in LeetCode's editor
// The editor is Monaco, which only puts the VISIBLE lines in the page, so
// its model is read in the page's own JS world. Only for the active tab, and
// only when it shows the given problem. Used by the mock interview, the TLE
// warning and the tilt detector.

// → { code, language } or null
export async function readEditor(slug) {
  if (!slug) return null;
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const onProblem = new RegExp(`leetcode\\.com/problems/${slug}(?:[/?#]|$)`, 'i').test(tab?.url || '');
    if (!tab?.id || !onProblem) return null;
    const [res] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, world: 'MAIN', func: readMonacoCode });
    const r = res?.result;
    return r && typeof r.code === 'string' ? r : null;
  } catch (e) {
    console.warn('LeetHint: could not read the editor →', e.message);
    return null;
  }
}

export async function readEditorCode(slug) {
  return (await readEditor(slug))?.code ?? null;
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
    if (best) return { code: best.getValue(), language: best.getLanguageId?.() || '' };
  }
  const lines = document.querySelectorAll('.monaco-editor .view-lines .view-line');
  return lines.length ? { code: [...lines].map(l => l.textContent.replace(/ /g, ' ')).join('\n'), language: '' } : null;
}
