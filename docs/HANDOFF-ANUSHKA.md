# LeetHint — Anushka's remaining tasks (after Yug's deploy)

As of 2026-11-07. Live copy with tick boxes (may be newer): https://claude.ai/artifact/XGPvp6MohCSgMAqrQ79jtk
Yug's side: [HANDOFF-YUG.md](HANDOFF-YUG.md).

## Order of work

All code is done and on `main`; what is left for you is setup on your Mac, testing, and the store release. Yug's part (deploy, Action secrets, contest check, S33) needs nothing from you except the store accounts.

1. **Now, before Yug deploys:** the chores in the next section.
2. **When Yug says "deployed":** run the test checklist. Report anything wrong with the step number.
3. **When testing passes:** build the store package and submit to Chrome and Edge.
4. **When the stores approve:** Yug locks the server to the store IDs (he reads them from the public listing URLs), then retest once.

## Now (no deploy needed)

- [x] **Switch on the nightly pre-fill.** Done 2026-11-07: `com.leethint.prefill` is loaded and runs at 01:30 while the Mac is awake. Each morning there should be a commit "Pre-fill: N hint file(s)" on `main`; if not, read `tools/prefill.log`. Stop it with `launchctl unload ~/Library/LaunchAgents/com.leethint.prefill.plist`.
- [ ] **Rotate the Groq dev key.** It was pasted in a chat, so treat it as leaked.
  1. Open https://console.groq.com/keys, create a new key, copy it.
  2. Open `backend/.dev.vars` in the editor and replace the value after `GROQ_API_KEY=`. Save. Never commit this file (it is gitignored) or paste the key anywhere.
  3. Delete the old key on the same Groq page. Yug replaces the live server's key himself if needed (Task 0 of his doc).
- [ ] **Older-server check (before Yug deploys).** The live server is still the 2026-11-05 version, so this is the only time it can be tested: `git pull`, reload the unpacked extension, open Two Sum and a new problem, open Settings and Stats, start and end a short interview. Everything works as before; features whose endpoint isn't live yet (`/config` switches, Report wrong hint, interview summaries) are simply hidden or skipped, with no error anywhere. Tell Yug if anything shows an error.
- [ ] *(Optional)* **Send Yug the `STATS_TOKEN`.** Not needed: Yug sets his own (Task 0 of his doc). If you send yours, do it privately; it is the value after `STATS_TOKEN=` in `backend/.dev.vars`.

## After the deploy: test checklist

Setup once: `git pull`, then Chrome → `chrome://extensions` → Developer mode on → Load unpacked → the LeetHint folder (or Reload if it is already loaded). Open DevTools on the side panel (right-click in the panel → Inspect → Network tab) to see requests. Tick each item when it behaves as described; if not, note what you saw and the step number.

