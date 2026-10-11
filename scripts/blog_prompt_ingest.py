#!/usr/bin/env python3
"""Ingest blogs/prompts from competitor sources, AI-rewrite via Manifest, insert to D1.

Sources (title/summary/link only - AI rewrites into original content):
  Blogs: toolify.ai/blog, futurepedia.io/blog
  Prompts: flowgpt.com (trending), prompthero.com (featured)

Usage: python scripts/blog_prompt_ingest.py [--blogs N] [--prompts N]
"""
import os, sys, re, json, subprocess, requests
from urllib.parse import urljoin

DB = "ai-directory-db"
TIMEOUT = 30

# Competitor sources (HTML scraping - titles/summaries/links only)
BLOG_SOURCES = [
    {"name": "toolify-blog", "url": "https://www.toolify.ai/blog", "type": "blog"},
    {"name": "futurepedia-blog", "url": "https://www.futurepedia.io/blog", "type": "blog"},
]
PROMPT_SOURCES = [
    {"name": "flowgpt", "url": "https://flowgpt.com/trending", "type": "prompt"},
]

def d1_env():
    env = os.environ.copy()
    env["CLOUDFLARE_API_TOKEN"] = os.environ.get("CF_API_TOKEN") or os.environ.get("CLOUDFLARE_API_TOKEN", "")
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

def get_manifest_key():
    """Get Manifest key from D1 (dashboard) or env."""
    key = os.environ.get("MANIFEST_API_KEY", "")
    if key:
        return key, os.environ.get("MANIFEST_BASE_URL", "https://app.manifest.build/v1/responses")
    try:
        rows = run_sql("SELECT api_key, base_url FROM manifest_endpoints WHERE enabled=1 ORDER BY id LIMIT 1")
        if rows and rows[0].get("api_key"):
            base = (rows[0].get("base_url") or "https://app.manifest.build/v1").rstrip("/") + "/responses"
            return rows[0]["api_key"], base
    except:
        pass
    return "", ""

def ai_rewrite(kind, title, summary, source_url):
    """Use Manifest to rewrite into original content."""
    key, base_url = get_manifest_key()
    if not key:
        print("  No Manifest key, skipping AI rewrite")
        return None
    if kind == "blog":
        prompt = (
            f"You are a tech blog writer. Write an ORIGINAL blog post inspired by this (do NOT copy):\n"
            f"Title: {title}\nSummary: {summary[:500]}\nSource: {source_url}\n\n"
            f"Return ONLY valid JSON: {{\"title\": \"engaging SEO title under 60 chars\", "
            f"\"excerpt\": \"2-sentence hook\", \"content\": \"300-400 word original article in markdown\"}}"
        )
    else:
        prompt = (
            f"You are a prompt engineer. Create an ORIGINAL AI prompt inspired by this (do NOT copy):\n"
            f"Title: {title}\nDescription: {summary[:300]}\n\n"
            f"Return ONLY valid JSON: {{\"title\": \"prompt title under 60 chars\", "
            f"\"description\": \"what this prompt does (1-2 sentences)\", "
            f"\"prompt_text\": \"the full prompt text (original, detailed)\"}}"
        )
    try:
        r = requests.post(base_url, headers={
            "Authorization": f"Bearer {key}", "Content-Type": "application/json",
        }, json={"model": "auto", "input": prompt, "store": False}, timeout=90)
        if r.status_code != 200:
            print(f"  Manifest API {r.status_code}")
            return None
        d = r.json()
        text = ""
        for item in (d.get("output") or []):
            if item.get("type") == "message":
                for c in (item.get("content") or []):
                    if c.get("type") == "output_text":
                        text += c.get("text", "")
        text = text.strip()
        text = re.sub(r'^```\w*\n?', '', text)
        text = re.sub(r'\n?```$', '', text)
        return json.loads(text)
    except Exception as e:
        print(f"  AI rewrite failed: {e}")
        return None

def scrape_listings(source):
    """Scrape title/summary/link from a source page (basic HTML parsing)."""
    try:
        r = requests.get(source["url"], headers={
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"
        }, timeout=TIMEOUT)
        if r.status_code != 200:
            print(f"  {source['name']}: HTTP {r.status_code}")
            return []
        html = r.text
        items = []
        # Generic: find article cards with links
        for m in re.finditer(r'<a[^>]+href="([^"]+)"[^>]*>(.*?)</a>', html, re.S):
            href, inner = m.groups()
            # Extract text from inner HTML
            text = re.sub(r'<[^>]+>', ' ', inner).strip()
            text = re.sub(r'\s+', ' ', text)
            if len(text) > 20 and len(text) < 200:
                full_url = urljoin(source["url"], href)
                # Skip nav links
                if any(x in href for x in ['#', 'javascript', '/tag/', '/category/']):
                    continue
                items.append({"title": text[:150], "url": full_url, "summary": ""})
                if len(items) >= 10:
                    break
        print(f"  {source['name']}: {len(items)} listings found")
        return items
    except Exception as e:
        print(f"  {source['name']}: {e}")
        return []

def slugify(s):
    s = re.sub(r'[^a-z0-9]+', '-', s.lower()).strip('-')
    return s[:80] or "post"

def esc(s):
    return (s or "").replace("'", "''")

def main():
    import argparse
    ap = argparse.ArgumentParser()
    ap.add_argument("--blogs", type=int, default=5)
    ap.add_argument("--prompts", type=int, default=5)
    args = ap.parse_args()

    # Blogs
    blog_count = 0
    for src in BLOG_SOURCES:
        if blog_count >= args.blogs:
            break
        for item in scrape_listings(src):
            if blog_count >= args.blogs:
                break
            # Check duplicate
            slug = slugify(item["title"])
            exists = run_sql(f"SELECT id FROM blogs WHERE slug='{esc(slug)}' LIMIT 1")
            if exists:
                continue
            rewritten = ai_rewrite("blog", item["title"], item["summary"], item["url"])
            if not rewritten:
                continue
            run_sql(
                f"INSERT INTO blogs (title, slug, content, meta_description, category, status) VALUES ("
                f"'{esc(rewritten.get('title', item['title'])[:200])}', '{esc(slug)}', "
                f"'{esc(rewritten.get('content', ''))[:10000]}', "
                f"'{esc(rewritten.get('excerpt', ''))[:155]}', 'ai-news', 'published')"
            )
            blog_count += 1
            print(f"  ✓ Blog: {rewritten.get('title', '')[:50]}")
    print(f"Blogs ingested: {blog_count}")

    # Prompts
    prompt_count = 0
    for src in PROMPT_SOURCES:
        if prompt_count >= args.prompts:
            break
        for item in scrape_listings(src):
            if prompt_count >= args.prompts:
                break
            slug = slugify(item["title"])
            exists = run_sql(f"SELECT id FROM prompts WHERE slug='{esc(slug)}' LIMIT 1")
            if exists:
                continue
            rewritten = ai_rewrite("prompt", item["title"], item["summary"], item["url"])
            if not rewritten:
                continue
            run_sql(
                f"INSERT INTO prompts (title, slug, prompt_text, description, status) VALUES ("
                f"'{esc(rewritten.get('title', item['title'])[:200])}', '{esc(slug)}', "
                f"'{esc(rewritten.get('prompt_text', ''))[:5000]}', "
                f"'{esc(rewritten.get('description', ''))[:500]}', 'published')"
            )
            prompt_count += 1
            print(f"  ✓ Prompt: {rewritten.get('title', '')[:50]}")
    print(f"Prompts ingested: {prompt_count}")

if __name__ == "__main__":
    main()
