// api/install.js — the anonymous install ID
// One random UUID per install, kept in chrome.storage.local as installId and
// sent as X-LeetHint-Install so the server can apply fair per-install limits
// and free-trial counts. It identifies nothing about the person.

const KEY = 'installId';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
let known = '';

// The side panel can open before the service worker's onInstalled ran, so
// whoever asks first creates it. '' when storage isn't available.
export async function getInstallId(storage = globalThis.chrome?.storage?.local) {
  if (known) return known;
  if (!storage) return '';
  try {
    const { [KEY]: saved } = await storage.get(KEY);
    if (UUID.test(saved || '')) return (known = saved);
    const id = crypto.randomUUID();
    await storage.set({ [KEY]: id });
    return (known = id);
  } catch {
    return '';
  }
}

// Headers for every request to the LeetHint server
export async function installHeaders() {
  const id = await getInstallId();
  return id ? { 'X-LeetHint-Install': id } : {};
}

export function _forgetInstallId() { known = ''; }   // tests only
