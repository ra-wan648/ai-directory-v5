import json
import os
import re
import time
import sys
import requests

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

# Use Flask API instead of direct D1
FLASK_URL = os.environ.get('FLASK_URL', 'http://127.0.0.1:5173')
HEADERS = {"Content-Type": "application/json"}

PROGRESS_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "bulk_progress.json")


def load_progress():
    try:
        with open(PROGRESS_FILE) as f:
            return json.load(f)
    except Exception:
        return {}


def save_progress(p):
    with open(PROGRESS_FILE, 'w') as f:
        json.dump(p, f, indent=2)


def slugify(name):
    return re.sub(r'[^a-z0-9]+', '-', name.lower()).strip('-')


# ─── Flask API calls ───────────────────────────────────────────────

def flask_get(path, params=None, ttl=300):
    try:
        r = requests.get(f"{FLASK_URL}{path}", params=params, timeout=30)
        r.raise_for_status()
        return r.json()
    except Exception as e:
        print(f"[ERROR] GET {path}: {e}")
        return {}


def flask_post(path, payload, timeout=60):
    try:
        r = requests.post(f"{FLASK_URL}{path}", json=payload, headers=HEADERS, timeout=timeout)
        r.raise_for_status()
        return r.json()
    except Exception as e:
        print(f"[ERROR] POST {path}: {e}")
        return None


def api_search_all():
    """Get ALL existing tools from DB to check duplicates."""
    data = flask_get("/api/search-all")
    return data.get("tools", [])


def api_bulk_insert(tools_batch):
    """Insert/update tools via internal bulk-insert endpoint."""
    return flask_post("/api/internal/bulk-insert", {"tools": tools_batch})


def api_add_tool(tool):
    """Add a single tool."""
    return flask_post("/api/internal/add-tool", tool)


# ─── Dedup helpers ─────────────────────────────────────────────────

def is_duplicate(tool, existing_tools):
    slug = tool.get('slug', '')
    url = tool.get('url', '')
    for et in existing_tools:
        if et.get('slug') == slug or (url and et.get('url') == url):
            return True
    return False


# ─── Import config ─────────────────────────────────────────────────

try:
    from scrapers import scrape_all, build_tool, slugify as scrapers_slugify
    HAS_SCRAPERS = True
except Exception as e:
    print(f"[WARN] scrapers import failed: {e}")
    HAS_SCRAPERS = False


# ─── Main import ────────────────────────────────────────────────────

def run_bulk():
    from scrapers import scrape_all

    progress = load_progress()

    print("=" * 60)
    print("BULK IMPORT — 500+ tools target")
    print(f"Flask API: {FLASK_URL}")
    print("=" * 60)

    # Phase 1: Load existing tools for dedup
    print("\n[PHASE 1] Loading existing tools for dedup...")
    existing = api_search_all()
    print(f"  Existing tools in DB: {len(existing)}")
    existing_urls = {t.get('url', '') for t in existing}
    existing_slugs = {t.get('slug', '') for t in existing}
    time.sleep(0.5)

    # Phase 2: Scrape all sources
    print("\n[PHASE 2] Scraping sources...")
    raw_tools = scrape_all(max_pages_normal=50, max_pages_bulk=50)
    print(f"\n  Raw scraped: {len(raw_tools)}")

    # Phase 3: Dedup and enrich
    print("\n[PHASE 3] Deduplicating...")
    unique = []
    seen = set()
    for t in raw_tools:
        url = (t.get('url') or '').strip()
        slug = (t.get('slug') or '').strip()
        if not url or not slug:
            continue
        key = url
        if key not in seen:
            seen.add(key)
            unique.append(t)

    print(f"  Unique after URL dedup: {len(unique)}")

    # Phase 4: Filter against existing DB
    print("\n[PHASE 4] Filtering against DB...")
    to_insert = []
    for t in unique:
        url = t.get('url', '')
        slug = t.get('slug', '')
        if url in existing_urls or slug in existing_slugs:
            continue
        to_insert.append(t)
        existing_urls.add(url)
        existing_slugs.add(slug)

    print(f"  New tools to insert: {len(to_insert)}")

    if not to_insert:
        print("\n[SKIP] No new tools to insert. Scrapers may have returned already-seen URLs.")
        return

    # Phase 5: Bulk insert in batches of 25
    print("\n[PHASE 5] Inserting to D1...")
    BATCH = 25
    total_inserted = 0
    total_updated = 0
    total_skipped = 0
    total_errors = 0

    for i in range(0, len(to_insert), BATCH):
        batch = to_insert[i:i+BATCH]
        batch_num = i // BATCH + 1
        total_batches = (len(to_insert) + BATCH - 1) // BATCH
        print(f"  Batch {batch_num}/{total_batches} ({len(batch)} tools)...")

        result = api_bulk_insert(batch)
        if result:
            total_inserted += result.get('inserted', 0)
            total_updated += result.get('updated', 0)
            print(f"    -> inserted={result.get('inserted',0)} updated={result.get('updated',0)} skipped={result.get('skipped',0)}")
        else:
            # Try one-by-one if bulk fails
            print("    -> bulk failed, trying one-by-one...")
            for tool in batch:
                r = api_add_tool(tool)
                if r and r.get('status') == 'inserted':
                    total_inserted += 1
                elif r and r.get('status') == 'updated':
                    total_updated += 1
                else:
                    total_skipped += 1
                time.sleep(0.3)
        time.sleep(1)

    print(f"\n{'='*60}")
    print("BULK IMPORT COMPLETE")
    print(f"{'='*60}")
    print(f"  Inserted: {total_inserted}")
    print(f"  Updated:  {total_updated}")
    print(f"  Skipped:  {total_skipped}")
    print(f"  Total DB: {len(existing) + total_inserted}")


if __name__ == "__main__":
    run_bulk()
