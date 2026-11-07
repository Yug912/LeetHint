// tools/html-text.mjs — LeetCode statement HTML → plain text, for Node.
// The SAME rules as htmlToText() in content/content.js (the extension), so
// the pre-fill builds the same prompt — and the same cache key — a user's
// browser would. content.js gets textContent from DOMParser; here tags are
// stripped and entities decoded, which gives the same text for LeetCode's HTML.

const NAMED = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', le: '≤', ge: '≥', ne: '≠',
                times: '×', minus: '−', middot: '·', hellip: '…', rarr: '→', larr: '←', ndash: '–', mdash: '—',
                lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”', deg: '°', infin: '∞', sum: '∑', radic: '√' };

function decodeEntities(s) {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
    if (e[0] === '#') {
      const code = e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : m;
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
  // textContent: drop comments, script/style bodies and every tag
  const text = decodeEntities(marked
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, '')
    .replace(/<\/?[a-z][^>]*>/gi, ''));
  return text
    .replace(/ /g, ' ')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
