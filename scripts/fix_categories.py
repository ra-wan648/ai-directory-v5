#!/usr/bin/env python3
"""Tidy the category system.

Measured on 13 Sep: tools carry 19 distinct category values but the categories
table has only 12 rows, so seven categories have no page and no link anywhere.
"AI Tools" is a catch-all holding 3,769 of 7,812 published tools - 48% of the
directory, which makes a category grid pointless.

This does three things, all deterministic (no model calls, no spend):
  1. insert any category that tools use but the table does not have
  2. merge near-duplicates onto one intent-based name
  3. reclassify the "AI Tools" catch-all from each row's own text, so the rows
     land in a category a visitor would actually browse

Prints before/after counts per category and 20 samples per new category, so the
result can be reviewed from the run log.

Run: python3 scripts/fix_categories.py [--apply]
"""
import json
import os
import re
import sys
import time
import urllib.request
from collections import Counter

ACCOUNT = os.environ.get("CF_ACCOUNT_ID", "2acb9835655d0f4183eb7f899580f6ab")
DB_ID = os.environ.get("CF_D1_ID", "ff26faf5-3c7c-445a-a249-6c96fedddfdc")
APPLY = "--apply" in sys.argv

CATCH_ALL = "AI Tools"

# near-duplicates -> one intent-based name
MERGE = {
    "AI Assistant": "Assistants & Agents",
    "Chat": "Assistants & Agents",
    "AI Tools": "Assistants & Agents",
    "Writing": "Writing & Content",
    "Image": "Design & Art",
    "Video": "Video & Animation",
    "Audio": "Voice & Sound",
    "Coding": "Coding & Dev",
    "Open Source": "Coding & Dev",
    "Business": "Business & Productivity",
    "Productivity": "Business & Productivity",
    "Marketing": "Business & Productivity",
    "Analytics": "Data & Automation",
    "Automation": "Data & Automation",
    "Education": "Education & Research",
    "Research": "Education & Research",
    "Finance": "Finance",
}

# keyword -> destination, checked against name + short_desc + description.
# Order matters: the first match wins, so put the specific ones first.
RULES = [
    # Order matters: first match wins, so the specific categories come first.
    # Every noun carries an optional plural, because "Generate images from a
    # prompt" matched nothing when only "image" was listed.
    ("Coding & Dev", r"\b(codes?|coding|developer|developers|programming|ides?|compilers?|git|apis?|sdks?|docker|kubernetes|databases?|sql|devops|debug(ger|ging)?)\b"),
    ("Voice & Sound", r"\b(voices?|audios?|speech|songs?|music|podcasts?|tts|text.to.speech|transcri(be|ption|pt)|sounds?|singers?|singing|dubbing|noise)\b"),
    ("Video & Animation", r"\b(videos?|animations?|animat(e|ing)|movies?|films?|clips?|subtitles?|reels|shorts|video editing)\b"),
    ("Design & Art", r"\b(images?|photos?|designs?|designing|arts?|logos?|illustrations?|drawings?|paintings?|renders?|3d|graphics?|wallpapers?|upscal(e|ing)|background remov(al|e))\b"),
    ("Writing & Content", r"\b(writ(e|er|ing)|copywrit(er|ing)|blogs?|articles?|essays?|contents?|paraphras(e|ing)|summari[sz]e|summaries|grammar|translat(e|ion|or)|documents?|resumes?|lyrics?|captions?)\b"),
    ("Data & Automation", r"\b(automat(e|ion|ing)|workflows?|scrap(e|er|ing)|data|analytics|dashboards?|etl|integrations?|zapier|no.?code|spreadsheets?|reports?|insights?)\b"),
    ("Business & Productivity", r"\b(business|crm|sales|invoices?|meetings?|notes?|tasks?|project manag(e|ement)|hr|recruit(ing|ment)?|calendars?|schedul(e|ing)|support|helpdesks?|legal)\b"),
    ("Education & Research", r"\b(learn(ing)?|courses?|study|tutors?|quizzes?|exams?|research|papers?|academic|librar(y|ies)|students?|schools?|universit(y|ies))\b"),
    ("Finance", r"\b(finance|fintech|invest(ing|ment)?|trading|stocks?|crypto|tax(es)?|accounting|payments?|budgets?|expenses?)\b"),
    ("Assistants & Agents", r"\b(assistants?|chatbots?|chats?|agents?|copilots?|companions?|answers?|q&a|search engines?|sidekicks?)\b"),
]


