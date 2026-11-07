// sidepanel/editor.js — read (never change) the code in LeetCode's editor.
// Used by the mock interview, the tilt detector and the TLE check.
//
// The LeetCode editor is Monaco, which only puts the VISIBLE lines in the
// page, so its model is read in the page's own JS world. Only for the active
// tab, and only when it shows the given problem.

// Monaco language id → our language key (shared/prompts.js LANGUAGES)
const LANG_IDS = { cpp: 'cpp', 'c++': 'cpp', java: 'java', python: 'python3', python3: 'python3',
                   javascript: 'javascript', typescript: 'typescript', c: 'c', csharp: 'csharp',
                   go: 'golang', kotlin: 'kotlin', swift: 'swift', rust: 'rust' };

// → { code, lang } or null
export async function readEditor(slug) {
  if (!slug) return null;
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const onProblem = new RegExp(`leetcode\\.com/problems/${slug}(?:[/?#]|$)`, 'i').test(tab?.url || '');
    if (!tab?.id || !onProblem) return null;
    const [res] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, world: 'MAIN', func: readMonaco });
    const r = res?.result;
    if (!r || typeof r.code !== 'string') return null;
    return { code: r.code, lang: LANG_IDS[String(r.lang || '').toLowerCase()] || 'cpp' };
  } catch (e) {
    console.warn('LeetHint: could not read the editor →', e.message);
    return null;
  }
}

export async function readEditorCode(slug) {
  return (await readEditor(slug))?.code ?? null;
}

// Runs INSIDE the LeetCode page (serialised by executeScript) — self-contained
function readMonaco() {
  const api = window.monaco?.editor;
  if (api) {
    const fromEditors = (api.getEditors?.() || []).map(e => e.getModel?.()).filter(Boolean);
    const pool = (fromEditors.length ? fromEditors : api.getModels?.() || []).filter(m => !m.isDisposed?.());
    // The code editor, not the test-case box: a real language, the most text
    const best = pool.filter(m => (m.getLanguageId?.() || '') !== 'plaintext')
                     .sort((a, b) => b.getValueLength() - a.getValueLength())[0] || pool[0];
    if (best) return { code: best.getValue(), lang: best.getLanguageId?.() || '' };
  }
  const lines = document.querySelectorAll('.monaco-editor .view-lines .view-line');
  return lines.length ? { code: [...lines].map(l => l.textContent.replace(/ /g, ' ')).join('\n'), lang: '' } : null;
}
