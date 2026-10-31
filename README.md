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

<br/>

</div>

---

## ✨ Features

### 🎯 Progressive AI Hints
LeetHint generates **4 layered hints plus a full solution** with **Gemini** (or any model via **OpenRouter**):

| Hint | Name | What it gives you |
|------|------|-------------------|
| 💡 Hint 1 | **Pattern Recognition** | A pointed question about the real constraints — no algorithm spoilers |
| 🔑 Hint 2 | **Concrete Technique** | Names the exact data structure with a walkthrough step on a real example |
| 📋 Hint 3 | **Algorithm Skeleton** | Language-neutral pseudocode for the happy path |
| ⚠️ Hint 4 | **Edge Cases & Gotchas** | 3–5 valid edge cases with exact expected outputs and the concrete bug each one catches |
| 💀 Solution | **Accepted C++ Code** | Copy-paste-ready `class Solution` using LeetCode's exact signature |

### ✅ Accuracy First
- **Solve first, then teach** — the model solves the problem and traces its code on every example *before* writing hints, so every hint leads to the same correct approach
- **Exact problem data** — statement, constraints, topic tags, official hints and the C++ signature come straight from LeetCode's API (constraints like `10^5` are never mangled)
- **🔧 Fix button** — re-checks the solution against the examples and constraints and repairs it

### ⚡ Fast & Live
- **Streaming** — each hint appears the moment it's written; no waiting for the whole answer
- **One request per problem** — light on free-tier API quota
- **Cached** — revisiting a problem is instant and costs no API calls
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

### 🏢 Company Tags
Know which **top tech companies** have asked each problem — pulled from a curated database of **hundreds of problems**, tagged with companies like Google, Meta, Amazon, Apple, and more.

### 📐 TC / SC Checker
Enter your own complexity and check it against the solution:
- **Time & Space Complexity** of the actual solution code — not a generic guess
- **Space breakdown** — shows exactly what uses memory (maps, recursion depth, queues…)
- **Smart matching** — equivalent forms count as correct: `m+n` = `n+m`, `n²` = `n^2`, `log₂ n` = `log n`
- **Algorithm Pattern** — e.g., Sliding Window, Two Pointers, DP, Backtracking

### 🔒 Privacy First
- Your API keys are stored **locally** in Chrome storage and sent only to the AI provider you chose (Google or OpenRouter)
- Falls back to **Chrome's built-in AI** (`window.ai`) if no key is provided
- Zero data collection

---

## 🚀 Getting Started

### Installation (Developer Mode)

> LeetHint is not yet on the Chrome Web Store. Load it locally in 30 seconds:

1. **Clone this repository**
   ```bash
   git clone https://github.com/Yug912/AlgoMentor.git
   cd AlgoMentor
   ```

2. **Open Chrome Extensions**
   - Go to `chrome://extensions/`
   - Toggle **Developer mode** ON (top-right)

3. **Load the extension**
   - Click **"Load unpacked"**
   - Select the cloned `AlgoMentor` folder

4. **Pin it** to your toolbar for quick access 📌

---

## 🔑 Setting Up an API Key

LeetHint works with either key. If both are set, OpenRouter is tried first and Gemini is the fallback.

### Option 1 — Google Gemini (free)
1. Visit [Google AI Studio](https://aistudio.google.com/apikey)
2. Click **"Create API Key"**
3. Open LeetHint sidebar → Click **"Add Key"** → Paste and save

> **Free-tier limits:** Google limits free keys per minute and per day. LeetHint uses one request per problem, waits out short per-minute limits automatically, and tells you when the daily quota is used up (it resets at midnight Pacific). Check usage at [ai.dev/rate-limit](https://ai.dev/rate-limit).
>
> If Google retires the Gemini model LeetHint uses, the extension switches to the replacement model Google recommends automatically.

### Option 2 — OpenRouter (pay-as-you-go)
1. Create a key at [openrouter.ai/keys](https://openrouter.ai/keys)
2. Open LeetHint sidebar → **OpenRouter** → Paste and save

Uses **DeepSeek R1** by default — change `OR_MODEL` in `api/gemini.js` to use any OpenRouter model.

> **No key?** LeetHint falls back to Chrome's built-in AI for basic hints (no solution code).

---

## 🧩 How It Works

```
┌─────────────────────────────────────────────────────────────┐
│                        LeetCode Tab                         │
│  ┌─────────────────────────┐    ┌─────────────────────────┐ │
│  │   Problem Page (DOM)    │    │     LeetHint Sidebar     │ │
│  │                         │    │                          │ │
│  │  content.js fetches     │───▶│  Problem info + diff.   │ │
│  │  (LeetCode GraphQL):    │    │  ┌────────────────────┐  │ │
│  │  • Statement + limits   │    │  │  4 Hints + C++     │  │ │
│  │  • C++ signature        │    │  │  (streamed live)   │  │ │
│  │  • Topic tags, hints    │    │  └────────────────────┘  │ │
│  └─────────────────────────┘    │  • Score tracker         │ │
│                                 │  • Company tags          │ │
│  service-worker.js              │  • TC / SC checker       │ │
│  (message relay)         ◀─────▶│  • Stats history         │ │
│                                 └─────────────────────────┘ │
│         ▲                                                    │
│         │                                                    │
│  gemini.js  ──────────▶  Gemini API  /  OpenRouter          │
│  (one streamed request: solve → hints → code)                │
└─────────────────────────────────────────────────────────────┘
```

### File Structure

```
LeetHint/
├── manifest.json          # Extension config (MV3)
├── api/
│   └── gemini.js          # AI providers, prompts, streaming, parsing
├── background/
│   └── service-worker.js  # Message relay between content & sidepanel
├── content/
│   ├── content.js         # LeetCode problem data (GraphQL + DOM fallback)
│   └── content.css        # Content-script styles
├── sidepanel/
│   ├── sidepanel.html     # Side panel UI
│   ├── sidepanel.css      # Styling (dark mode, glassmorphism)
│   └── sidepanel.js       # Main logic: hints, score, stats, tabs
├── data/
│   ├── companies.json     # Problem → company mapping database
│   └── build_companies.py # Script to build the companies DB
└── icons/
    ├── icon16.png
    ├── icon48.png
    └── icon128.png
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
| `storage` | Save your API key and stats locally |
| `tabs` | Detect when you navigate to a new problem |
| `scripting` | Inject content script to read problem data |
| `webNavigation` | Track problem page transitions |
| `https://leetcode.com/*` | Access LeetCode pages |
| `https://generativelanguage.googleapis.com/*` | Call Gemini API |

---

## 🛠️ Tech Stack

| Layer | Technology |
|-------|-----------|
| Extension Framework | Chrome Extension Manifest V3 |
| AI Backend | Google Gemini (Flash, auto-updated) or OpenRouter (DeepSeek R1 by default) |
| Problem Data | LeetCode GraphQL API (DOM scraping fallback) |
| Fallback AI | Chrome Built-in AI (`window.ai`) |
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