def token():
    for k in ("CF_API_TOKEN", "CLOUDFLARE_API_TOKEN"):
        if os.environ.get(k):
            return os.environ[k]
    raise SystemExit("CF_API_TOKEN is not set")


def query(sql, params=None, tries=6):
    url = f"https://api.cloudflare.com/client/v4/accounts/{ACCOUNT}/d1/database/{DB_ID}/query"
    body = {"sql": sql}
    if params:
        body["params"] = params
    req = urllib.request.Request(
        url, data=json.dumps(body).encode(),
        headers={"Authorization": f"Bearer {token()}", "Content-Type": "application/json"},
        method="POST")
    for i in range(tries):
        try:
            with urllib.request.urlopen(req, timeout=120) as r:
                d = json.loads(r.read())
        except Exception as e:
            print(f"    attempt {i+1}: {str(e)[:80]}")
            time.sleep(20)
            continue
        if d.get("success"):
            return d["result"][0]["results"]
        errs = d.get("errors") or []
        print(f"    attempt {i+1}: error {errs[0].get('code') if errs else '?'}")
        time.sleep(20)
    return None


def slugify(name):
    return re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-")


def pick(text):
    low = text.lower()
    for dest, pat in RULES:
        if re.search(pat, low):
            return dest
    return "Other"


def main():
    print(f"fix_categories: {'APPLYING' if APPLY else 'DRY RUN (nothing will be written)'}")

    before = query("SELECT category, COUNT(*) AS n FROM tools WHERE status='published' "
                   "GROUP BY category ORDER BY n DESC")
    if not before:
        print("  D1 read blocked - nothing to do")
        return 1
    print(f"  before: {len(before)} category value(s)")
    for r in before[:10]:
        print(f"    {r['category']!r}: {r['n']}")

    have = {r["name"] for r in (query("SELECT name FROM categories") or [])}
    missing = [r["category"] for r in before if r["category"] and r["category"] not in have]
    print(f"  categories in tools but not in the table: {len(missing)} -> {missing}")

    # 1. register the missing categories
    if APPLY:
        for name in missing:
            query("INSERT OR IGNORE INTO categories (name, slug, icon, tool_count) VALUES (?,?,?,0)",
                  [name, slugify(name), "🧠"])
        print(f"    registered {len(missing)}")

    # 2. merge the near-duplicates
    merged = 0
    for old, new in MERGE.items():
        n = next((r["n"] for r in before if r["category"] == old), 0)
        if not n or old == new:
            continue
        if APPLY:
            query("UPDATE tools SET category = ? WHERE status='published' AND category = ?", [new, old])
        merged += n
        print(f"    {old!r} -> {new!r} ({n} row(s))")
    print(f"  merged {merged} row(s) onto {len(set(MERGE.values()))} intent-based categories")

    # 3. give the catch-all rows a real category, from their own text
    rows = query("SELECT id, name, COALESCE(short_desc,'') AS s, COALESCE(description,'') AS d "
                 "FROM tools WHERE status='published' AND category = ?", [CATCH_ALL])
    if rows is None:
        print("  could not read the catch-all rows")
        return 1
    print(f"  reclassifying {len(rows)} catch-all row(s)")
    counts, samples = Counter(), {}
    for r in rows:
        dest = pick(f"{r['name']} {r['s']} {r['d']}")
        counts[dest] += 1
        samples.setdefault(dest, [])
        if len(samples[dest]) < 20:
            samples[dest].append(r["name"][:56])
        if APPLY:
            query("UPDATE tools SET category = ? WHERE id = ?", [dest, r["id"]])
    for dest, n in counts.most_common():
        print(f"    {dest}: {n}")
    for dest in counts:
        print(f"    samples for {dest}:")
        for nm in samples[dest][:8]:
            print(f"      {nm!r}")

    after = query("SELECT category, COUNT(*) AS n FROM tools WHERE status='published' "
                  "GROUP BY category ORDER BY n DESC")
    if after:
        total = sum(r["n"] for r in after) or 1
        print("  after:")
        for r in after[:12]:
            print(f"    {r['category']!r}: {r['n']} ({100*r['n']/total:.0f}%)")
        biggest = max(after, key=lambda r: r["n"])
        print(f"  largest category: {biggest['category']!r} at "
              f"{100*biggest['n']/total:.0f}% (target: under 25%)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
