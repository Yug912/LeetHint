// Re-runs the checks on the saved solutions (no AI calls)
import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
const here = new URL('./', import.meta.url).pathname, work = here + 'work/';
const src = readFileSync(here + 'run.mjs', 'utf8');
const build = new Function('writeFileSync', 'execFileSync', 'work', src.match(/function build[\s\S]*?\n}\n/)[0] + 'return build;')(writeFileSync, execFileSync, work);
for (const slug of process.argv.slice(2)) {
  const code = readFileSync(`${work}${slug}.solution.cpp`, 'utf8');
  let line = slug + ': ';
  try {
    const [ep, et, rp, rt] = execFileSync(build(slug, code, readFileSync(`${here}drivers/${slug}.inc`, 'utf8'), 'check'), { timeout: 20000 }).toString().trim().split(' ').map(Number);
    line += `examples ${ep}/${et} · random ${rp}/${rt}`;
    try { line += ` · max-size ${execFileSync(build(slug, code, readFileSync(`${here}drivers/${slug}.perf`, 'utf8'), 'perf'), { timeout: 10000 }).toString().trim().split(' ')[4]} ms`; }
    catch (e) { line += ' · max-size: >10 s (TLE) or crash'; }
  } catch (e) { line += 'FAILED ' + (String(e.stderr || '').split('\n').find(l => /error/.test(l)) || e.message); }
  console.log(line);
}
