// shared/problem-data.js — LeetCode GraphQL question → the problem object
// LeetHint sends to the AI, in ONE place for every caller:
//   • content/content.js (the extension; loaded before it as a classic content
//     script — content scripts can't import modules)
//   • tools/prefill.mjs and backend/src/refresh.js (import it for its side effect)
//   • shared/prompts.js (normalizeDescription before the prompt is hashed)
// A plain script that sets globalThis.LeetHintProblem, so the same file works
// as a content script, in Node and in the Worker bundle. No DOM needed: the
// caller passes its own htmlToText (DOMParser in the browser,
// shared/html-text.js elsewhere — both follow the same rules).
(function (root) {
  // Same keys as LANGUAGES in shared/prompts.js
  const SNIPPET_LANGS = ['cpp', 'java', 'python3', 'c', 'javascript', 'typescript', 'csharp', 'golang', 'kotlin', 'swift', 'rust'];

  // The fields content.js asks LeetCode for — the pre-fill asks for the same
  const QUESTION_QUERY = `query questionData($titleSlug: String!) {
    question(titleSlug: $titleSlug) {
      questionFrontendId title difficulty content hints
      topicTags { name }
      codeSnippets { langSlug code }
    }
  }`;

  // Tiny scraping differences (CRLF, non-breaking or zero-width spaces, a
  // double space, trailing blanks) must not change the prompt — its hash is
  // the cache key. Line breaks and blank lines between paragraphs are kept.
  function normalizeDescription(text) {
    return String(text || '')
      .normalize('NFC')
      .replace(/\r\n?/g, '\n')
      .replace(/[​-‍⁠﻿]/g, '')
      .replace(/[   \t\f\v ]+/g, ' ')
      .replace(/ *\n */g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  // q: GraphQL `question` (QUESTION_QUERY); dom: what the page itself showed
  // ({ title, difficulty, slug, problemNumber, description }), used where the
  // API has nothing (premium: content null). → the problem object, or null
  // when there is no statement at all.
  function problemFromQuestion(q, { slug, htmlToText, dom = {} } = {}) {
    if (!q) return null;
    const codeSnippets = {};
    for (const s of q.codeSnippets || []) if (SNIPPET_LANGS.includes(s.langSlug)) codeSnippets[s.langSlug] = s.code;
    const apiDescription = q.content ? htmlToText(q.content) : '';
    return {
      ...dom,
      slug:          slug || dom.slug || '',
      title:         q.title || dom.title || '',
      difficulty:    q.difficulty || dom.difficulty || '',
      problemNumber: q.questionFrontendId || dom.problemNumber || '',
      description:   normalizeDescription(apiDescription || dom.description || ''),
      topicTags:     (q.topicTags || []).map(t => t.name),
      officialHints: (q.hints || []).map(htmlToText),
      cppSnippet:    codeSnippets.cpp || '',
      codeSnippets
    };
  }

  root.LeetHintProblem = { SNIPPET_LANGS, QUESTION_QUERY, normalizeDescription, problemFromQuestion };
})(globalThis);