| Step | Do | Expected |
| --- | --- | --- |
| S6/S7 Static hints | open https://leetcode.com/problems/two-sum/ | Hints appear at once. Network shows `leethint.pages.dev/cache/two-sum.json` and no `/v1/generate`. |
| S9 Server cache | open a problem with no static file (any medium you haven't opened) | Hints stream in. `/v1/generate` response header `X-LeetHint-Cache` is `MISS`; on a second Chrome profile the same problem says `HIT`. |
| S10 Report | under the hints, Report wrong hint → pick a reason | "Thanks, we'll check it" appears and the link goes away. |
| S11 Company tags | open Two Sum | Company tags show under the title. |
| S12 Follow-ups | solve Two Sum (static) and the problem from S9 | Both show 3 interview follow-up questions; each answer opens only when clicked. |
| S17/S18 Own key (Groq) | Settings → own key → Groq → a free key from https://console.groq.com/keys → Test key | "Key works"; a wrong key shows Groq's error. A new problem then calls `api.groq.com`, no `/v1/generate`, and no `workers.dev` request contains the key. |
| S17 Own key (Gemini, OpenRouter) | same, with free keys from https://aistudio.google.com/apikey and https://openrouter.ai/keys | "Key works" for both (first real check of these two models). Remove your key afterwards. |
| S16/S19 Trials | no own key: use Fix 4 times today | The 4th shows "Free trials are used up for today. Add a free key in 2 minutes, or come back …" with a button to the own-key settings. |
| S20/S21 Trial interview | no own key: run a mock interview to the scorecard | 15 minutes, ends with a scorecard; after turn 10 `/v1/generate` bodies stay under ~6 KB. With an own key it is 30 minutes. |
| S22 Pattern guess | new problem, before Hint 1 | Skippable pattern chips; after 3 guesses on one pattern, Stats shows its accuracy bar. |
| S23 Confidence | top of the Hints tab | "Will you solve this without hints?" Yes / Maybe / No; Stats card after 10 answers. |
| S24 Tilt | 3 wrong submissions within 10 minutes | One gentle card, once per problem. The LeetCode page itself is unchanged. |
| S25 TLE warning | n up to 10^5, two nested loops, Run, then "Check speed" | Dismissible heuristic warning like "Your nested loops look like O(n²)…". |
| S26 Déjà vu | solve one problem, open a similar one (e.g. LRU Cache → LFU Cache) | "This looks like …, which you solved …" with a link (not for problems solved in the last 2 days). |
| S27 Streak + CSV | Stats → Download CSV, open in Google Sheets or Excel | Streaks show; the CSV opens with 7 clean columns. |
| S28 LeetCode change | LeetCode tab DevTools → Network → block the `graphql` request URL → reload Two Sum | Banner "LeetCode changed its page; an update is coming", static hints still show. Unblock afterwards. |
| S3 No health check | open the side panel, click nothing | No `/health` request. |
| S7 Languages | pick Python, open the solution, switch to Java | Python shows at once; switching translates only Java. |
| Solve flow | solve any problem | Score, Stats, revision queue and toolbar badge update. |
| Voice | mock interview, answer by microphone | Speech becomes text and the interviewer replies. |
| S4 Remote switch (optional, with Yug) | Yug sets `CONFIG_FIX = "false"` in the dashboard | Within an hour Fix is hidden, no error. Yug sets it back. |

Not testable by hand: S13 busy waiting line (needs every provider at its limit at once); covered by unit tests.

## Store release (S32)

Every text the store forms ask for is ready in `store/listing.md`: name, pitch, description, single purpose, permission justifications, data-use answers and the privacy URL https://leethint.pages.dev/privacy.

1. **Before building**, from the LeetHint folder:
   ```sh
   git pull
   node --test tests/*.test.mjs                        # all pass
   LEETHINT_LIVE=1 node --test tests/graphql.test.mjs  # LeetCode's query still works
   sh store/build.sh                                   # → dist/leethint-1.2.0.zip
   ```
2. **Fresh-profile check.** Chrome → profile icon → Add → continue without an account. In that profile: `chrome://extensions` → Developer mode → unzip `dist/leethint-1.2.0.zip` and Load unpacked from that folder. With no key: static hints on Two Sum, live hints on a new problem, a solve with follow-ups, Stats, a short trial interview.
3. **Screenshots** (3–5, exactly 1280×800, PNG or JPEG). Shot list in `store/listing.md`. The three in `screenshots/` are old; retake them.
4. **Short GIF** (optional, for the README): open a problem → guess the pattern → unlock Hint 2 → solve → follow-ups appear.
5. **Chrome Web Store:** https://chrome.google.com/webstore/devconsole → register (one-time $5 fee, the project's only cost; you pay it yourself) → New item → upload the zip → paste the fields from `store/listing.md` → screenshots → Privacy tab → Submit for review (usually a few days).
6. **Edge Add-ons** (free): https://partner.microsoft.com/dashboard/microsoftedge → register → Create new extension → same zip and texts → Submit.

For later updates: raise `"version"` in `manifest.json` (e.g. 1.2.1), rebuild, upload the new zip to both stores.

## After the stores approve

- [ ] **Keep the nightly pre-fill working after the lock.** When Yug sets `ALLOWED_ORIGINS` (S33), add this line to your `backend/.dev.vars`, or your local Worker refuses the pre-fill:
  `ALLOWED_ORIGINS=chrome-extension://<chrome-store-id>,chrome-extension://prefill,chrome-extension://test`
  Check the next morning's "Pre-fill" commit appears.
- [ ] **Retest once from the store install:** install LeetHint from the Chrome Web Store in a fresh profile, open Two Sum and a new problem; hints load. After the lock, the unpacked dev build can't use the live server; for development set `BACKEND_URL` in `api/config.js` to `http://localhost:8787` and run `npx wrangler dev` in `backend/` (add your unpacked ID to `ALLOWED_ORIGINS` in `backend/.dev.vars`).

### Ongoing (weekly, about 10 minutes)

| When | What | How |
| --- | --- | --- |
| Each morning | Nightly pre-fill ran | a "Pre-fill: N hint file(s)" commit on `main`; if not, read `tools/prefill.log` |
| Monday | Weekly sync ran | GitHub → Actions → sync-cache is green |
| Before each store update | LeetCode still readable | `LEETHINT_LIVE=1 node --test tests/graphql.test.mjs` |
| After any prompt or model change | Accuracy still at the mark | `node tools/accuracy/standard.mjs` (10/10) and `node tools/accuracy/hard/run.mjs` (4/5) against `npx wrangler dev` |

Rules that still apply to every change: free tiers only, never commit or paste a key, tests pass before each deploy, push to `main`.
