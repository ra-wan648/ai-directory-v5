#!/usr/bin/env python3
"""
Manifest (LLM router) endpoint router with quota-based rollover.

Endpoint sources, in priority order:
  1. D1 `manifest_endpoints` table (dashboard-managed: label, base_url,
     api_key, monthly_limit, used_this_month, enabled)
  2. Numbered env vars: MANIFEST_1_URL / MANIFEST_1_KEY / MANIFEST_1_LIMIT ...
  3. Legacy single env pair: MANIFEST_BASE_URL + MANIFEST_API_KEY

Selection: among enabled endpoints, pick the one with the most remaining
monthly quota. After each successful call, bump used_this_month in D1 so
concurrent/sequential calls roll over correctly.
"""

import os
import requests

from config import load_env

load_env()

CF_ACCOUNT = os.environ.get('CF_ACCOUNT_ID', '')
CF_TOKEN = os.environ.get('CF_API_TOKEN', '')
CF_D1_ID = os.environ.get('CF_D1_ID', '')

D1_URL = f"https://api.cloudflare.com/client/v4/accounts/{CF_ACCOUNT}/d1/database/{CF_D1_ID}/query"
CF_HEADERS = {"Authorization": f"Bearer {CF_TOKEN}", "Content-Type": "application/json"}


def _d1(sql, params=None):
    if not (CF_ACCOUNT and CF_TOKEN and CF_D1_ID):
        return None
    try:
        r = requests.post(D1_URL, headers=CF_HEADERS,
                          json={"sql": sql, "params": params or []}, timeout=30)
        d = r.json()
        return d["result"][0]["results"]
    except Exception as e:
        print(f"[manifest-router] D1 read failed: {e}")
        return None


def _env_endpoints():
    """Numbered MANIFEST_N_* env vars."""
    eps = []
    i = 1
    while True:
        url = os.environ.get(f'MANIFEST_{i}_URL', '').strip()
        key = os.environ.get(f'MANIFEST_{i}_KEY', '').strip()
        if not url or not key:
            break
        try:
            limit = int(os.environ.get(f'MANIFEST_{i}_LIMIT', '1000'))
        except ValueError:
            limit = 1000
        eps.append({
            'id': f'env-{i}',
            'label': os.environ.get(f'MANIFEST_{i}_LABEL', f'env-{i}'),
            'base_url': url.rstrip('/'),
            'api_key': key,
            'monthly_limit': limit,
            'used_this_month': 0,
            'source': 'env',
        })
        i += 1
        if i > 20:
            break
    return eps


def list_endpoints():
    """All enabled endpoints with remaining quota, best-first."""
    eps = []
    rows = _d1(
        "SELECT id, label, base_url, api_key, monthly_limit, used_this_month "
        "FROM manifest_endpoints WHERE enabled=1 ORDER BY id")
    if rows:
        for r in rows:
            eps.append({
                'id': r['id'],
                'label': r.get('label') or f"d1-{r['id']}",
                'base_url': (r.get('base_url') or 'https://app.manifest.build/v1').rstrip('/'),
                'api_key': r.get('api_key') or '',
                'monthly_limit': int(r.get('monthly_limit') or 1000),
                'used_this_month': int(r.get('used_this_month') or 0),
                'source': 'd1',
            })
    eps.extend(_env_endpoints())
    # Legacy single pair as last resort
    legacy_url = os.environ.get('MANIFEST_BASE_URL', '').strip()
    legacy_key = os.environ.get('MANIFEST_API_KEY', '').strip()
    if legacy_url and legacy_key and not eps:
        eps.append({
            'id': 'legacy', 'label': 'legacy',
            'base_url': legacy_url.rstrip('/'), 'api_key': legacy_key,
            'monthly_limit': 10 ** 9, 'used_this_month': 0, 'source': 'legacy',
        })
    # Only endpoints with remaining quota, most headroom first
    live = [e for e in eps if e['api_key'] and e['used_this_month'] < e['monthly_limit']]
    live.sort(key=lambda e: e['monthly_limit'] - e['used_this_month'], reverse=True)
    return live


def pick_endpoint():
    eps = list_endpoints()
    if not eps:
        print("[manifest-router] WARNING: no Manifest endpoint with remaining quota!")
        return None
    ep = eps[0]
    print(f"[manifest-router] using '{ep['label']}' "
          f"({ep['used_this_month']}/{ep['monthly_limit']} used)")
    return ep


def record_use(endpoint):
    """Bump used_this_month after a call (D1 endpoints only)."""
    if not endpoint or endpoint.get('source') != 'd1':
        return
    try:
        requests.post(D1_URL, headers=CF_HEADERS, json={
            "sql": "UPDATE manifest_endpoints SET used_this_month = used_this_month + 1 WHERE id = ?",
            "params": [endpoint['id']],
        }, timeout=30)
    except Exception as e:
        print(f"[manifest-router] usage bump failed: {e}")


def reset_monthly_counters():
    """Call on the 1st of each month (or when reset_day hits)."""
    if _d1("UPDATE manifest_endpoints SET used_this_month = 0 "
           "WHERE reset_day = CAST(strftime('%d', 'now') AS INTEGER)") is None:
        print("[manifest-router] counter reset skipped (no D1)")


if __name__ == '__main__':
    for e in list_endpoints():
        print(e['label'], e['base_url'],
              f"{e['used_this_month']}/{e['monthly_limit']}", f"[{e['source']}]")
