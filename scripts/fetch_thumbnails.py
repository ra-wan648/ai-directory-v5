#!/usr/bin/env python3
"""Fetch og:image thumbnails for news/blogs/prompts from their source URLs."""
import os, re, json, subprocess, requests
from urllib.parse import urljoin, urlparse

DB = "ai-directory-db"
TIMEOUT = 15

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

def get_og_image(url):
    """Fetch og:image from URL."""
    try:
        r = requests.get(url, timeout=TIMEOUT, headers={
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
        })
        if r.status_code != 200:
            return None
        html = r.text[:50000]  # First 50KB should have meta tags
        
        # Try og:image
        m = re.search(r'<meta[^>]+property=["\']og:image["\'][^>]+content=["\']([^"\']+)["\']', html, re.I)
        if not m:
            m = re.search(r'<meta[^>]+content=["\']([^"\']+)["\'][^>]+property=["\']og:image["\']', html, re.I)
        if m:
            img = m.group(1)
            # Make absolute
            if img.startswith('//'):
                img = 'https:' + img
            elif img.startswith('/'):
                img = urljoin(url, img)
            return img
        
        # Try twitter:image as fallback
        m = re.search(r'<meta[^>]+name=["\']twitter:image["\'][^>]+content=["\']([^"\']+)["\']', html, re.I)
        if m:
            return m.group(1)
        return None
    except:
        return None

def main():
    # Add thumbnail_url columns if not exist
    for table in ['blogs', 'news', 'prompts']:
        try:
            run_sql(f"ALTER TABLE {table} ADD COLUMN thumbnail_url TEXT")
            print(f"Added thumbnail_url to {table}")
        except:
            pass  # Column exists
    
    # Process blogs/news
    for table in ['blogs', 'news']:
        items = run_sql(
            f"SELECT id, url FROM {table} WHERE (thumbnail_url IS NULL OR thumbnail_url='') "
            f"AND url IS NOT NULL AND url != '' LIMIT 100"
        )
        print(f"{table}: {len(items)} items need thumbnails")
        done = 0
        for item in items:
            img = get_og_image(item['url'])
            if img:
                # Escape single quotes
                img_esc = img.replace("'", "''")
                run_sql(f"UPDATE {table} SET thumbnail_url='{img_esc}' WHERE id={item['id']}")
                done += 1
        print(f"  {done} thumbnails fetched for {table}")
    
    # Prompts: keyword-based (no source URLs with images typically)
    print("Prompts use keyword-based SVG thumbnails (frontend)")

if __name__ == "__main__":
    main()
