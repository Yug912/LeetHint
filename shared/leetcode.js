// shared/leetcode.js — LeetCode's public GraphQL API and its HTML → text,
// for code that runs OUTSIDE the browser tab: the pre-fill script
// (tools/prefill.mjs) and the Worker's weekly cron. Problem data is built
// EXACTLY the way content/content.js builds it, so the prompts — and the
// server's cache keys — match what the extension sends.
// No Node- or browser-only APIs: plain fetch and string work.

import { LANGUAGES } from './prompts.js';

const GRAPHQL = 'https://leetcode.com/graphql';


// ─────────────────────────────────────────────
// 1. HTML → TEXT — content/content.js's htmlToText() without a browser:
//    same markers, then what DOMParser's textContent does (drop tags, decode
//    entities)
// ─────────────────────────────────────────────
const NAMED = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', le: '≤', ge: '≥', ne: '≠',
  times: '×', divide: '÷', minus: '−', plusmn: '±', rarr: '→', larr: '←', harr: '↔', uarr: '↑', darr: '↓',
  hellip: '…', middot: '·', ndash: '–', mdash: '—', lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”',
  infin: '∞', sum: '∑', radic: '√', deg: '°', sup2: '²', sup3: '³', frac12: '½', copy: '©'
};

export function decodeEntities(s) {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z][a-z0-9]*);/gi, (m, e) => {
    if (e[0] === '#') {
      const n = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(n) ? String.fromCodePoint(n) : m;
    }
    return NAMED[e.toLowerCase()] ?? m;
  });
}

export function htmlToText(html) {
  const marked = String(html || '')
    .replace(/<sup>\s*([\s\S]*?)\s*<\/sup>/gi, '^$1')
    .replace(/<sub>\s*([\s\S]*?)\s*<\/sub>/gi, '_$1')
    .replace(/<img[^>]*>/gi, ' [image] ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<li[^>]*>/gi, '\n- ')
    .replace(/<\/(p|div|pre|ul|ol|h\d)>/gi, '\n');
  return decodeEntities(marked.replace(/<!--[\s\S]*?-->/g, '').replace(/<[^>]*>/g, ''))
    .replace(/ /g, ' ')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}


// ─────────────────────────────────────────────
// 2. LEETCODE GRAPHQL
// ─────────────────────────────────────────────
async function graphql(query, variables, { fetchImpl = (...a) => fetch(...a) } = {}) {
  const res = await fetchImpl(GRAPHQL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Referer: 'https://leetcode.com/problemset/' },
    body: JSON.stringify({ query, variables }),
    signal: AbortSignal.timeout(20000)
  });
  if (!res.ok) throw new Error(`LeetCode GraphQL HTTP ${res.status}`);
  const out = await res.json();
  if (out.errors) throw new Error(`LeetCode GraphQL: ${out.errors[0]?.message}`);
  return out.data;
}

// Every problem: [{ slug, id, title, difficulty, paid, acRate }], in LeetCode's order
// filters: e.g. { orderBy: 'FRONTEND_ID', sortOrder: 'DESCENDING' }; max: stop after this many
export async function listProblems({ filters = {}, max = Infinity, ...opts } = {}) {
  const query = `query list($skip: Int, $limit: Int, $filters: QuestionListFilterInput) {
    questionList(categorySlug: "", limit: $limit, skip: $skip, filters: $filters) {
      totalNum data { questionFrontendId titleSlug title difficulty isPaidOnly acRate } } }`;
  const all = [];
  for (let skip = 0; ; skip += 100) {
    const { questionList } = await graphql(query, { skip, limit: Math.min(100, max - skip), filters }, opts);
    for (const q of questionList.data) {
      all.push({ slug: q.titleSlug, id: Number(q.questionFrontendId) || 0, title: q.title,
                 difficulty: q.difficulty, paid: q.isPaidOnly, acRate: q.acRate });
    }
    if (skip + 100 >= Math.min(questionList.totalNum, max) || !questionList.data.length) return all;
  }
}

// The problem object the extension sends (content/content.js getEnrichedProblemData)
export async function fetchProblem(slug, opts) {
  const query = `query questionData($titleSlug: String!) {
    question(titleSlug: $titleSlug) {
      questionFrontendId title difficulty content hints isPaidOnly
      topicTags { name }
      codeSnippets { langSlug code }
    }
  }`;
  const { question: q } = await graphql(query, { titleSlug: slug }, opts);
  if (!q || !q.content) return null;   // unknown or premium-locked
  const codeSnippets = {};
  for (const s of q.codeSnippets || []) if (LANGUAGES[s.langSlug]) codeSnippets[s.langSlug] = s.code;
  return {
    slug,
    title: q.title,
    difficulty: q.difficulty,
    problemNumber: q.questionFrontendId,
    description: htmlToText(q.content),
    topicTags: (q.topicTags || []).map(t => t.name),
    officialHints: (q.hints || []).map(htmlToText),
    cppSnippet: codeSnippets.cpp || '',
    codeSnippets
  };
}



// ─────────────────────────────────────────────
// 3. CONTESTS — LeetCode forbids AI help during a live contest, so nothing
//    is generated for a problem whose contest is still running
// ─────────────────────────────────────────────

// Slugs of every problem in a contest that is running at `now` (ms)
export async function runningContestSlugs(now = Date.now(), opts) {
  const { topTwoContests = [] } = await graphql('{ topTwoContests { titleSlug startTime duration } }', {}, opts);
  const running = topTwoContests.filter(c => c.startTime * 1000 <= now && now < (c.startTime + c.duration) * 1000);
  const slugs = new Set();
  for (const c of running) {
    const { contestQuestionList = [] } = await graphql(
      'query q($s: String!) { contestQuestionList(contestSlug: $s) { titleSlug } }', { s: c.titleSlug }, opts);
    for (const q of contestQuestionList || []) slugs.add(q.titleSlug);
  }
  return slugs;
}
