// api/install.js
// Anonymous install ID (contract item 3): one random UUID per installation,
// kept in chrome.storage.local as installId and sent to the LeetHint server as
// X-LeetHint-Install, so per-install limits work without accounts. It says
// nothing about the user — it's random and never leaves our own server.
//
// Shared by the service worker (creates it on install) and the side panel
// (creates it too if the panel opens before the service worker has run).

export const INSTALL_HEADER = 'X-LeetHint-Install';

// Concurrent callers in THIS context share one read/create (no two ids from
// one page). The side panel and the service worker are separate contexts: on
// a fresh install both may create one at the same moment. The id is
// therefore re-read from storage after creating it and never kept in memory
// for later calls, so every context settles on the one that was stored.
let creating = null;

async function readId() {
  const { installId } = await chrome.storage.local.get('installId');
  return typeof installId === 'string' && installId ? installId : '';
}

export async function getInstallId() {
  try {
    const existing = await readId();
    if (existing) return existing;
    if (!creating) {
      creating = (async () => {
        await chrome.storage.local.set({ installId: crypto.randomUUID() });
        return readId();   // whichever write landed last is THE id
      })().finally(() => { creating = null; });
    }
    return await creating;
  } catch {
    return '';   // storage unavailable → requests simply go without the header
  }
}

// Headers for a request to OUR server (never to an AI provider)
export async function serverHeaders(extra = {}) {
  const id = await getInstallId();
  return id ? { ...extra, [INSTALL_HEADER]: id } : { ...extra };
}
