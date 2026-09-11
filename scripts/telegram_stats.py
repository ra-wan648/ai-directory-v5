#!/usr/bin/env python3
"""
Telegram Pipeline Stats
Sends a daily summary of the AI directory pipeline to Telegram admin:
published count, source breakdown, and recent additions.
"""

import os
import json
import subprocess
from datetime import datetime, timedelta

import requests

CF_API_TOKEN = os.environ.get('CF_API_TOKEN', '')
CF_ACCOUNT_ID = os.environ.get('CLOUDFLARE_ACCOUNT_ID', '')
CF_D1_ID = 'ff26faf5-3c7c-445a-a249-6c96fedddfdc'
DB_NAME = 'ai-directory-db'

TELEGRAM_BOT_TOKEN = os.environ.get('TELEGRAM_BOT_TOKEN', '')
ADMIN_TELEGRAM_ID = os.environ.get('ADMIN_TELEGRAM_ID', '')


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
        capture_output=True, text=True, timeout=60, env=env
    )
    try:
        return json.loads(r.stdout)
    except Exception:
        return None


def query_rows(sql):
    data = d1_exec(sql)
    try:
        if isinstance(data, list) and data and data[0].get('results'):
            return data[0]['results']
    except Exception:
        pass
    return []


def get_stats():
    total = query_rows("SELECT COUNT(*) as c FROM tools WHERE status='published'")
    total_count = total[0]['c'] if total else 0

    by_tag = query_rows(
        "SELECT tags, COUNT(*) as c FROM tools WHERE status='published' "
        "GROUP BY tags ORDER BY c DESC LIMIT 10"
    )
    by_category = query_rows(
        "SELECT category, COUNT(*) as c FROM tools WHERE status='published' "
        "GROUP BY category ORDER BY c DESC LIMIT 10"
    )
    recent = query_rows(
        "SELECT name, category, created_at FROM tools WHERE status='published' "
        "ORDER BY created_at DESC LIMIT 8"
    )
    return total_count, by_tag, by_category, recent


def send_telegram(text):
    if not TELEGRAM_BOT_TOKEN or not ADMIN_TELEGRAM_ID:
        log("  SKIP: TELEGRAM_BOT_TOKEN/ADMIN_TELEGRAM_ID not set")
        return
    url = f"https://api.telegram.org/bot{TELEGRAM_BOT_TOKEN}/sendMessage"
    try:
        r = requests.post(url, json={
            'chat_id': ADMIN_TELEGRAM_ID,
            'text': text,
            'parse_mode': 'HTML',
        }, timeout=20)
        if r.status_code == 200:
            log("  Telegram message sent")
        else:
            log(f"  Telegram error {r.status_code}: {r.text[:150]}")
    except Exception as e:
        log(f"  Telegram error: {e}")


def main():
    log("=" * 50)
    log("Telegram Pipeline Stats")
    log("=" * 50)

    total, by_tag, by_category, recent = get_stats()

    lines = [
        "AI Directory — Daily Pipeline Report",
        f"Date: {datetime.utcnow().strftime('%Y-%m-%d %H:%M UTC')}",
        "",
        f"Published tools: <b>{total}</b>",
        "",
        "Top sources:",
    ]
    for row in by_tag[:8]:
        tag = row.get('tags') or 'untagged'
        lines.append(f"  • {tag}: {row['c']}")
    lines.append("")
    lines.append("Top categories:")
    for row in by_category[:8]:
        cat = row.get('category') or 'uncategorized'
        lines.append(f"  • {cat}: {row['c']}")
    lines.append("")
    lines.append("Latest additions:")
    for row in recent:
        lines.append(f"  • {row.get('name', '?')} ({row.get('category', '?')})")

    send_telegram("\n".join(lines))
    log(f"  Published: {total}")


if __name__ == '__main__':
    main()
