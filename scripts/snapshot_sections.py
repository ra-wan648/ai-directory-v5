#!/usr/bin/env python3
"""Bake the homepage sections into a static file.

Why this exists: every homepage section is filled by a client-side call to
/api/tools?... and each of those reads D1. When the free tier's daily row read
limit runs out the whole page shows "Could not load this section.", which is
exactly what happened on 13 Sep. The worker already keeps a week-long stale copy
for cache warmth, but that only helps keys that have been fetched successfully
at least once since a deploy, and a quiet site does not warm them all.

So the pipeline writes what the sections contain into public/data/sections.json,
which Cloudflare Pages serves as a plain static asset - no D1, no cache, no
worker. The front end only reaches for it when the live call fails, so visitors
see slightly old data instead of an empty page.

Run: python3 scripts/snapshot_sections.py [--worker URL] [--out PATH]
"""
import json
import os
import sys
import time
import urllib.request
from datetime import datetime, timezone

WORKER = "https://ai-directory-v5-worker.radwanislam648.workers.dev"
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "public", "data", "sections.json")

# Must stay in step with SECTIONS in public/js/app.js - each entry is the query
# that the section sends, minus the limit the front end adds.
SECTIONS = [
    {"sort": "newest", "days": "7"},
    {"featured": "1"},
    {"pricing": "free"},
    {"category": "Open Source"},
    {"source": "huggingface"},
    {"source": "producthunt"},
]


def key_for(q, limit=6):
    """The same canonical key the front end builds: sorted, limit included."""
    params = dict(q)
    params["limit"] = str(limit)
    return "&".join(f"{k}={params[k]}" for k in sorted(params))


def fetch(path, tries=4):
    url = WORKER + path
    for i in range(tries):
        try:
            with urllib.request.urlopen(url, timeout=45) as r:
                return json.loads(r.read())
        except Exception as e:
            print(f"    {path}: {str(e)[:90]}")
            time.sleep(5)
    return None


def main():
    out = OUT
    argv = sys.argv[1:]
    for i, a in enumerate(argv):
        if a == "--out" and i + 1 < len(argv):
            out = argv[i + 1]

    snap = {
        "generated_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "stats": None,
        "sections": {},
    }

    stats = fetch("/api/stats")
    if stats:
        snap["stats"] = stats
        print(f"  stats: {stats.get('total_tools')} tools")

    ok = 0
    for q in SECTIONS:
        k = key_for(q)
        from urllib.parse import urlencode
        d = fetch("/api/tools?" + urlencode(dict(q, limit=6)))
        if d and isinstance(d.get("tools"), list):
            snap["sections"][k] = {"tools": d["tools"], "total": d.get("total", len(d["tools"]))}
            ok += 1
            print(f"  {k}: {len(d['tools'])} tool(s)")
        else:
            print(f"  {k}: FAILED - left out of the snapshot")

    if not ok:
        print("  nothing could be fetched; leaving the existing snapshot alone")
        return 1

    empty = [k for k in (key_for(q) for q in SECTIONS) if k not in snap["sections"]]
    if empty:
        # Keep the previous copy of any section that failed rather than dropping
        # it - a stale section beats a blank one.
        try:
            with open(out) as fh:
                prev = json.load(fh)
            for k in empty:
                if k in (prev.get("sections") or {}):
                    snap["sections"][k] = prev["sections"][k]
                    print(f"  {k}: kept the previous snapshot's copy")
        except Exception:
            pass

    os.makedirs(os.path.dirname(out), exist_ok=True)
    with open(out, "w") as fh:
        json.dump(snap, fh, indent=1)
    print(f"  wrote {os.path.relpath(out, os.path.dirname(os.path.dirname(out)))} "
          f"with {len(snap['sections'])} section(s)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
