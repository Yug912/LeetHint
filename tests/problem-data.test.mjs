// Shared problem extraction + description normalisation + /health version — run with: node --test tests/*.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import '../shared/problem-data.js';
import { htmlToText } from '../shared/html-text.js';
import { buildPrompt } from '../shared/prompts.js';

const { normalizeDescription, problemFromQuestion, QUESTION_QUERY, SNIPPET_LANGS } = globalThis.LeetHintProblem;

test('normalisation: CRLF, odd spaces, zero-width chars and blank runs collapse; paragraphs stay', () => {
  const a = 'Given  nums\r\nand target.  \r\n\r\n\r\n\r\nExample 1:​\n\tInput: x \n';
  assert.equal(normalizeDescription(a), 'Given nums\nand target.\n\nExample 1:\nInput: x');
  assert.equal(normalizeDescription('  same  text '), normalizeDescription('same text'));
  assert.equal(normalizeDescription(normalizeDescription(a)), normalizeDescription(a));   // idempotent
  assert.equal(normalizeDescription(undefined), '');
});

test('tiny scraping differences give the same prompt (= the same cache key)', () => {
  const p = d => ({ slug: 'two-sum', title: 'Two Sum', difficulty: 'Easy', problemNumber: '1', description: d, topicTags: [], officialHints: [], cppSnippet: '' });
  assert.equal(buildPrompt('hints', p('Find two\r\nnumbers.  \n\n\n\nOk')), buildPrompt('hints', p('Find two\nnumbers.\n\nOk')));
});

const q = {
  questionFrontendId: '1', title: 'Two Sum', difficulty: 'Easy',
  content: '<p>Given <code>nums</code>&nbsp;and  <code>target</code>.</p><ul><li>2 &lt;= n &lt;= 10<sup>4</sup></li></ul>',
  hints: ['Use a <b>map</b>.'], topicTags: [{ name: 'Array' }, { name: 'Hash Table' }],
  codeSnippets: [{ langSlug: 'cpp', code: 'class Solution {};' }, { langSlug: 'python3', code: 'class Solution:' }, { langSlug: 'mysql', code: '#' }]
};

test('one mapping for the extension and the pre-fill: GraphQL question → problem', () => {
  const p = problemFromQuestion(q, { slug: 'two-sum', htmlToText });
  assert.deepEqual(p, {
    slug: 'two-sum', title: 'Two Sum', difficulty: 'Easy', problemNumber: '1',
    description: 'Given nums and target.\n\n- 2 <= n <= 10^4',
    topicTags: ['Array', 'Hash Table'], officialHints: ['Use a map.'],
    cppSnippet: 'class Solution {};', codeSnippets: { cpp: 'class Solution {};', python3: 'class Solution:' }
  });
  assert.ok(SNIPPET_LANGS.includes('cpp') && !SNIPPET_LANGS.includes('mysql'));
});

test('premium (content null) keeps the DOM description, normalised', () => {
  const p = problemFromQuestion({ ...q, content: null }, { slug: 'x', htmlToText, dom: { description: 'From  the page\r\n', title: 'Dom' } });
  assert.equal(p.description, 'From the page');
  assert.equal(p.title, 'Two Sum');
});

test('content.js, the service worker and the store build all load the shared file first', () => {
  const manifest = JSON.parse(readFileSync(new URL('../manifest.json', import.meta.url)));
  assert.deepEqual(manifest.content_scripts[0].js, ['shared/problem-data.js', 'content/content.js']);
  assert.match(readFileSync(new URL('../background/service-worker.js', import.meta.url), 'utf8'), /files: \['shared\/problem-data\.js', 'content\/content\.js'\]/);
  assert.match(readFileSync(new URL('../store/build.sh', import.meta.url), 'utf8'), /shared\/problem-data\.js/);
  const content = readFileSync(new URL('../content/content.js', import.meta.url), 'utf8');
  assert.match(content, /LeetHintProblem\.QUESTION_QUERY/);
  assert.match(content, /LeetHintProblem\.problemFromQuestion/);
  assert.match(QUESTION_QUERY, /codeSnippets \{ langSlug code \}/);
});

test('GET /health reports the Worker version and prompt version', async () => {
  const { default: worker } = await import('../backend/src/index.js?health');
  const { WORKER_VERSION } = await import('../backend/src/version.js');
  // The entry module may export only handlers, functions and Durable Object
  // classes — a string export stops the Workers runtime from starting
  const entry = await import('../backend/src/index.js?exports');
  for (const [name, v] of Object.entries(entry)) assert.ok(typeof v === 'function' || name === 'default', `index.js exports ${name}: ${typeof v}`);
  const { PROMPT_VERSION } = await import('../shared/prompts.js');
  const res = await worker.fetch(new Request('https://api.test/health', { headers: { Origin: 'chrome-extension://test' } }), {}, { waitUntil() {} });
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.match(WORKER_VERSION, /^\d{4}-\d{2}-\d{2}/);
  assert.equal(body.version, WORKER_VERSION);
  assert.equal(body.promptVersion, PROMPT_VERSION);
});
