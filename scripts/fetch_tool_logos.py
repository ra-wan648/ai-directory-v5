#!/usr/bin/env python3
"""Fetch individual tool logos from their websites (higher quality than favicon)."""
import os, re, json, subprocess, requests
from urllib.parse import urljoin, urlparse

DB = "ai-directory-db"
TIMEOUT = 12

def d1_env():
    env = os.environ.copy()
    env["CLOUDFLARE_API_TOKEN"] = os.environ.get("CF_API_TOKEN") or ""
    env["CLOUDFLARE_ACCOUNT_ID"] = os.environ.get("CLOUDFLARE_ACCOUNT_ID", "")
    return env

def run_sql(sql, timeout=120):
    r = subprocess.run(
        ["wrangler", "d1", "execute", DB, "--remote", "--json", "--command", sql],
        capture_output=True, text=True, timeout=timeout, env=d1_env(),
    )
    if r.returncode != 0:
        return []
    try:
        data = json.loads(r.stdout)
        return data[0].get("results", []) if isinstance(data, list) else []
    except:
        return []

def get_best_logo(url):
    """Try apple-touch-icon, og:image, then favicon."""
    try:
        parsed = urlparse(url)
        base = f"{parsed.scheme}://{parsed.netloc}"
        
        # Try apple-touch-icon first (usually 180x180)
        for icon_path in ['/apple-touch-icon.png', '/apple-touch-icon-precomposed.png']:
            try:
                r = requests.head(base + icon_path, timeout=5, allow_redirects=True)
                if r.status_code == 200 and 'image' in r.headers.get('content-type', ''):
                    return base + icon_path
            except:
                pass
        
        # Try og:image from homepage
        try:
            r = requests.get(url, timeout=TIMEOUT, headers={
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
            })
            if r.status_code == 200:
                html = r.text[:80000]
                # og:image
                m = re.search(r'<meta[^>]+property=["\']og:image["\'][^>]+content=["\']([^"\']+)["\']', html, re.I)
                if not m:
                    m = re.search(r'<meta[^>]+content=["\']([^"\']+)["\'][^>]+property=["\']og:image["\']', html, re.I)
                if m:
                    img = m.group(1)
                    if img.startswith('//'): img = 'https:' + img
                    elif img.startswith('/'): img = urljoin(url, img)
                    # Skip tiny tracking pixels
                    if 'pixel' not in img.lower() and 'track' not in img.lower():
                        return img
        except:
            pass
        
        # Fallback to Google favicon (larger size)
        domain = parsed.netloc
        return f"https://www.google.com/s2/favicons?domain={domain}&sz=128"
    except:
        return None

def main():
    # Get Product Hunt and HuggingFace tools
    tools = run_sql(
        "SELECT id, name, url FROM tools WHERE status='published' "
        "AND (source='producthunt' OR source='huggingface') "
        "AND url IS NOT NULL AND url != '' LIMIT 500"
    )
    print(f"Found {len(tools)} tools")
    
    done = 0
    for t in tools:
        logo = get_best_logo(t['url'])
        if logo:
            logo_esc = logo.replace("'", "''")
            run_sql(f"UPDATE tools SET logo_url='{logo_esc}', logo_type='site' WHERE id={t['id']}")
            done += 1
            if done % 20 == 0:
                print(f"  {done} done")
    
    print(f"COMPLETE: {done} logos updated")

if __name__ == "__main__":
    main()
