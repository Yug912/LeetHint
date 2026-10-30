<div align="center">

# 💡 LeetHint

### *Solve Smarter, Not Harder*

**AI-powered progressive hints for LeetCode — right in your browser sidebar.**

[![Chrome Extension](https://img.shields.io/badge/Chrome-Extension-4285F4?style=for-the-badge&logo=googlechrome&logoColor=white)](https://github.com/Yug912/LeetHint)
[![Manifest V3](https://img.shields.io/badge/Manifest-V3-orange?style=for-the-badge&logo=googlechrome&logoColor=white)](https://developer.chrome.com/docs/extensions/mv3/)
[![Gemini AI](https://img.shields.io/badge/Powered%20by-Gemini%20AI-8E75B2?style=for-the-badge&logo=google&logoColor=white)](https://ai.google.dev/)
[![License: MIT](https://img.shields.io/badge/License-MIT-green?style=for-the-badge)](LICENSE)

<br/>

> 🧠 Get 4 progressive hints — from pattern nudges to pseudocode — without spoiling the solution.  
> Track your performance score, see what companies asked this problem, and stay in the zone.

<br/>

</div>

---

## ✨ Features

### 🎯 Progressive AI Hints
LeetHint generates **4 intelligent, layered hints** powered by **Gemini 2.5 Pro**:

| Hint | Name | What it gives you |
|------|------|-------------------|
| 💡 Hint 1 | **Pattern Recognition** | A pointed question about constraints — no algorithm spoilers |
| 🔑 Hint 2 | **Concrete Technique** | Names the exact data structure with a walkthrough step |
| 📋 Hint 3 | **Algorithm Skeleton** | Clean pseudocode for the happy path (4–6 lines) |
| ⚠️ Hint 4 | **Edge Cases & Gotchas** | 2–3 tricky test cases unique to this problem |

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

### ⚡ Complexity Analysis
Every hint set includes:
- **Time Complexity** — Optimal Big-O for the problem
- **Space Complexity** — Memory trade-offs explained
- **Algorithm Pattern** — e.g., Sliding Window, Two Pointers, DP, Backtracking

### 🔒 Privacy First
- Your **Gemini API key** is stored locally in Chrome storage — never sent to any third-party server
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
   - Select the `LeetHint` folder

4. **Pin it** to your toolbar for quick access 📌

---

## 🔑 Setting Up Your Gemini API Key

LeetHint uses **Google Gemini 2.5 Pro** for the smartest hints. Get your free API key:

1. Visit [Google AI Studio](https://aistudio.google.com/apikey)
2. Click **"Create API Key"** (it's free!)
3. Open LeetHint sidebar → Click **"Add Key"** → Paste and save

> **No key?** No problem — LeetHint falls back to Chrome's built-in AI for basic hints.

---

## 🧩 How It Works

```
┌─────────────────────────────────────────────────────────────┐
│                        LeetCode Tab                         │
│  ┌─────────────────────────┐    ┌─────────────────────────┐ │
│  │   Problem Page (DOM)    │    │     LeetHint Sidebar     │ │
│  │                         │    │                          │ │
│  │  content.js extracts:   │───▶│  Problem info + diff.   │ │
│  │  • Title                │    │  ┌────────────────────┐  │ │
│  │  • Difficulty           │    │  │  4 Progressive     │  │ │
│  │  • Description          │    │  │  AI Hints          │  │ │
│  │  • Problem Number       │    │  └────────────────────┘  │ │
│  └─────────────────────────┘    │  • Score tracker         │ │
│                                 │  • Company tags          │ │
│  service-worker.js              │  • TC / SC analysis      │ │
│  (message relay)         ◀─────▶│  • Stats history         │ │
│                                 └─────────────────────────┘ │
│         ▲                                                    │
│         │                                                    │
│  gemini.js  ──────────▶  Gemini 2.5 Pro API                 │
│  (hint generation)                                           │
└─────────────────────────────────────────────────────────────┘
```

### File Structure

```
LeetHint/
├── manifest.json          # Extension config (MV3)
├── api/
│   └── gemini.js          # AI hint generation + prompt engineering
├── background/
│   └── service-worker.js  # Message relay between content & sidepanel
├── content/
│   ├── content.js         # DOM scraper for LeetCode problem data
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
- **Strict output format** — delimiter-based parsing (`---HINT1---`, `---TC---`, etc.)
- **No spoilers in early hints** — Hint 1 never names the algorithm
- **Problem-specific examples** — uses *actual* numbers from the problem, not generic placeholders
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
| AI Backend | Google Gemini 2.5 Pro (`gemini-2.5-pro`) |
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
- [LeetCode](https://leetcode.com/) — for the amazing problem platform
- [Chrome for Developers](https://developer.chrome.com/docs/extensions/) — for MV3 documentation

---

<div align="center">

**Made with ❤️ by [Yug Thakral](https://github.com/Yug912)**

*If LeetHint helped you crack an interview, give it a ⭐!*

</div>
