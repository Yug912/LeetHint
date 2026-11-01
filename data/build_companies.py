#!/usr/bin/env python3
"""
Fast parallel build of data/companies.json.
CSV format: problem_link, problem_name, num_occur
Slug extracted from URL: .../problems/<slug>/
"""
import urllib.request, json, csv, io, ssl, os, re
from concurrent.futures import ThreadPoolExecutor, as_completed

ctx = ssl.create_default_context()  # verifies certificates — never disable this

def fetch(url):
    req = urllib.request.Request(url, headers={"User-Agent": "LeetHint/1.0"})
    with urllib.request.urlopen(req, context=ctx, timeout=15) as r:
        return r.read()

BASE = "https://raw.githubusercontent.com/hxu296/leetcode-company-wise-problems-2022/main/companies/"
API  = "https://api.github.com/repos/hxu296/leetcode-company-wise-problems-2022/contents/companies"

print("Fetching file list...")
files = json.loads(fetch(API))
csv_files = [(f["name"], f["name"][:-4]) for f in files if f["name"].endswith(".csv")]
print(f"Found {len(csv_files)} company CSVs — downloading in parallel...")

def extract_slug(link):
    # https://leetcode.com/problems/two-sum/ -> two-sum
    m = re.search(r'/problems/([^/]+)/', str(link))
    return m.group(1) if m else ''

def process_company(name, company):
    url = BASE + urllib.request.quote(name)
    try:
        text = fetch(url).decode("utf-8")
    except Exception as e:
        return company, None, str(e)

    reader = csv.DictReader(io.StringIO(text))
    result = {}
    for rank, row in enumerate(reader):
        slug = extract_slug(row.get("problem_link", ""))
        if not slug:
            # fallback: derive from problem_name
            name_val = (row.get("problem_name") or "").strip()
            slug = name_val.lower().replace(" ", "-").replace("'","").replace(".","")
        if slug:
            # num_occur: higher = more frequent = lower rank (we invert)
            try:
                occur = int(row.get("num_occur", 0))
            except:
                occur = 0
            result[slug] = -occur  # negative so sort ascending = most frequent first
    return company, result, None

inverted = {}  # slug -> {company: sort_key}
done = 0
with ThreadPoolExecutor(max_workers=20) as ex:
    futures = {ex.submit(process_company, name, co): co for name, co in csv_files}
    for fut in as_completed(futures):
        company, result, err = fut.result()
        done += 1
        if err:
            print(f"  [{done}/{len(csv_files)}] SKIP {company}: {err}")
        else:
            for slug, sort_key in (result or {}).items():
                if slug not in inverted:
                    inverted[slug] = {}
                inverted[slug][company] = sort_key
            if done % 40 == 0:
                print(f"  [{done}/{len(csv_files)}] processed...")

print(f"\nBuilding top-4 map for {len(inverted)} problems...")
final = {}
for slug, comp_keys in inverted.items():
    top4 = sorted(comp_keys.items(), key=lambda x: x[1])[:4]  # most frequent first
    final[slug] = [c for c, _ in top4]

os.makedirs("data", exist_ok=True)
with open("data/companies.json", "w") as f:
    json.dump(final, f, separators=(",",":"))

size_kb = os.path.getsize("data/companies.json") / 1024
print(f"\n✅ Saved data/companies.json — {len(final)} problems, {size_kb:.1f} KB")

# Quick sanity check
samples = ["two-sum", "longest-substring-without-repeating-characters", "merge-intervals"]
for s in samples:
    print(f"  {s}: {final.get(s, 'NOT FOUND')}")
