# tools/

Scripts that run on a developer's computer, never in the extension or the Worker.

## prefill.mjs — static hint files

Solves every free LeetCode problem once and writes `cache/<slug>.json` (plus
`index.json`) into a checkout of the **leethint-cache** repo, which Cloudflare
Pages serves at `https://leethint-cache.pages.dev`. The extension reads these
files before asking the Worker, so a pre-filled problem costs no AI call.

```sh
# once: a separate free Groq key just for development, so the pre-fill never
# uses the live server's quota
echo "GROQ_API_KEY=gsk_..." > backend/.dev.vars

cd backend && npx wrangler dev          # terminal 1: local Worker on :8787
node tools/prefill.mjs --limit 20       # terminal 2
```

| Flag | Meaning |
| --- | --- |
| `--only <slug>` | just this problem (repeatable), e.g. a reported one |
| `--force` | regenerate even if the file already has the current prompt version |
| `--limit <n>` | stop after n new files |
| `--out <dir>` | the leethint-cache checkout (default `../leethint-cache`) |
| `--worker <url>` | default `http://localhost:8787` |
| `--pace <s>` | seconds between problems (default 20–30) |
| `--no-compile` | skip the compile check |

What it does per problem:

1. Fetches the statement, hints, tags and code snippets from LeetCode GraphQL,
   with the same text rules as `content/content.js` (see `shared/html-text.js`).
2. Calls the extension's own `generateHints()` (api/ai.js) against the local
   Worker, then `translateSolution()` for Java, Python and JavaScript.
3. Compile-checks the C++ with `clang++ -std=c++17 -fsyntax-only` and
   LeetCode's headers and `ListNode`/`TreeNode`/`Node` (`cpp/`). On an error
   it asks for one fix with the compiler message; still failing → the slug
   goes to `tools/needs-review.txt` and is skipped.
4. Checks 4 hints, TC, SC and the exact LeetCode signature, then writes the file.

Order: problems in `data/companies.json` first, then the rest by number. It is
resumable (files with the current `promptVersion` are skipped) and stops
cleanly after 3 rate-limited problems in a row. Expect roughly 100–300
problems per night on free tiers (approximate — Groq's per-model daily caps
decide it), so a few weeks for all ~3,800 free problems.

Weekly refresh: run it again (new problems are added); regenerate a reported
problem with `node tools/prefill.mjs --only <slug> --force`. Then commit and
push the leethint-cache repo; Pages redeploys by itself.

## accuracy/

The accuracy scripts (10 standard + 5 very hard problems) go here — ask Yug to
copy them in. Run them after any change to `shared/prompts.js` or model routing.
