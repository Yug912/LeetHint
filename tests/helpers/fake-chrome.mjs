// A minimal chrome.storage.local for tests of extension modules
export function installFakeChrome(initial = {}) {
  const data = { ...initial };
  globalThis.chrome = {
    storage: { local: {
      get: async keys => {
        const list = keys == null ? Object.keys(data) : Array.isArray(keys) ? keys : typeof keys === 'string' ? [keys] : Object.keys(keys);
        return Object.fromEntries(list.filter(k => k in data).map(k => [k, structuredClone(data[k])]));
      },
      set: async obj => { Object.assign(data, structuredClone(obj)); },
      remove: async keys => { for (const k of [].concat(keys)) delete data[k]; }
    } },
    runtime: { getURL: p => `chrome-extension://test/${p}` }
  };
  return data;
}
