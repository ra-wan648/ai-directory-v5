#!/usr/bin/env python3
"""Bake the whole directory into one static file the browser can fall back on.

The site reads D1 on every listing, detail and section request. D1's free tier
allows 5,000,000 rows read per day and the site was using 7.7-9.6M, so the
quota runs out and the site goes blank: every section says "Could not load this
section." and opening a tool says "That tool could not be loaded".

The worker keeps a stale copy per cache key, but that only covers keys that have
been fetched successfully since the last deploy, which a quiet site never warms.

So the pipeline writes this file. It is a plain static asset served by Cloudflare
Pages - no D1, no worker, no cache - and the front end only reads it when the
live call fails. The visitor gets slightly old data instead of an empty page.

Writes public/data/offline.json:
  { generated_at, stats, categories, tools[], blogs[], prompts[] }
Descriptions are trimmed to keep the file small; the full text stays in D1 and
is what the live API serves.

Run: python3 scripts/snapshot_offline.py
"""
import json
import os
import sys
import time
import urllib.request
from datetime import datetime, timezone

ACCOUNT = os.environ.get("CF_ACCOUNT_ID", "2acb9835655d0f4183eb7f899580f6ab")
DB_ID = os.environ.get("CF_D1_ID", "ff26faf5-3c7c-445a-a249-6c96fedddfdc")
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "public", "data", "offline.json")

TOOL_COLS = ("id, slug, name, category, pricing, url, short_desc, featured, tags, "
             "logo_url, tag, views, votes, created_at")
DESC_LIMIT = 600


def token():
    for k in ("CF_API_TOKEN", "CLOUDFLARE_API_TOKEN"):
        if os.environ.get(k):
            return os.environ[k]
    raise SystemExit("CF_API_TOKEN is not set")


def query(sql, tries=6):
    url = f"https://api.cloudflare.com/client/v4/accounts/{ACCOUNT}/d1/database/{DB_ID}/query"
    body = json.dumps({"sql": sql}).encode()
    req = urllib.request.Request(
        url, data=body,
        headers={"Authorization": f"Bearer {token()}", "Content-Type": "application/json"},
        method="POST")
    for i in range(tries):
        try:
            with urllib.request.urlopen(req, timeout=120) as r:
                d = json.loads(r.read())
        except Exception as e:
            print(f"    attempt {i+1}: {str(e)[:90]}")
            time.sleep(20)
            continue
        if d.get("success"):
            return d["result"][0]["results"]
        errs = d.get("errors") or []
        print(f"    attempt {i+1}: error {errs[0].get('code') if errs else '?'} "
              f"{(errs[0].get('message') if errs else '')[:80]}")
        time.sleep(20)
    return None


def main():
    snap = {"generated_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")}

    print("  stats")
    stats = query("""SELECT
        COUNT(*) AS total_tools,
        SUM(CASE WHEN tag='new' THEN 1 ELSE 0 END) AS new_tools,
        SUM(CASE WHEN tag='trending' THEN 1 ELSE 0 END) AS trending_tools,
        SUM(CASE WHEN tag='featured' THEN 1 ELSE 0 END) AS featured_tools,
        SUM(CASE WHEN featured=1 THEN 1 ELSE 0 END) AS featured_flag,
        SUM(CASE WHEN pricing='free' THEN 1 ELSE 0 END) AS free_tools,
        SUM(CASE WHEN created_at > datetime('now','-1 day') THEN 1 ELSE 0 END) AS today_added
        FROM tools WHERE status='published'""")
    if stats:
        extra = query("SELECT "
                      "(SELECT COUNT(*) FROM blogs WHERE status='published') AS total_blogs, "
                      "(SELECT COUNT(*) FROM prompts WHERE status='published') AS total_prompts")
        if extra:
            stats[0].update(extra[0])
    if not stats:
        print("  D1 unavailable - leaving the existing snapshot alone")
        return 1
    snap["stats"] = stats[0]
    print(f"    total_tools={snap['stats'].get('total_tools')}")

    print("  categories")
    cats = query("SELECT name, slug, icon, tool_count FROM categories "
                 "ORDER BY tool_count DESC")
    if cats is None:
        return 1
    snap["categories"] = cats
    print(f"    {len(cats)} categor(y/ies)")

    print("  tools")
    rows = query(f"""SELECT {TOOL_COLS}, substr(COALESCE(description,''), 1, {DESC_LIMIT}) AS description
                     FROM tools WHERE status='published'
                     ORDER BY created_at DESC""")
    if not rows:
        print("  tools read failed - leaving the existing snapshot alone")
        return 1
    snap["tools"] = rows
    print(f"    {len(rows)} tool(s)")

    # Both are optional: a missing column here must not cost us the tools half
    # of the snapshot, which is what the site actually needs.
    print("  blogs (list fields only)")
    snap["blogs"] = query("""SELECT id, title, slug, category, meta_description,
                                    published_at, created_at
                             FROM blogs WHERE status='published'
                             ORDER BY COALESCE(published_at, created_at) DESC""") or []
    print(f"    {len(snap['blogs'])} blog(s)")

    print("  prompts (list fields only)")
    snap["prompts"] = query("""SELECT id, title, slug, description, category,
                                      compatible_tools, copy_count
                               FROM prompts WHERE status='published' ORDER BY id DESC""") or []
    print(f"    {len(snap['prompts'])} prompt(s)")

    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, "w") as fh:
        json.dump(snap, fh, separators=(",", ":"))
    size = os.path.getsize(OUT)
    print(f"  wrote public/data/offline.json - {size/1024:.0f} KB")
    return 0


if __name__ == "__main__":
    sys.exit(main())
