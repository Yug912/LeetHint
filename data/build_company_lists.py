#!/usr/bin/env python3
"""
Builds data/company-problems.json: for every company, its LeetCode problems
ranked by how often they were reported in interviews (most asked first).
  python3 data/build_company_lists.py

Source: hxu296/leetcode-company-wise-problems-2022 (MIT licence), one CSV per
company: problem_link, problem_name, num_occur. Difficulty and Premium flags
come from LeetCode's public problem list (one GraphQL request).

Output (compact, ~1 file for the side panel's Companies tab):
  { "source": "...", "builtAt": "YYYY-MM-DD",
    "companies": { "Amazon": [["lru-cache", "LRU Cache", 117, "M", 0], ...], ... } }
  row = [slug, title, timesReported, difficulty E/M/H ("" if unknown), premiumOnly 0/1]
data/companies.json (top 4 companies per problem, shown under the title) is
built by build_companies.py and is not touched here.
"""
import urllib.request, json, csv, io, ssl, os, re, datetime
from concurrent.futures import ThreadPoolExecutor

# Verifies certificates — never disable this. python.org builds on macOS ship
# without a CA bundle; macOS's own one is used then (still fully verified).
ctx = ssl.create_default_context(cafile="/etc/ssl/cert.pem" if os.path.exists("/etc/ssl/cert.pem") else None)
REPO = "hxu296/leetcode-company-wise-problems-2022"
BASE = f"https://raw.githubusercontent.com/{REPO}/main/companies/"
API = f"https://api.github.com/repos/{REPO}/contents/companies"
MIN_PROBLEMS = 5      # companies with fewer problems aren't worth a list


def fetch(url, data=None, headers=None):
    req = urllib.request.Request(url, data=data, headers={"User-Agent": "LeetHint/1.0", **(headers or {})})
    with urllib.request.urlopen(req, context=ctx, timeout=30) as r:
        return r.read()


def slug_of(link, name):
    m = re.search(r"/problems/([^/]+)/", str(link))
    if m:
        return m.group(1)
    return re.sub(r"[^a-z0-9-]", "", (name or "").strip().lower().replace(" ", "-"))


def leetcode_meta():
    """slug → (difficulty letter, premium 0/1) for every LeetCode problem."""
    query = """query q($skip: Int!, $limit: Int!) { problemsetQuestionList: questionList(categorySlug: "",
      limit: $limit, skip: $skip, filters: {}) { total: totalNum questions: data { titleSlug difficulty isPaidOnly } } }"""
    meta, skip = {}, 0
    while True:
        body = json.dumps({"query": query, "variables": {"skip": skip, "limit": 100}}).encode()
        res = json.loads(fetch("https://leetcode.com/graphql", body,
                               {"Content-Type": "application/json", "Referer": "https://leetcode.com/problemset/"}))
        page = res["data"]["problemsetQuestionList"]
        for q in page["questions"]:
            meta[q["titleSlug"]] = ((q["difficulty"] or " ")[0].upper().strip(), 1 if q["isPaidOnly"] else 0)
        skip += len(page["questions"])   # LeetCode caps a page (500 today), whatever limit is asked
        if skip >= page["total"] or not page["questions"]:
            return meta


def company_rows(name):
    text = fetch(BASE + urllib.request.quote(name)).decode("utf-8")
    rows = {}
    for row in csv.DictReader(io.StringIO(text)):
        slug = slug_of(row.get("problem_link"), row.get("problem_name"))
        try:
            count = int(row.get("num_occur") or 0)
        except ValueError:
            count = 0
        # count 0 = never actually reported (a few rows in the source) — skipped
        if slug and count > 0 and count > rows.get(slug, (None, -1))[1]:
            rows[slug] = ((row.get("problem_name") or slug).strip(), count)
    return rows


print("LeetCode problem list (difficulty, Premium)…")
meta = leetcode_meta()
print(f"  {len(meta)} problems")

files = [f["name"] for f in json.loads(fetch(API)) if f["name"].endswith(".csv")]
print(f"{len(files)} company files…")
with ThreadPoolExecutor(max_workers=16) as ex:
    results = list(ex.map(lambda f: (f[:-4], company_rows(f)), files))

companies, unknown = {}, 0
for company, rows in sorted(results, key=lambda r: r[0].lower()):
    if len(rows) < MIN_PROBLEMS:
        continue
    ranked = sorted(rows.items(), key=lambda kv: (-kv[1][1], kv[1][0]))
    out = []
    for slug, (title, count) in ranked:
        diff, paid = meta.get(slug, ("", 0))
        if slug not in meta:
            unknown += 1
        out.append([slug, title, count, diff, paid])
    companies[company] = out

doc = {"source": f"github.com/{REPO} (MIT)", "builtAt": datetime.date.today().isoformat(), "companies": companies}
os.makedirs("data", exist_ok=True)
with open("data/company-problems.json", "w") as f:
    json.dump(doc, f, separators=(",", ":"), ensure_ascii=False)

total = sum(len(v) for v in companies.values())
print(f"\nSaved data/company-problems.json: {len(companies)} companies, {total} rows, "
      f"{os.path.getsize('data/company-problems.json') / 1024:.0f} KB ({unknown} rows without LeetCode metadata)")
for c in ("Amazon", "Google", "Facebook", "Microsoft"):
    print(f"  {c}: {len(companies.get(c, []))} problems, top 3: {[r[1] for r in companies.get(c, [])[:3]]}")
