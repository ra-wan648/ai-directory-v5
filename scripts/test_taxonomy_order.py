#!/usr/bin/env python3
"""Replay fix_categories.py against an in-memory sqlite stand-in of D1.

Same SQL, same control flow - only the transport changes, so this shows the
final category distribution without touching the real database or spending a
single read.

The seed mirrors what the live database actually looks like after the first
deploy went wrong: the merge ran before the reclassification, so the catch-all
rows were renamed to "Assistants & Agents" and sat there mixed in with genuine
assistant tools. The point of the test is that the repair drains that bucket
anyway, because it re-reads the whole bucket from each row's own text.

Run: python3 scripts/test_taxonomy_order.py
"""
import os
import sqlite3
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))


def build():
    con = sqlite3.connect(":memory:")
    con.row_factory = sqlite3.Row
    con.executescript("""
      CREATE TABLE tools (id INTEGER PRIMARY KEY, name TEXT, category TEXT,
                          short_desc TEXT, description TEXT, status TEXT DEFAULT 'published');
      CREATE TABLE categories (name TEXT PRIMARY KEY, slug TEXT, icon TEXT,
                               tool_count INTEGER DEFAULT 0);
    """)
    rows = []

    def add(cat, items):
        for name, desc in items:
            rows.append((name, cat, desc, ""))

    # the rows that were the "AI Tools" catch-all, now sitting in the merged bucket
    add("Assistants & Agents", [
        ("Cursor", "AI code editor for developers"),
        ("Midjourney", "Generate images from text prompts"),
        ("Suno", "Make a song from a text prompt"),
        ("Jasper", "AI writing assistant for blog articles"),
        ("ElevenLabs", "Realistic voice generator and text to speech"),
        ("Zapier", "Automate workflows between apps"),
        ("QuickBooks", "Accounting and invoicing for small businesses"),
        ("Khanmigo", "AI tutor for students, learn maths"),
        ("Perplexity", "Answer engine and AI search"),
        ("Otter", "Transcribe meetings and take notes"),
        ("Luma", "Generate 3D models and renders"),
        ("Runway", "Video editing and generation"),
        ("Notion", "Notes, docs and project management"),
        ("DeepL", "Translate documents"),
        ("Phind", "Answer engine for developers"),
        ("Latitude", "Analytics dashboards and reports"),
    ])
    # genuine assistant tools, which must stay where they are
    add("Assistants & Agents", [
        ("Poe", "Chatbot that answers questions across several models"),
        ("Character.AI", "Chat with AI companions"),
    ])
    add("Design & Art", [("Ideogram", "Image generation from text")])
    add("Coding & Dev", [("Codeium", "Code completion for developers")])
    add("Voice & Sound", [("Murf", "Voice over generator")])
    add("Writing & Content", [("Grammarly", "Grammar checking for writing")])
    add("Productivity", [("Reclaim", "Task scheduling for teams")])
    add("Health", [("Ada Health", "Health symptom checker")])

    for i, (n, c, d, extra) in enumerate(rows):
        con.execute("INSERT INTO tools (id,name,category,short_desc,description) VALUES (?,?,?,?,?)",
                    (i + 1, n, c, d, extra))
    for (c,) in con.execute("SELECT DISTINCT category FROM tools"):
        con.execute("INSERT INTO categories (name,slug,icon,tool_count) VALUES (?,?,?,0)",
                    (c, c.lower(), "x"))
    return con


def run(con):
    import fix_categories as fc

    def query(sql, params=None, tries=1):
        cur = con.execute(sql, params or [])
        con.commit()
        return [dict(r) for r in cur.fetchall()] if cur.description else []

    fc.query = query
    fc.APPLY = True
    return fc.main()


def dist(con):
    rows = con.execute("SELECT category, COUNT(*) n FROM tools GROUP BY category ORDER BY n DESC").fetchall()
    total = sum(r[1] for r in rows) or 1
    return rows, total


def main():
    con = build()
    before, total = dist(con)
    print("  before")
    for c, n in before:
        print(f"    {n:>3}  {c}")

    run(con)

    after, total = dist(con)
    print("\n  after")
    for c, n in after:
        print(f"    {n:>3}  {100*n/total:>4.0f}%  {c}")

    biggest, n = after[0]
    drained = dict(after).get("Assistants & Agents", 0)
    checks = [
        ("the merged bucket no longer dominates", 100 * n / total < 25),
        ("the catch-all name is gone", "AI Tools" not in dict(after)),
        ("genuine assistants were not scattered", drained >= 2),
        ("every row still has a category", sum(x[1] for x in after) == total),
    ]
    print()
    for label, ok in checks:
        print(f"  {'PASS' if ok else 'FAIL'}  {label}")
    ok = all(c[1] for c in checks)
    print(f"\n  RESULT: {'PASS' if ok else 'FAIL'}")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
