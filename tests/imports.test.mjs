// Every name an extension module imports is exported by its target (the side
// panel can't be loaded without Chrome, so this catches typos statically)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const FILES = ['sidepanel/sidepanel.js', 'sidepanel/extras.js', 'sidepanel/interview.js', 'sidepanel/editor.js',
               'api/ai.js', 'api/direct.js', 'api/remote.js', 'api/interview.js', 'background/service-worker.js',
               'shared/insights.js', 'shared/patterns.js', 'shared/complexity.js'];

function exportsOf(file) {
  const src = readFileSync(resolve(ROOT, file), 'utf8');
  const names = new Set();
  for (const m of src.matchAll(/export\s+(?:async\s+)?(?:function\*?|const|let|class)\s+(\w+)/g)) names.add(m[1]);
  for (const m of src.matchAll(/export\s*\{([^}]+)\}/g)) for (const n of m[1].split(',')) names.add(n.trim().split(/\s+as\s+/).pop());
  return names;
}

test('imports match exports', () => {
  for (const file of FILES) {
    const src = readFileSync(resolve(ROOT, file), 'utf8');
    for (const m of src.matchAll(/import\s*\{([^}]+)\}\s*from\s*'([^']+)'/g)) {
      const target = resolve(dirname(resolve(ROOT, file)), m[2]).slice(ROOT.length + 1);
      const have = exportsOf(target);
      for (const n of m[1].split(',').map(x => x.trim().split(/\s+as\s+/)[0]).filter(Boolean)) {
        assert.ok(have.has(n), `${file} imports ${n} from ${m[2]}, which doesn't export it`);
      }
    }
  }
});

test('every element id the panel scripts look up exists in sidepanel.html', () => {
  const html = readFileSync(resolve(ROOT, 'sidepanel/sidepanel.html'), 'utf8');
  const ids = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map(m => m[1]));
  for (const file of ['sidepanel/sidepanel.js', 'sidepanel/extras.js', 'sidepanel/interview.js']) {
    const src = readFileSync(resolve(ROOT, file), 'utf8');
    for (const m of src.matchAll(/\$\('([a-z0-9-]+)'\)/g)) assert.ok(ids.has(m[1]), `${file}: #${m[1]} missing from sidepanel.html`);
  }
});
