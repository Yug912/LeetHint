// sidepanel/companies.js — the Companies tab: pick a company, see the problems
// it asks most (most reported first), filter by difficulty, hide solved or
// Premium ones, and open any of them. Data: api/company-lists.js.
// Every storage call is wrapped: a failure only forgets the last choice.

import { loadCompanyLists, companyOptions, companyProblems, filterProblems, solvedSlugs, progress, pickNext } from '../api/company-lists.js';

const PAGE = 50;          // rows shown at first and per "Show more"
const TOP = 50;           // "top 50" progress and the practise button
const PREFS_KEY = 'companyListPrefs';

const $ = id => document.getElementById(id);
let el = null;
let doc = null;
let ctx = null;
let prefs = { company: 'Amazon', difficulty: '', hideSolved: false, hidePremium: false };
let shown = PAGE;
let solved = new Set();

export async function initCompanies(context) {
  ctx = context;
  el = {
    company: $('co-company'), diffs: [...document.querySelectorAll('#co-difficulty button')],
    hideSolved: $('co-hide-solved'), hidePremium: $('co-hide-premium'),
    progressText: $('co-progress-text'), barFill: $('co-bar-fill'),
    next: $('co-next'), list: $('co-list'), more: $('co-more'), source: $('co-source'), empty: $('co-empty')
  };
  if (!el.company || !el.list) return;

  try {
    const saved = (await chrome.storage.local.get(PREFS_KEY))[PREFS_KEY];
    if (saved && typeof saved === 'object') prefs = { ...prefs, ...saved };
  } catch { /* keep defaults */ }

  el.company.addEventListener('change', () => { prefs.company = el.company.value; shown = PAGE; savePrefs(); render(); });
  el.diffs.forEach(b => b.addEventListener('click', () => { prefs.difficulty = b.dataset.diff; shown = PAGE; savePrefs(); render(); }));
  el.hideSolved.addEventListener('change', () => { prefs.hideSolved = el.hideSolved.checked; shown = PAGE; savePrefs(); render(); });
  el.hidePremium.addEventListener('change', () => { prefs.hidePremium = el.hidePremium.checked; shown = PAGE; savePrefs(); render(); });
  el.more.addEventListener('click', () => { shown += PAGE; render(); });
  el.next.addEventListener('click', () => {
    const p = pickNext(companyProblems(doc, prefs.company), solved, { top: TOP });
    if (p) open(p.slug);
    else ctx.showToast?.(`You've solved every free problem in ${el.company.selectedOptions[0]?.textContent || 'this'} top ${TOP}. 🎉`);
  });
}

// Called each time the tab opens: loads the file once, re-reads what's solved
export async function renderCompanies() {
  if (!el?.list) return;
  if (!doc) {
    doc = await loadCompanyLists({ url: chrome.runtime.getURL('data/company-problems.json') });
    if (!doc) { el.empty.hidden = false; el.empty.textContent = 'Company lists could not be loaded. Reload the extension and try again.'; return; }
    fillCompanies();
  }
  try { solved = solvedSlugs((await chrome.storage.local.get('stats')).stats); } catch { solved = new Set(); }
  render();
}

function fillCompanies() {
  const options = companyOptions(doc);
  el.company.innerHTML = '';
  for (const o of options) {
    const opt = document.createElement('option');
    opt.value = o.name;
    opt.textContent = `${o.label} (${o.count})`;
    el.company.appendChild(opt);
  }
  if (!options.some(o => o.name === prefs.company)) prefs.company = options[0]?.name || '';
  el.company.value = prefs.company;
  el.source.textContent = `Ranked by how often each problem was reported in that company's interviews. Community data (${doc.source}); older lists can miss recent questions.`;
}

function render() {
  const all = companyProblems(doc, prefs.company);
  const rows = filterProblems(all, { ...prefs, solved });

  el.company.value = prefs.company;
  el.diffs.forEach(b => b.classList.toggle('active', b.dataset.diff === prefs.difficulty));
  el.hideSolved.checked = !!prefs.hideSolved;
  el.hidePremium.checked = !!prefs.hidePremium;

  const top = progress(all, solved, TOP);
  const whole = progress(all, solved);
  el.progressText.textContent = `Top ${top.total}: ${top.solved} solved · all ${whole.total}: ${whole.solved} solved`;
  el.barFill.style.width = `${top.total ? Math.round(top.solved / top.total * 100) : 0}%`;

  const maxTimes = all[0]?.times || 1;
  el.list.innerHTML = '';
  rows.slice(0, shown).forEach(p => el.list.appendChild(row(p, maxTimes)));
  el.empty.hidden = rows.length > 0;
  el.empty.textContent = 'No problems match these filters.';
  el.more.hidden = rows.length <= shown;
  el.more.textContent = `Show more (${rows.length - shown} left)`;
}

// Built with textContent (not innerHTML) — titles come from a data file
function row(p, maxTimes) {
  const li = document.createElement('li');
  li.className = 'revision-item co-item' + (solved.has(p.slug) ? ' co-solved' : '');

  const rank = document.createElement('span');
  rank.className = 'co-rank';
  rank.textContent = p.rank;

  const info = document.createElement('div');
  info.className = 'revision-info';
  const link = document.createElement('a');
  link.className = 'revision-title';
  link.href = `https://leetcode.com/problems/${p.slug}/`;
  link.textContent = `${solved.has(p.slug) ? '✓ ' : ''}${p.title}${p.premium ? ' 🔒' : ''}`;
  link.title = p.premium ? `${p.title} (LeetCode Premium)` : p.title;
  link.addEventListener('click', e => { e.preventDefault(); open(p.slug); });

  const meta = document.createElement('span');
  meta.className = 'revision-meta co-meta';
  if (p.difficulty) {
    const diff = document.createElement('span');
    diff.className = `${p.difficulty.toLowerCase()}-text`;
    diff.textContent = p.difficulty;
    meta.append(diff, ' · ');
  }
  meta.append(`asked ${p.times}×`);
  info.append(link, meta);

  const bar = document.createElement('div');
  bar.className = 'co-freq';
  bar.title = `Reported ${p.times} times`;
  const fill = document.createElement('div');
  fill.style.width = `${Math.max(6, Math.round(p.times / maxTimes * 100))}%`;
  bar.appendChild(fill);

  li.append(rank, info, bar);
  return li;
}

// Open in the current tab; the tab watcher then loads it in the Hints tab
function open(slug) {
  try { chrome.tabs.update({ url: `https://leetcode.com/problems/${slug}/` }); } catch {}
  ctx.switchTab?.('hints');
}

function savePrefs() {
  try { chrome.storage.local.set({ [PREFS_KEY]: prefs }).catch?.(() => {}); } catch {}
}
