# Store listing — Chrome Web Store and Edge Add-ons

Paste these into the store forms. Build the package with `bash store/build.sh`.

## Name
LeetHint

## One-line pitch (summary, max 132 characters)
LeetHint trains how you think, not just what you code — progressive hints, a verified solution and voice mock interviews for LeetCode.

## Category
Developer Tools (Chrome) · Developer tools (Edge)

## Description
LeetHint opens beside any LeetCode problem and helps you solve it yourself.

- Progressive hints: four hints, each a little more specific, then a verified solution in your language. Your score drops only as far as you needed to go.
- Guess the pattern before Hint 1, and say how confident you are. Stats show which patterns you recognise and whether your confidence matches your results.
- TLE warning: checks your code's loops against the problem's input size before you submit.
- A gentle nudge when you're stuck: after a few failed submissions it suggests a break, the next hint, or an easier problem on the same pattern.
- Interview follow-up questions after every solve, with the answers hidden until you click.
- Spaced-repetition revision (1 → 3 → 7 → 21 → 60 days), streaks and a CSV export of your history.
- Voice mock interviews with a scorecard.
- Company tags for each problem.

No sign-up and no setup. Your progress stays in your browser. Optional: add your own free Gemini, Groq or OpenRouter key for unlimited Fix and full-length interviews. The key stays on your computer and goes only to that provider.

## Single purpose (Chrome form)
Helps users solve LeetCode problems on leetcode.com with progressive hints, a verified solution and practice tools shown in the side panel.

## Permission justifications (Chrome form)
| Permission | Justification |
|---|---|
| sidePanel | The whole UI lives in the side panel next to the LeetCode problem. |
| storage | Saves hints, progress, stats, revision schedule and settings locally. |
| tabs | Knows which LeetCode problem the active tab shows, and opens a suggested problem. |
| scripting | Reads the problem and the editor code on leetcode.com (read-only), and injects the content script into tabs opened before install. |
| webNavigation | Detects moves between problems inside LeetCode's single-page app. |
| alarms | Updates the "problems due for revision" badge after midnight. |
| Host: leetcode.com | Reads the problem statement and submission results. |
| Host: leethint-api.yugthakral07.workers.dev | LeetHint's server, which generates hints for problems not cached yet. |
| Host: leethint-cache.pages.dev | Pre-generated hint files and company tags (static files). |
| Host: api.groq.com, openrouter.ai, generativelanguage.googleapis.com | Only when the user adds their own API key: requests go straight to that provider. |

Remote code: none. All code is in the package.

## Data use (Chrome form)
- Collected: none of the listed categories. Problem text (public LeetCode content) and an anonymous random install ID are sent to LeetHint's server to generate hints and enforce fair-use limits. Mock interview conversations are sent to generate the interviewer's replies and are not stored on the server.
- Not sold, not used for anything unrelated to the extension, not used for credit decisions.
- Privacy policy URL: **TODO — from Person A (handoff A16)**

## Screenshots (1280×800 or 640×400, 3–5)
1. Hints tab: Hint 1 with the score bar (`screenshots/hints-tab.jpeg`, re-shoot at 1280×800)
2. Pattern guess + confidence check on a fresh problem
3. Solution card with language picker and the TLE warning
4. Stats tab: streak, pattern recognition, confidence
5. Mock interview with the scorecard

## Short GIF (optional, for the README and promo)
Open a problem → guess the pattern → unlock Hint 2 → solve → follow-up questions appear.

## After publishing
Send Person A the extension ID so the Worker's `ALLOWED_ORIGINS` can be pinned to it (handoff A16).
