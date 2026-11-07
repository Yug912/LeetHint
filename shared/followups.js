// shared/followups.js — read the ---FOLLOWUPS--- section of a hints reply
// Used by the pre-fill script (tools/prefill.mjs) and the extension, so both
// turn the same reply into the same [{ q, a }] list.
//
//   ---FOLLOWUPS---
//   Q: What if the array is sorted?
//   A: Use two pointers from both ends for O(1) extra space.
//   ... (3 pairs)

const MAX_FOLLOWUPS = 3;

// The section's text: from ---FOLLOWUPS--- up to the next ---TAG--- (or the end)
function followupsSection(text) {
  const clean = String(text || '').replace(/[—–]/g, '-');
  const start = clean.match(/---\s*FOLLOWUPS\s*---/i);
  if (!start) return '';
  const rest = clean.slice(start.index + start[0].length);
  const next = rest.match(/---\s*[A-Z][A-Z0-9_]*\s*---/i);
  return rest.slice(0, next ? next.index : rest.length);
}

// → [{ q, a }] — pairs missing either half are dropped; at most 3
export function parseFollowUps(text) {
  const out = [];
  let q = null;
  for (const raw of followupsSection(text).split('\n')) {
    const line = raw.trim().replace(/^[-*\d.)\s]+(?=[QA]\s*[:.])/i, '').replace(/\*\*/g, '');
    const m = line.match(/^([QA])\s*[:.]\s*(.+)$/i);
    if (m && m[1].toUpperCase() === 'Q') q = m[2].trim();
    else if (m && q) { out.push({ q, a: m[2].trim() }); q = null; }
    else if (line && out.length && !q) out[out.length - 1].a += ' ' + line;   // answer ran onto a second line
  }
  return out.slice(0, MAX_FOLLOWUPS);
}
