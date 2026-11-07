#!/usr/bin/env node
// tools/interview-tokens.mjs — tokens one scripted 15-minute mock interview
// costs, the old way vs the cheaper way (S20/S21). No AI calls: it builds the
// exact prompts the Worker would send (shared/prompts.js) from the exact
// request bodies the extension would send (api/interview.js), and counts them
// with the Worker's own estimator (backend/src/providers.js).
//
//   node tools/interview-tokens.mjs [--slug trapping-rain-water]
//
// Before (today's): full transcript + editor code in every request, 30-minute
//   pacing, a code event every minute while coding, no summaries. Shown for
//   the same 15-minute script and for a 30-minute interview at the same pace.
// After (trial):    15 minutes, a 5-line summary every 6 interviewer turns,
//   then only summary + the last 4 turns, code only once it really changed,
//   no code events. The scorecard gets everything in both.
// Output tokens can't be known without calling a model, so each reply is
// counted at a typical size (OUT below) — the same in both, so the comparison
// is about what the redesign changed: the input.

import { readFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { installFakeChrome } from '../tests/helpers/fake-chrome.mjs';

installFakeChrome();
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const { buildPrompt } = await import('../shared/prompts.js');
const { estimateTokens } = await import('../backend/src/providers.js');
const { interviewPayload, summaryDue, referenceFromHints, SUMMARY_EVERY } = await import('../api/interview.js');
const { mapStaticFile } = await import('../api/ai.js');
const { problemData } = await import('./prefill.mjs');

const OUT = { interview_turn: 250, interview_summary: 200, interview_score: 1000 };   // typical reply tokens

const slug = process.argv.includes('--slug') ? process.argv[process.argv.indexOf('--slug') + 1] : 'trapping-rain-water';
const problem = await problemData(slug);
const file = JSON.parse(readFileSync(join(ROOT, 'cache-site/cache', `${slug}.json`), 'utf8'));
const reference = referenceFromHints(mapStaticFile(file));

// The script: [stage, candidate says, code in the editor after this turn]
const starter = problem.cppSnippet;
const grow = n => starter.replace(/\{\s*\n\s*\}\s*\n\};\s*$/, `{\n${Array.from({ length: n },
  (_, i) => `        int v${i} = height[${i}] > height.size() ? left${i} + right${i} : max(left${i}, right${i}); // step ${i}`).join('\n')}\n        return 0;\n    }\n};`);
const SCRIPT = [
  ['clarify', 'Can the heights be zero, and is the array ever empty? I assume n can be up to 2*10^4.', starter],
  ['clarify', 'So water at each index depends on the tallest bar to the left and to the right of it.', starter],
  ['approach', 'Brute force: for every index scan left and right for the max, that is O(n^2).', starter],
  ['approach', 'I could precompute prefix max and suffix max arrays, then it is O(n) time and O(n) space.', starter],
  ['approach', 'To get O(1) space I can move two pointers inward and keep leftMax and rightMax.', starter],
  ['approach', 'The side with the smaller max decides the water level, so I move that pointer.', starter],
  ['coding', 'Let me write it now, starting with the two pointers and the two running maxima.', grow(3)],
  ['coding', 'Now the loop: while left < right, compare the heights and add the trapped water.', grow(7)],
  ['coding', 'I think the code is complete, returning the total at the end.', grow(11)],
  ['testing', 'Testing [0,1,0,2,1,0,1,3,2,1,2,1]: I get 6, which matches the example.', grow(11)],
  ['testing', 'Edge cases: all increasing gives 0, a single bar gives 0, two bars give 0.', grow(12)],
  ['complexity', 'Time is O(n) because each pointer moves at most n times, and space is O(1).', grow(12)]
];
const CODE_EVENTS_WHILE_CODING = 4;   // old: one code event a minute while typing

function session(durationMin) {
  return { interviewId: '00000000-0000-4000-8000-000000000001', durationMin, stage: 'clarify',
           startedAt: Date.now(), hintsGiven: 0, starterCode: starter, history: [] };
}
const say = (s, role, text) => s.history.push({ role, text, at: Date.now() });
const interviewerLine = i => `Good. ${['What are the constraints you would ask about?', 'How would you describe the water above one bar?',
  'What is the cost of that?', 'Can you do better on time?', 'And on space?', 'Why is it safe to move that pointer?',
  'Go ahead and code it.', 'Talk me through the loop.', 'Is it complete?', 'Walk me through the example.',
  'Any edge cases?', 'What is the complexity?', 'Thanks — let us wrap up.'][i] || 'Go on.'} Keep explaining your reasoning as you go, please.`;

function run({ cheap, script = SCRIPT }) {
  const s = session(cheap ? 15 : 30);
  const calls = [];
  const send = (action, interview) => {
    const prompt = buildPrompt(action, problem, '', { interview });
    calls.push({ action, bytes: JSON.stringify(interview).length, tokens: estimateTokens(prompt) + OUT[action] });
  };
  const turn = (event, code) => send('interview_turn', cheap ? interviewPayload(s, event, code, reference)
                                                             : interviewPayload(s, event, code, reference, { full: true }));
  turn('start', starter);
  say(s, 'interviewer', interviewerLine(0));
  script.forEach(([stage, text, code], i) => {
    s.stage = stage;
    say(s, 'candidate', text);
    if (!cheap && stage === 'coding' && script[i - 1]?.[0] !== 'coding') for (let k = 0; k < CODE_EVENTS_WHILE_CODING; k++) turn('code', grow(2 + k * 2));
    turn('answer', code);
    say(s, 'interviewer', interviewerLine(i + 1));
    if (cheap && summaryDue(s)) {
      const asked = s.history.filter(h => h.role === 'interviewer').length;
      send('interview_summary', { interviewId: s.interviewId, durationMin: s.durationMin, stage: s.stage,
                                  summary: s.summary || '', history: s.history.slice(s.summaryUpTo || 0) });
      Object.assign(s, { summary: '1. Clarified inputs and constraints.\n2. Brute force O(n^2), then prefix/suffix max O(n).\n3. Two pointers with running maxima for O(1) space.\n4. Coded the loop, moved the smaller side.\n5. Tested the example and edge cases.',
                         summaryAt: asked, summaryUpTo: s.history.length });
    }
  });
  send('interview_score', interviewPayload(s, 'answer', script.at(-1)[2], reference, { full: true }));
  return calls;
}

const total = calls => calls.reduce((n, c) => n + c.tokens, 0);
// Today's interviews are 30 minutes: the same pace for twice as long
const SCRIPT_30 = SCRIPT.flatMap(line => [line, line]);
const before = run({ cheap: false }), before30 = run({ cheap: false, script: SCRIPT_30 }), after = run({ cheap: true });
const pct = n => `${Math.round(100 * total(after) / total(n))}%`;
const turnsAfter10 = after.filter(c => c.action === 'interview_turn').slice(10);
const fixed = estimateTokens(buildPrompt('interview_turn', problem, '', { interview: { ...session(15), history: [], event: 'answer' } }));
console.log(`Scripted interview on ${problem.title}: ${SCRIPT.length} candidate turns, summary every ${SUMMARY_EVERY} interviewer turns`);
console.log(`before, same 15-min script, old way:   ${before.length} requests, ~${total(before).toLocaleString()} tokens`);
console.log(`before, today's 30-min interview:      ${before30.length} requests, ~${total(before30).toLocaleString()} tokens`);
console.log(`after,  15-min trial, cheaper way:     ${after.length} requests, ~${total(after).toLocaleString()} tokens`);
console.log(`→ ${pct(before30)} of today's interview; ${pct(before)} of the same script the old way`);
console.log(`fixed cost of every turn (instructions + problem, no history): ~${fixed} tokens + ~${OUT.interview_turn} out`);
console.log(`largest request body after turn 10: ${Math.max(...turnsAfter10.map(c => c.bytes))} bytes (target < ~6 KB)`);
