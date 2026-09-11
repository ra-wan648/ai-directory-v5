#!/usr/bin/env python3
import sys, os, time, json
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import requests

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from scrapers import (
    scrape_toolify, scrape_topaitools, scrape_toolfk,
    scrape_hackernews, scrape_trendshift, scrape_aixploria,
    scrape_insidr, scrape_allthingsai, scrape_futuretools
)
from bulk_import import (
    flask_get, flask_post, api_bulk_insert, api_add_tool,
    is_duplicate, load_progress, save_progress, FLASK_URL, HEADERS
)

PROGRESS_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "bulk_progress.json")

def run(name, fn, max_pages):
    """Run a scraper, return list of tools."""
    t0 = time.time()
    try:
        results = fn(max_pages)
    except Exception as e:
        print(f"  [ERROR] {name}: {e}")
        return []
    dt = time.time() - t0
    print(f"  -> {len(results)} items from {name} ({dt:.1f}s)")
    return results

def main():
    # Phase 1: dedup against DB
    print("Loading existing tools for dedup...")
    existing = flask_get("/api/search-all")
    existing_urls = {t.get('url', '') for t in existing.get('tools', [])}
    existing_slugs = {t.get('slug', '') for t in existing.get('tools', [])}
    print(f"  Existing: {len(existing_urls)}")

    # Phase 2: scrape each source
    print("\nScraping sources (5 pages each)...")
    all_tools = []
    all_tools += run("toolify",     scrape_toolify,     15)
    all_tools += run("topaitools",  scrape_topaitools,   5)
    all_tools += run("toolfk",      scrape_toolfk,       5)
    all_tools += run("futuretools", scrape_futuretools,  5)
    all_tools += run("aixploria",   scrape_aixploria,    5)
    all_tools += run("allthingsai", scrape_allthingsai,  5)
    all_tools += run("insidr",      scrape_insidr,       5)
    all_tools += run("trendshift",  scrape_trendshift,   3)
    all_tools += run("hackernews",  scrape_hackernews,   2)

    print(f"\nRaw total: {len(all_tools)}")

    # Phase 3: dedup by URL
    seen = set()
    unique = []
    for t in all_tools:
        url = (t.get('url') or '').strip()
        slug = (t.get('slug') or '').strip()
        key = url
        if not key or key in seen:
            continue
        seen.add(key)
        unique.append(t)
    print(f"After URL dedup: {len(unique)}")

    # Phase 4: filter against DB
    to_insert = []
    for t in unique:
        url = t.get('url', '')
        slug = t.get('slug', '')
        if url in existing_urls or slug in existing_slugs:
            continue
        to_insert.append(t)
        existing_urls.add(url)
        existing_slugs.add(slug)
    print(f"New to insert: {len(to_insert)}")

    if not to_insert:
        print("Nothing new to insert.")
        return

    # Phase 5: bulk insert in batches of 25
    print("\nInserting to DB...")
    BATCH = 25
    total_inserted = 0
    total_skipped = 0
    for i in range(0, len(to_insert), BATCH):
        batch = to_insert[i:i+BATCH]
        batch_num = i // BATCH + 1
        total_batches = (len(to_insert) + BATCH - 1) // BATCH
        print(f"  Batch {batch_num}/{total_batches} ({len(batch)} tools)...")
        r = api_bulk_insert(batch)
        if r:
            total_inserted += r.get('inserted', 0)
            total_skipped += r.get('skipped', 0)
            print(f"    -> inserted={r.get('inserted',0)} updated={r.get('updated',0)} skipped={r.get('skipped',0)}")
        else:
            # fallback one-by-one
            for tool in batch:
                rr = api_add_tool(tool)
                if rr and rr.get('status') == 'inserted':
                    total_inserted += 1
                elif rr and rr.get('status') == 'updated':
                    pass
                else:
                    total_skipped += 1
                time.sleep(0.2)
        time.sleep(0.5)

    print(f"\n{'='*50}")
    print(f"Inserted: {total_inserted}, Skipped: {total_skipped}")
    total_in_db = len(existing.get('tools', [])) + total_inserted
    print(f"Total DB tools: {total_in_db}")
    if total_in_db >= 500:
        print("SUCCESS: 500+ tools seeded!")
    else:
        print(f"WARNING: Only {total_in_db} tools seeded (need 500+)")

if __name__ == "__main__":
    main()