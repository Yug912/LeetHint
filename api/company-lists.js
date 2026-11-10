// api/company-lists.js — "What does Amazon ask?": every company's problems,
// most asked first, from the bundled data/company-problems.json (built by
// data/build_company_lists.py). Pure functions; the Companies tab
// (sidepanel/companies.js) draws them. No AI call, no server: free and instant.
//
// File: { source, builtAt, companies: { Amazon: [[slug, title, timesReported, 'E'|'M'|'H'|'', premium 0/1], ...] } }

export const DIFFICULTY = { E: 'Easy', M: 'Medium', H: 'Hard' };

// The companies people look for first; the rest follow alphabetically
const POPULAR = ['Amazon', 'Google', 'Facebook', 'Microsoft', 'Apple', 'Bloomberg', 'Adobe', 'Uber', 'LinkedIn', 'Goldman Sachs', 'Oracle', 'tiktok'];
// Shown names for the dataset's spellings (the data keeps the original keys)
const LABELS = { Facebook: 'Meta (Facebook)', tiktok: 'TikTok' };
export const companyLabel = name => LABELS[name] || name;

const isList = v => !!v && typeof v === 'object' && !Array.isArray(v) && v.companies && typeof v.companies === 'object';

// fetchFn: fetch;  url: chrome.runtime.getURL('data/company-problems.json')
// → the parsed file, or null (missing, unreadable) — the tab then says so
export async function loadCompanyLists({ fetchFn = fetch, url }) {
  try {
    const res = await fetchFn(url);
    if (!res.ok) return null;
    const doc = await res.json();
    return isList(doc) ? doc : null;
  } catch {
    return null;
  }
}

// → [{ name, label, count }] popular first, then A→Z
export function companyOptions(doc) {
  if (!isList(doc)) return [];
  const names = Object.keys(doc.companies).filter(n => Array.isArray(doc.companies[n]) && doc.companies[n].length);
  const rank = n => { const i = POPULAR.indexOf(n); return i < 0 ? POPULAR.length : i; };
  return names
    .sort((a, b) => rank(a) - rank(b) || companyLabel(a).localeCompare(companyLabel(b)))
    .map(name => ({ name, label: companyLabel(name), count: doc.companies[name].length }));
}

// One company's rows as objects, in the file's order (most asked first).
// rank is the position in the FULL list, so filters don't renumber it.
export function companyProblems(doc, company) {
  const rows = isList(doc) && Array.isArray(doc.companies[company]) ? doc.companies[company] : [];
  return rows
    .filter(r => Array.isArray(r) && r[0])
    .map(([slug, title, times, diff, premium], i) => ({
      rank: i + 1, slug, title: title || slug, times: Number(times) || 0,
      difficulty: DIFFICULTY[diff] || '', premium: !!premium
    }));
}

// difficulty: '' (all) | 'Easy' | 'Medium' | 'Hard'
// solved: Set of solved slugs; hideSolved / hidePremium: booleans
export function filterProblems(list, { difficulty = '', hideSolved = false, hidePremium = false, solved = new Set() } = {}) {
  return list.filter(p =>
    (!difficulty || p.difficulty === difficulty) &&
    (!hideSolved || !solved.has(p.slug)) &&
    (!hidePremium || !p.premium));
}

// Solved slugs from the panel's stats ({ problems: { slug: { solved } } }).
// Entries from before solve detection have no flag and count as solved.
export function solvedSlugs(stats) {
  const out = new Set();
  for (const [slug, p] of Object.entries(stats?.problems || {})) if (p && p.solved !== false) out.add(slug);
  return out;
}

// Progress on a company's list: { solved, total }, and within the top N
export function progress(list, solved, top = 0) {
  const part = top ? list.slice(0, top) : list;
  return { solved: part.filter(p => solved.has(p.slug)).length, total: part.length };
}

// A random unsolved, free problem from the top N, or null when all are done
export function pickNext(list, solved, { top = 50, random = Math.random } = {}) {
  const pool = list.slice(0, top).filter(p => !solved.has(p.slug) && !p.premium);
  return pool.length ? pool[Math.floor(random() * pool.length)] : null;
}
