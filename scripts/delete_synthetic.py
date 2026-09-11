#!/usr/bin/env python3
"""
Delete Synthetic AI Tools
Removes low-quality synthetic tools from D1 (description pattern
'%AI tool for%' and other auto-generated templates) that were seeded
by bulk generators. Keeps only legitimately scraped/curated entries.
"""

import os
import json
import subprocess
from datetime import datetime

CF_API_TOKEN = os.environ.get('CF_API_TOKEN', '')
CF_ACCOUNT_ID = os.environ.get('CLOUDFLARE_ACCOUNT_ID', '')
CF_D1_ID = 'ff26faf5-3c7c-445a-a249-6c96fedddfdc'
DB_NAME = 'ai-directory-db'


def log(msg):
    print(f"[{datetime.now().strftime('%H:%M:%S')}] {msg}", flush=True)


def d1_env():
    env = os.environ.copy()
    env['CF_API_TOKEN'] = CF_API_TOKEN
    env['CLOUDFLARE_API_TOKEN'] = CF_API_TOKEN
    env['CLOUDFLARE_ACCOUNT_ID'] = CF_ACCOUNT_ID
    return env


def d1_exec(sql):
    env = d1_env()
    r = subprocess.run(
        ['wrangler', 'd1', 'execute', DB_NAME, '--remote', '--json', '--command', sql],
        capture_output=True, text=True, timeout=120, env=env
    )
    try:
        return json.loads(r.stdout)
    except Exception:
        return None


def get_count(sql):
    data = d1_exec(sql)
    try:
        if isinstance(data, list) and data and data[0].get('results'):
            return data[0]['results'][0]['c']
    except Exception:
        pass
    return 0


def get_total():
    return get_count("SELECT COUNT(*) as c FROM tools WHERE status='published'")


def get_synthetic_count():
    return get_count(
        "SELECT COUNT(*) as c FROM tools WHERE status='published' AND "
        "description LIKE '%AI tool for%'"
    )


def delete_synthetic():
    log("Deleting synthetic tools (description LIKE '%AI tool for%')...")
    before = get_total()
    syn = get_synthetic_count()
    log(f"Published before: {before}, synthetic matched: {syn}")

    # Delete in batches to avoid huge single transactions
    total_deleted = 0
    while True:
        sql = (
            "DELETE FROM tools WHERE id IN ("
            "SELECT id FROM tools WHERE status='published' AND "
            "description LIKE '%AI tool for%' LIMIT 100"
            ")"
        )
        data = d1_exec(sql)
        try:
            meta = data[0].get('meta', {})
            changes = meta.get('changes', 0)
        except Exception:
            changes = 0
        total_deleted += changes
        if changes == 0:
            break

    after = get_total()
    log(f"Deleted {total_deleted} synthetic tools. Published: {before} -> {after}")
    return total_deleted


def main():
    log("=" * 50)
    log("Delete Synthetic Tools")
    log("=" * 50)
    deleted = delete_synthetic()
    print(f"Total deleted: {deleted}")
    print(f"Final published count: {get_total()}")


if __name__ == '__main__':
    main()
