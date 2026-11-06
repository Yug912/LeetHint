// api/install.js
// Anonymous install ID (contract item 3): one random UUID per installation,
// kept in chrome.storage.local as installId and sent to the LeetHint server as
// X-LeetHint-Install, so per-install limits work without accounts. It says
// nothing about the user — it's random and never leaves our own server.
//
// Shared by the service worker (creates it on install) and the side panel
// (creates it too if the panel opens before the service worker has run).

export const INSTALL_HEADER = 'X-LeetHint-Install';

let pending = null;

export function getInstallId() {
  if (!pending) {
    pending = (async () => {
      try {
        const { installId } = await chrome.storage.local.get('installId');
        if (installId) return installId;
        const id = crypto.randomUUID();
        await chrome.storage.local.set({ installId: id });
        return id;
      } catch {
        return '';   // storage unavailable → requests simply go without the header
      }
    })();
    // A failed lookup is retried next time instead of being remembered
    pending.then(id => { if (!id) pending = null; });
  }
  return pending;
}

// Headers for a request to OUR server (never to an AI provider)
export async function serverHeaders(extra = {}) {
  const id = await getInstallId();
  return id ? { ...extra, [INSTALL_HEADER]: id } : { ...extra };
}
