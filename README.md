<div align="center">

# 💡 LeetHint

### *Solve Smarter, Not Harder*

**AI-powered progressive hints for LeetCode — right in your browser sidebar.**

[![Chrome Extension](https://img.shields.io/badge/Chrome-Extension-4285F4?style=for-the-badge&logo=googlechrome&logoColor=white)](https://github.com/Yug912/AlgoMentor)
[![Manifest V3](https://img.shields.io/badge/Manifest-V3-orange?style=for-the-badge&logo=googlechrome&logoColor=white)](https://developer.chrome.com/docs/extensions/mv3/)
[![Gemini AI](https://img.shields.io/badge/Powered%20by-Gemini%20AI-8E75B2?style=for-the-badge&logo=google&logoColor=white)](https://ai.google.dev/)
[![License: MIT](https://img.shields.io/badge/License-MIT-green?style=for-the-badge)](LICENSE)

<br/>

> 🧠 Get 4 progressive hints — from pattern nudges to pseudocode — without spoiling the solution.  
> Every hint is grounded on a verified C++ solution, so hints, code and complexity always agree.  
> 🎙️ Practise out loud with a voice mock interview, and 🧠 lock problems in with spaced-repetition revision.

<br/>

</div>

---

## ✨ Features

### 🎯 Progressive AI Hints
LeetHint generates **4 layered hints plus a full solution** — no API key or setup needed:

| Hint | Name | What it gives you |
|------|------|-------------------|
| 💡 Hint 1 | **Pattern Recognition** | A pointed question about the real constraints — no algorithm spoilers |
| 🔑 Hint 2 | **Concrete Technique** | Names the exact data structure with a walkthrough step on a real example |
| 📋 Hint 3 | **Algorithm Skeleton** | Language-neutral pseudocode for the happy path |
| ⚠️ Hint 4 | **Edge Cases & Gotchas** | 3–5 valid edge cases with exact expected outputs and the concrete bug each one catches |
| 💀 Solution | **Accepted Code, 11 languages** | Copy-paste-ready code using LeetCode's exact signature — C++, Java, Python, C, JavaScript, TypeScript, C#, Go, Kotlin, Swift, Rust |

### ✅ Accuracy First
- **Solve first, then teach** — the model solves the problem and traces its code on every example *before* writing hints, so every hint leads to the same correct approach
- **Exact problem data** — statement, constraints, topic tags, official hints and the C++ signature come straight from LeetCode's API (constraints like `10^5` are never mangled)
- **🔧 Fix button** — re-checks the solution against the examples and constraints and repairs it
- **Signature check** — the code is compared with LeetCode's own starter code; a renamed class or method is fixed automatically (design problems like `LRUCache` keep their own class)
- **Harder problems, more thinking** — Hard problems get extra reasoning time
- **Your language, instantly** — pick a language once; from then on its code arrives in the same reply as the hints (no extra wait). Switch to another language and only that one is translated, on demand
- **Translations, not re-solves** — other languages come from the verified C++ solution, so the algorithm and TC/SC stay identical

### ⚡ Fast & Live
- **Streaming** — the hints layout opens instantly and Hint 1 appears word by word as it's written
- **One request per problem**, sent to the fastest available AI provider
- **Cached** — revisiting a problem is instant, and every problem is cached on the server for everyone: once anyone has opened it, in any language, it loads instantly for all users without spending AI tokens
- **Follows you** — switch problems (Next, links, back/forward, tabs) and the panel updates automatically

### 📊 Smart Scoring System
Your **performance score** drops the more hints you use:

```
Hint 1 only  → 100 pts  (SOLO)
Hint 2 used  →  80 pts  (SHARP)
Hint 3 used  →  60 pts  (GOOD)
Hint 4 used  →  40 pts  (GUIDE)
Show Answer  →  20 pts  (READ)
```

Each solved problem logs to your **Stats tab** with timestamp, difficulty, and score.

### ✅ Automatic Solve Detection
Press **Submit** (or `Ctrl/Cmd + Enter`) and LeetHint notices when that submission comes back **Accepted** — no need to log the solve yourself. Detection is **read-only**: it only watches the page and never adds or changes anything on LeetCode. Old accepted submissions opened from the Submissions tab don't count.

### 🧠 Spaced-Repetition Revision
Problems you struggled with come back on a schedule until you can solve them cold:

- **Joins the queue** when you use **Hint 4 or the solution**, or solve at **GOOD or lower** — never twice. You can also add any problem with **Add to revision**
- **Review steps:** `1 → 3 → 7 → 21 → 60` days, counted in local calendar days (due from midnight)
- **Each review moves it:** SOLO → next step · SHARP / GOOD → same step again · GUIDE / READ → back to 1 day
- **Mastered** after a SOLO at the 60-day step, or whenever you press **✓ Done**
- **Fresh attempts** — a due problem reopens with hints locked and the score back at 100; a review never counts as a new solve in Stats
- **Daily limit** — set how many reviews you want per day; extra due problems roll over to the next days

The **Revision tab** shows **Due today** (with how many days overdue), **Upcoming** (with due dates) and **Mastered**. The number due today also appears as a 🔔 **badge on the extension icon**.

### 🎙️ Voice Mock Interview
A **30-minute mock interview** with an AI interviewer on the problem you have open:

- The interviewer **speaks** to you; answer **by voice** (tap or hold to talk) or by typing
- Moves through real interview stages: **Intro → Clarify → Approach → Coding → Testing → Complexity → Feedback**
- **Reads your editor** every minute and reacts to meaningful code changes; nudges you to think out loud after 3 quiet minutes
- Timer, stage tracker, hint counter and mute — the normal hint ladder is locked while it runs
- Survives a panel reload — the session is saved and resumed
- Ends with a **scorecard** (problem solving, communication, coding, testing) and a **Strong Hire / Hire / No Hire** signal; past interviews are listed on the Stats tab
- **Review as interview** — take a due revision as a mock interview; the signal sets the next review, capped by the hints you needed (a Strong Hire after 3 hints still resets)

> The first time, LeetHint opens a small page to ask for microphone access, since Chrome can't show the permission prompt inside the side panel.

### 🏢 Company Tags
Know which **top tech companies** have asked each problem — pulled from a curated database of **hundreds of problems**, tagged with companies like Google, Meta, Amazon, Apple, and more.

### 📐 TC / SC Checker
Enter your own complexity and check it against the solution:
- **Time & Space Complexity** of the actual solution code — not a generic guess
- **Space breakdown** — shows exactly what uses memory (maps, recursion depth, queues…)
- **Smart matching** — equivalent forms count as correct: `m+n` = `n+m`, `n²` = `n^2`, `log₂ n` = `log n`
- **Algorithm Pattern** — e.g., Sliding Window, Two Pointers, DP, Backtracking

### 🔒 Privacy First
- **No API keys in the extension** — they live only on the server, as encrypted secrets
- Only the problem's public data is sent to the server — no account, no personal data
- Mock interview conversations are **never cached or logged** on the server
- Falls back to **Chrome's built-in AI** (`window.ai`) if the server can't be reached
- Zero data collection — your stats, revision queue and interview history stay in Chrome's local storage

> **Note on voice:** spoken answers are transcribed by Chrome's built-in speech recognition, which sends the audio to Google's servers. Type your answers instead if you'd rather not.

---

## 🚀 Getting Started

### Installation (Developer Mode)

> LeetHint is not yet on the Chrome Web Store. Load it locally in 30 seconds:

1. **Clone this repository**
   ```bash
   git clone https://github.com/Yug912/AlgoMentor.git LeetHint
   cd LeetHint
   ```

2. **Open Chrome Extensions**
   - Go to `chrome://extensions/`
   - Toggle **Developer mode** ON (top-right)

3. **Load the extension**
   - Click **"Load unpacked"**
   - Select the cloned `LeetHint` folder

4. **Pin it** to your toolbar for quick access 📌

---

## 🔑 Zero Setup — No API Key Needed

Install the extension, open a problem, and hints start streaming. All AI calls go through the
**LeetHint server** (a Cloudflare Worker), which holds the API keys — users never see or enter one.

- **Fast** — the server uses the fastest providers first (Cerebras, Groq), then OpenRouter and Gemini
- **Shared cache** — once anyone has opened a problem, it loads instantly for everyone
- **Never stuck** — a provider that hits its limit is skipped automatically; if a reply is cut off before the code, the solution is fetched separately

> **Server unreachable?** LeetHint falls back to Chrome's built-in AI for basic hints (no solution code).

### Running your own server

Forked the project? Deploy your own backend in ~5 minutes — see **[backend/README.md](backend/README.md)** —
then set `BACKEND_URL` in [`api/config.js`](api/config.js). Your keys stay in Cloudflare's encrypted secrets.

---

## 🧩 How It Works

```
┌──────────────────────────── Chrome ─────────────────────────────┐
│  LeetCode tab                         LeetHint side panel       │
│  content.js ── problem data ───────▶  sidepanel.js + api/ai.js  │
│  (LeetCode GraphQL: statement,        • hints, score, stats     │
│   limits, C++ signature, tags;        • revision tab, TC/SC     │
│   "Accepted" solve detection)         • mock interview (voice)  │
│        ▲                                     │                  │
│  service-worker.js (navigation, relay,       │ problem data /   │
│   due-revisions badge)                       │ interview state  │
└──────────────────────────────────────────────┼──────────────────┘
                                               ▼  (no keys, no prompts)
                          ┌──────── LeetHint server (backend/) ────────┐
                          │ builds prompt (shared/prompts.js)           │
                          │ rate limit · shared cache · provider order  │
                          │ API keys = encrypted Worker secrets         │
                          └──────┬────────────────────────────────────┘
                                 ▼  streamed reply: solve → hints → code
                                    (or the interviewer's next turn)
                     Cerebras · Groq · OpenRouter · Gemini
```

### File Structure

```
LeetHint/
├── manifest.json          # Extension config (MV3)
├── api/
│   ├── ai.js              # Server client, streaming parser, built-in AI fallback, TC/SC matcher
│   ├── interview.js       # Mock interview: reply/scorecard parsing, stage rules, code-change check
│   └── config.js          # BACKEND_URL (public — no secrets)
├── shared/
│   ├── prompts.js         # All prompts — used by the server AND the offline fallback
│   └── revision.js        # Spaced-repetition schedule (pure logic, shared by panel + worker)
├── backend/               # Cloudflare Worker that holds the API keys
│   ├── src/index.js       # Routes, validation, rate limit, cache, streaming
│   ├── src/providers.js   # Cerebras / Groq / OpenRouter / Gemini with model fallbacks
│   └── wrangler.toml      # Worker config (no secrets)
├── background/
│   └── service-worker.js  # Navigation detection, message relay, due-revisions badge
├── content/
│   ├── content.js         # LeetCode problem data (GraphQL + DOM fallback), solve detection
│   └── content.css        # Content-script styles
├── sidepanel/
│   ├── sidepanel.html     # Side panel UI (Hints · Revision · Stats tabs)
│   ├── sidepanel.css      # Styling (dark mode, glassmorphism)
│   ├── sidepanel.js       # Main logic: hints, score, stats, revision tab
│   ├── interview.js       # Mock interview UI and session flow
│   ├── voice.js           # Speech synthesis + speech recognition
│   └── mic-permission.*   # One-time microphone permission page
├── data/
│   ├── companies.json     # Problem → company mapping database
│   └── build_companies.py # Script to build the companies DB
├── tests/
│   └── revision.test.mjs  # Spaced-repetition tests (node --test tests/*.test.mjs)
└── icons/
```

---

## 🎨 UI Preview

<table>
  <tr>
    <td align="center"><strong>Hints Tab</strong></td>
    <td align="center"><strong>Stats & Progress</strong></td>
  </tr>
  <tr>
    <td align="center">
      <img src="screenshots/hints-tab.jpeg" alt="Hints Tab — progressive hint cards with score bar" width="300"/>
    </td>
    <td align="center">
      <img src="screenshots/stats-tab.jpeg" alt="Stats Tab — progress tracking with difficulty breakdown" width="300"/>
    </td>
  </tr>
</table>

<table>
  <tr>
    <td align="center"><strong>TC / SC Checker</strong></td>
  </tr>
  <tr>
    <td align="center">
      <img src="screenshots/tc-sc-checker.jpeg" alt="TC/SC Checker — verify your time and space complexity" width="600"/>
    </td>
  </tr>
</table>

**Design highlights:**
- 🌑 **Dark mode** by default — built for late-night grinding
- ✨ **Glassmorphism** — frosted-glass cards with backdrop blur
- 🎞️ **Micro-animations** — smooth hint unlock transitions
- 🔤 **Inter + JetBrains Mono** — premium typography combo

---

## 🧠 Prompt Engineering

LeetHint uses carefully tuned prompts that enforce:
- **Solve before hinting** — one reply contains approach → TC/SC → Hints 1–4 → code, all derived from a solution the model has traced on every example
- **Implementation-specific complexity** — space is derived item by item from the actual code
- **Verifiable edge cases** — Hint 4 must show exact expected outputs and a concrete wrong implementation, never vague "may fail" warnings
- **No spoilers in early hints** — Hint 1 never names the algorithm
- **Problem-specific examples** — uses *actual* numbers from the problem, not generic placeholders
- **Strict output format** — delimiter-based parsing (`---HINT1---`, `---TC---`, etc.), parsed incrementally while streaming
- **Nested Big-O parsing** — custom paren-counting extractor handles `O(n·log(log(n)))` correctly

---

## ⚙️ Permissions Explained

| Permission | Why it's needed |
|------------|----------------|
| `sidePanel` | Show the hint panel alongside LeetCode |
| `storage` | Save your hints cache, progress and stats locally |
| `tabs` | Detect when you navigate to a new problem |
| `scripting` | Inject content script to read problem data |
| `webNavigation` | Track problem page transitions |
| `alarms` | Refresh the due-revisions badge just after local midnight |
| `https://leetcode.com/*` | Access LeetCode pages |
| `https://leethint-api.leethint-backend.workers.dev/*` | Call the LeetHint server (change it if you deploy your own) |
| `http://localhost:8787/*` | Local server during development |

---

## 🛠️ Tech Stack

| Layer | Technology |
|-------|-----------|
| Extension Framework | Chrome Extension Manifest V3 |
| Backend | Cloudflare Worker (rate limiting, KV cache, encrypted secrets) |
| AI Providers | Cerebras, Groq (GPT-OSS 120B), OpenRouter (DeepSeek R1 + free models), Google Gemini |
| Problem Data | LeetCode GraphQL API (DOM scraping fallback) |
| Fallback AI | Chrome Built-in AI (`window.ai`) |
| Voice | Web Speech API (`speechSynthesis`, `webkitSpeechRecognition`) |
| Tests | Node's built-in test runner (`node --test`) |
| Styling | Vanilla CSS with CSS Variables |
| Fonts | Inter, JetBrains Mono (Google Fonts) |
| Data | Bundled JSON company database |

---

## 🤝 Contributing

Contributions are welcome! Here's how to get started:

1. Fork the repository
2. Create your feature branch: `git checkout -b feature/amazing-feature`
3. Commit your changes: `git commit -m 'Add some amazing feature'`
4. Push to the branch: `git push origin feature/amazing-feature`
5. Open a Pull Request

Run the tests before opening a PR (Node 18+, no install needed):

```bash
node --test tests/*.test.mjs
```

### Ideas for contributions
- [ ] Support for more coding platforms (HackerRank, Codeforces)
- [ ] Export stats to CSV
- [ ] Streaks and achievement badges
- [ ] Dark/light theme toggle
- [ ] More company data entries

---

## 📄 License

This project is licensed under the **MIT License** — see the [LICENSE](LICENSE) file for details.

---

## 🙏 Acknowledgements

- [Google AI Studio](https://aistudio.google.com/) — for the Gemini API
- [OpenRouter](https://openrouter.ai/) — for multi-model API access
- [LeetCode](https://leetcode.com/) — for the amazing problem platform
- [Chrome for Developers](https://developer.chrome.com/docs/extensions/) — for MV3 documentation

---

<div align="center">

**Made with ❤️ by [Yug Thakral](https://github.com/Yug912)**

*If LeetHint helped you crack an interview, give it a ⭐!*

</div>
