#!/usr/bin/env python3
"""
Comprehensive AI Tools Scraper — Playwright + Selenium fallback
Scrapes 12 sources, inserts into remote Cloudflare D1 via wrangler CLI.
Target: 3000+ tools in D1.
"""

import os
import re
import sys
import time
import json
import random
import subprocess
import hashlib
from urllib.parse import urlparse, quote
from datetime import datetime

import requests
from bs4 import BeautifulSoup

# ─────────────────────────────────────────────
# CONFIG
# ─────────────────────────────────────────────
CF_API_TOKEN = os.environ.get('CF_API_TOKEN', '')
CF_ACCOUNT_ID = os.environ.get('CLOUDFLARE_ACCOUNT_ID', '')
CF_D1_ID = 'ff26faf5-3c7c-445a-a249-6c96fedddfdc'
DB_NAME = 'ai-directory-db'

PROGRESS_FILE = '/tmp/playwright_scraper_progress.json'
DEDUP_FILE = '/tmp/playwright_scraper_dedup.json'

# ─────────────────────────────────────────────
# UTILITIES
# ─────────────────────────────────────────────

def log(msg):
    print(f"[{datetime.now().strftime('%H:%M:%S')}] {msg}")

def random_delay(min_s=2, max_s=4):
    time.sleep(random.uniform(min_s, max_s))

def slugify(text):
    text = re.sub(r'[^\w\s-]', '', text).strip().lower()
    text = re.sub(r'[\s]+', '-', text)
    return text[:80]

def get_logo_url(url):
    domain = urlparse(url).netloc
    return f"https://www.google.com/s2/favicons?domain={domain}&sz=64"

def save_progress(data):
    with open(PROGRESS_FILE, 'w') as f:
        json.dump(data, f)

def load_progress():
    if os.path.exists(PROGRESS_FILE):
        try:
            with open(PROGRESS_FILE) as f:
                return json.load(f)
        except Exception:
            pass
    return {'tools_scraped': 0, 'tools_inserted': 0, 'sources_completed': []}

def dedupe_key(url):
    try:
        parsed = urlparse(url)
        return hashlib.md5(parsed.netloc.lower().encode() + parsed.path.encode()).hexdigest()
    except Exception:
        return hashlib.md5(url.encode()).hexdigest()

def load_dedup_set():
    if os.path.exists(DEDUP_FILE):
        try:
            with open(DEDUP_FILE) as f:
                return set(json.load(f))
        except Exception:
            pass
    return set()

def save_dedup_set(keys):
    with open(DEDUP_FILE, 'w') as f:
        json.dump(list(keys), f)

def parse_pricing(text):
    t = (text or '').lower()
    if 'free' in t and ('premium' in t or 'paid' in t or 'pro' in t):
        return 'freemium'
    if 'free' in t:
        return 'free'
    if 'paid' in t or 'premium' in t or 'pro' in t:
        return 'paid'
    if any(x in t for x in ['freemium', 'freemium']):
        return 'freemium'
    return 'free'

def category_from_text(text):
    t = (text or '').lower()
    if any(w in t for w in ['coding', 'dev', 'programming', 'code', 'developer']):
        return 'Coding'
    if any(w in t for w in ['image', 'photo', 'art', 'design']):
        return 'Image'
    if any(w in t for w in ['video', 'animation']):
        return 'Video'
    if any(w in t for w in ['audio', 'music', 'sound']):
        return 'Audio'
    if any(w in t for w in ['chat', 'conversat', 'assistant', 'llm']):
        return 'Chat'
    if any(w in t for w in ['research', 'search', 'academic']):
        return 'Research'
    if any(w in t for w in ['marketing', 'seo', 'social', 'advertis']):
        return 'Marketing'
    if any(w in t for w in ['finance', 'money', 'invest']):
        return 'Finance'
    if any(w in t for w in ['writing', 'copy', 'content']):
        return 'Writing'
    if any(w in t for w in ['education', 'learn', 'course', 'teach']):
        return 'Education'
    if any(w in t for w in ['automation', 'workflow', 'zapier']):
        return 'Automation'
    if any(w in t for w in ['analytics', 'data', 'insight']):
        return 'Analytics'
    if any(w in t for w in ['business', 'productivity', 'project']):
        return 'Business'
    return 'AI Tools'

def insert_into_d1(tools_batch):
    """Insert a batch of tools via wrangler CLI."""
    if not tools_batch:
        return 0, 0
    env = os.environ.copy()
    env['CF_API_TOKEN'] = CF_API_TOKEN
    env['CLOUDFLARE_API_TOKEN'] = CF_API_TOKEN
    env['CLOUDFLARE_ACCOUNT_ID'] = CF_ACCOUNT_ID
    inserted = 0
    skipped = 0
    for tool in tools_batch:
        name = tool['name'].replace("'", "''")
        slug = tool['slug']
        desc = (tool.get('description', '') or '')[:2000].replace("'", "''")
        short_desc = (tool.get('short_desc', '') or '')[:255].replace("'", "''")
        category = (tool.get('category', '') or '').replace("'", "''")
        pricing = (tool.get('pricing', '') or '').replace("'", "''")
        url = tool['website_url'].replace("'", "''")
        logo = (tool.get('logo_url', '') or '').replace("'", "''")
        tags = (tool.get('tags', '') or '').replace("'", "''")
        created = datetime.utcnow().strftime('%Y-%m-%d %H:%M:%S')
        cmd = f'''INSERT INTO tools (name, slug, description, short_desc, category, pricing, url, logo_url, logo_type, tags, status, created_at) VALUES ('{name}', '{slug}', '{desc}', '{short_desc}', '{category}', '{pricing}', '{url}', '{logo}', 'favicon', '{tags}', 'published', '{created}') ON CONFLICT(slug) DO NOTHING'''
        r = subprocess.run(
            ['wrangler', 'd1', 'execute', DB_NAME, '--remote', '--command', cmd],
            capture_output=True, text=True, timeout=30, env=env
        )
        if r.returncode == 0 and '✘' not in r.stdout and 'ERROR' not in r.stdout and 'failed' not in r.stdout.lower():
            inserted += 1
        else:
            skipped += 1
    return inserted, skipped

def get_d1_count():
    env = os.environ.copy()
    env['CF_API_TOKEN'] = CF_API_TOKEN
    env['CLOUDFLARE_API_TOKEN'] = CF_API_TOKEN
    env['CLOUDFLARE_ACCOUNT_ID'] = CF_ACCOUNT_ID
    r = subprocess.run(
        ['wrangler', 'd1', 'execute', DB_NAME, '--remote',
         '--command', "SELECT COUNT(*) as c FROM tools WHERE status='published'"],
        capture_output=True, text=True, timeout=30, env=env
    )
    try:
        data = json.loads(r.stdout)
        if data.get('result'):
            return data['result'][0]['c']
    except Exception:
        pass
    return '?'

# ─────────────────────────────────────────────
# SOURCE 1: Toolify.ai
# ─────────────────────────────────────────────
def scrape_toolify(page=1, max_pages=15):
    from playwright.sync_api import sync_playwright
    tools = []
    method = 'unknown'
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        try:
            ctx = browser.new_context(viewport={'width': 1280, 'height': 800})
            page_obj = ctx.new_page()
            method = 'playwright'
            for pg in range(1, max_pages + 1):
                url = f"https://www.toolify.ai/ai-news?page={pg}"
                log(f"  Source 1 Toolify page {pg}/{max_pages}: {url}")
                try:
                    page_obj.goto(url, wait_until='domcontentloaded', timeout=30000)
                    random_delay(2, 4)
                    cards = page_obj.locator('a[href*="/ai-tool/"]').all()
                    for card in cards[:20]:
                        try:
                            href = card.get_attribute('href') or ''
                            name_el = card.locator('h3,h2,h4,.title,.name').first
                            name = name_el.inner_text()[:120].strip() if name_el else ''
                            desc_el = card.locator('.desc,.description,p').first
                            desc = desc_el.inner_text()[:500].strip() if desc_el else ''
                            full_url = f"https://www.toolify.ai{href}" if href.startswith('/') else href
                            if not name or not full_url:
                                continue
                            tools.append({
                                'name': name,
                                'slug': slugify(name),
                                'description': desc,
                                'short_desc': desc[:200] if desc else name,
                                'category': category_from_text(name + ' ' + desc),
                                'pricing': 'free',
                                'website_url': full_url,
                                'logo_url': get_logo_url(full_url),
                                'tags': 'ai,toolify',
                            })
                        except Exception:
                            continue
                    if not cards:
                        log(f"    No cards found on page {pg}, stopping.")
                        break
                except Exception as e:
                    log(f"    Page {pg} error: {e}")
                    break
                random_delay(2, 4)
            browser.close()
        except Exception as e:
            log(f"  Playwright failed ({e}), trying Selenium...")
            browser = None
            tools = _scrape_toolify_selenium(tools)
            method = 'selenium'
    return tools, method

def _scrape_toolify_selenium(tools):
    try:
        import undetected_chromedriver as uc
        drv = uc.Chrome(headless=True, options=None)
        for pg in range(1, 16):
            url = f"https://www.toolify.ai/ai-news?page={pg}"
            log(f"  Source 1 Toolify (Selenium) page {pg}/15")
            try:
                drv.get(url)
                random_delay(2, 4)
                links = drv.find_elements('css selector', 'a[href*="/ai-tool/"]')
                for a in links[:20]:
                    try:
                        href = a.get_attribute('href')
                        name = a.find_element('css selector', 'h3,h2,h4,.title').text[:120].strip()
                        if name and href:
                            tools.append({
                                'name': name, 'slug': slugify(name),
                                'description': '', 'short_desc': name,
                                'category': 'AI Tools', 'pricing': 'free',
                                'website_url': href,
                                'logo_url': get_logo_url(href),
                                'tags': 'ai,toolify',
                            })
                    except Exception:
                        continue
            except Exception as e:
                log(f"    Error: {e}")
                break
        drv.quit()
    except Exception as e:
        log(f"  Selenium also failed: {e}")
    return tools

# ─────────────────────────────────────────────
# SOURCE 2: Futurepedia.io
# ─────────────────────────────────────────────
def scrape_futurepedia(page=1, max_pages=10):
    from playwright.sync_api import sync_playwright
    tools = []
    method = 'unknown'
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        try:
            ctx = browser.new_context(viewport={'width': 1280, 'height': 800})
            page_obj = ctx.new_page()
            method = 'playwright'
            for pg in range(1, max_pages + 1):
                url = f"https://www.futurepedia.io/ai-tools?page={pg}"
                log(f"  Source 2 Futurepedia page {pg}/{max_pages}: {url}")
                try:
                    page_obj.goto(url, wait_until='domcontentloaded', timeout=30000)
                    random_delay(3, 5)
                    # Scroll to trigger lazy load
                    for _ in range(3):
                        page_obj.evaluate("window.scrollBy(0, 800)")
                        random_delay(0.5, 1)
                    cards = page_obj.locator('a[href*="/ai-tools/"], .ai-tool-card, article').all()
                    for card in cards[:25]:
                        try:
                            href = card.get_attribute('href') or ''
                            name = card.locator('h2,h3,h4,.title').first.inner_text()[:120].strip()
                            desc_el = card.locator('p,.description').first
                            desc = desc_el.inner_text()[:500].strip() if desc_el else ''
                            if not name:
                                # Try getting from link text
                                lnk = card.locator('a').first
                                name = lnk.inner_text()[:120].strip() if lnk.count() else ''
                            if not name:
                                continue
                            full_url = f"https://www.futurepedia.io{href}" if href.startswith('/') else href
                            tools.append({
                                'name': name,
                                'slug': slugify(name),
                                'description': desc,
                                'short_desc': desc[:200] if desc else name,
                                'category': category_from_text(name + ' ' + desc),
                                'pricing': 'free',
                                'website_url': full_url,
                                'logo_url': get_logo_url(full_url),
                                'tags': 'ai,futurepedia',
                            })
                        except Exception:
                            continue
                    if not cards:
                        log(f"    No cards on page {pg}, stopping.")
                        break
                except Exception as e:
                    log(f"    Page {pg} error: {e}")
                    break
                random_delay(2, 4)
            browser.close()
        except Exception as e:
            log(f"  Playwright failed ({e}), trying Selenium...")
            browser = None
            tools = _scrape_futurepedia_selenium(tools)
            method = 'selenium'
    return tools, method

def _scrape_futurepedia_selenium(tools):
    try:
        import undetected_chromedriver as uc
        drv = uc.Chrome(headless=True)
        for pg in range(1, 11):
            url = f"https://www.futurepedia.io/ai-tools?page={pg}"
            log(f"  Source 2 Futurepedia (Selenium) page {pg}/10")
            try:
                drv.get(url)
                random_delay(3, 5)
                drv.execute_script("for(let i=0;i<10;i++) window.scrollBy(0,600);")
                random_delay(1, 2)
                cards = drv.find_elements('css selector', 'a[href*="/ai-tools/"]')
                for c in cards[:25]:
                    try:
                        name = c.text[:120].strip()
                        href = c.get_attribute('href')
                        if name and href:
                            tools.append({
                                'name': name, 'slug': slugify(name),
                                'description': '', 'short_desc': name,
                                'category': 'AI Tools', 'pricing': 'free',
                                'website_url': href,
                                'logo_url': get_logo_url(href),
                                'tags': 'ai,futurepedia',
                            })
                    except Exception:
                        continue
            except Exception as e:
                log(f"    Error: {e}")
                break
        drv.quit()
    except Exception as e:
        log(f"  Selenium also failed: {e}")
    return tools

# ─────────────────────────────────────────────
# SOURCE 3: There's An AI For That
# ─────────────────────────────────────────────
def scrape_theresanaiforthat(page=1, max_pages=10):
    from playwright.sync_api import sync_playwright
    tools = []
    method = 'unknown'
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        try:
            ctx = browser.new_context(viewport={'width': 1280, 'height': 800})
            page_obj = ctx.new_page()
            method = 'playwright'
            for pg in range(1, max_pages + 1):
                url = f"https://theresanaiforthat.com/?s=&page={pg}"
                log(f"  Source 3 TAIFT page {pg}/{max_pages}")
                try:
                    page_obj.goto(url, wait_until='domcontentloaded', timeout=30000)
                    random_delay(2, 4)
                    cards = page_obj.locator('article.post, .post-item, .tool-card').all()
                    for card in cards[:20]:
                        try:
                            a = card.locator('a[href]').first
                            href = a.get_attribute('href') or ''
                            name_el = card.locator('h2,h3,h4,.entry-title,a').first
                            name = name_el.inner_text()[:120].strip()
                            desc_el = card.locator('.excerpt,p').first
                            desc = desc_el.inner_text()[:400].strip() if desc_el else ''
                            if not name or not href:
                                continue
                            tools.append({
                                'name': name, 'slug': slugify(name),
                                'description': desc,
                                'short_desc': desc[:200] if desc else name,
                                'category': category_from_text(name + ' ' + desc),
                                'pricing': 'free',
                                'website_url': href,
                                'logo_url': get_logo_url(href),
                                'tags': 'ai,taaft',
                            })
                        except Exception:
                            continue
                    if not cards:
                        log(f"    No cards on page {pg}, stopping.")
                        break
                except Exception as e:
                    log(f"    Page {pg} error: {e}")
                    break
                random_delay(2, 4)
            browser.close()
        except Exception as e:
            log(f"  Playwright failed ({e}), trying Selenium...")
            tools = _scrape_taaft_selenium(tools)
            method = 'selenium'
    return tools, method

def _scrape_taaft_selenium(tools):
    try:
        import undetected_chromedriver as uc
        drv = uc.Chrome(headless=True)
        for pg in range(1, 11):
            url = f"https://theresanaiforthat.com/?s=&page={pg}"
            log(f"  Source 3 TAIFT (Selenium) page {pg}/10")
            try:
                drv.get(url)
                random_delay(2, 4)
                cards = drv.find_elements('css selector', 'article.post')
                for c in cards[:20]:
                    try:
                        a = c.find_element('css selector', 'a')
                        name = a.text[:120].strip()
                        href = a.get_attribute('href')
                        if name and href:
                            tools.append({
                                'name': name, 'slug': slugify(name),
                                'description': '', 'short_desc': name,
                                'category': 'AI Tools', 'pricing': 'free',
                                'website_url': href,
                                'logo_url': get_logo_url(href),
                                'tags': 'ai,taaft',
                            })
                    except Exception:
                        continue
            except Exception as e:
                log(f"    Error: {e}")
                break
        drv.quit()
    except Exception as e:
        log(f"  Selenium also failed: {e}")
    return tools

# ─────────────────────────────────────────────
# SOURCE 4: AllThingsAI
# ─────────────────────────────────────────────
def scrape_allthingsai(page=1, max_pages=5):
    from playwright.sync_api import sync_playwright
    tools = []
    method = 'unknown'
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        try:
            ctx = browser.new_context(viewport={'width': 1280, 'height': 800})
            page_obj = ctx.new_page()
            method = 'playwright'
            for pg in range(1, max_pages + 1):
                url = f"https://allthingsai.com/?paged={pg}"
                log(f"  Source 4 AllThingsAI page {pg}/{max_pages}")
                try:
                    page_obj.goto(url, wait_until='domcontentloaded', timeout=30000)
                    random_delay(2, 4)
                    cards = page_obj.locator('article, .tool-item, .post-item').all()
                    for card in cards[:20]:
                        try:
                            a = card.locator('a[href]').first
                            href = a.get_attribute('href') or ''
                            name_el = card.locator('h2,h3,h4,.title,.post-title').first
                            name = name_el.inner_text()[:120].strip()
                            desc_el = card.locator('p,.excerpt,.description').first
                            desc = desc_el.inner_text()[:400].strip() if desc_el else ''
                            if not name or not href:
                                continue
                            tools.append({
                                'name': name, 'slug': slugify(name),
                                'description': desc,
                                'short_desc': desc[:200] if desc else name,
                                'category': category_from_text(name + ' ' + desc),
                                'pricing': 'free',
                                'website_url': href,
                                'logo_url': get_logo_url(href),
                                'tags': 'ai,allthingsai',
                            })
                        except Exception:
                            continue
                    if not cards:
                        log(f"    No cards on page {pg}, stopping.")
                        break
                except Exception as e:
                    log(f"    Page {pg} error: {e}")
                    break
                random_delay(2, 4)
            browser.close()
        except Exception as e:
            log(f"  Playwright failed ({e}), trying Selenium...")
            tools = _scrape_allthingsai_selenium(tools)
            method = 'selenium'
    return tools, method

def _scrape_allthingsai_selenium(tools):
    try:
        import undetected_chromedriver as uc
        drv = uc.Chrome(headless=True)
        for pg in range(1, 6):
            url = f"https://allthingsai.com/?paged={pg}"
            log(f"  Source 4 AllThingsAI (Selenium) page {pg}/5")
            try:
                drv.get(url)
                random_delay(2, 4)
                cards = drv.find_elements('css selector', 'article')
                for c in cards[:20]:
                    try:
                        a = c.find_element('css selector', 'a[href]')
                        name = a.text[:120].strip()
                        href = a.get_attribute('href')
                        if name and href and 'allthingsai.com' not in href:
                            tools.append({
                                'name': name, 'slug': slugify(name),
                                'description': '', 'short_desc': name,
                                'category': 'AI Tools', 'pricing': 'free',
                                'website_url': href,
                                'logo_url': get_logo_url(href),
                                'tags': 'ai,allthingsai',
                            })
                    except Exception:
                        continue
            except Exception as e:
                log(f"    Error: {e}")
                break
        drv.quit()
    except Exception as e:
        log(f"  Selenium also failed: {e}")
    return tools

# ─────────────────────────────────────────────
# SOURCE 5: FutureTools.io
# ─────────────────────────────────────────────
def scrape_futuretools(page=1, max_pages=5):
    from playwright.sync_api import sync_playwright
    tools = []
    method = 'unknown'
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        try:
            ctx = browser.new_context(viewport={'width': 1280, 'height': 800})
            page_obj = ctx.new_page()
            method = 'playwright'
            for pg in range(1, max_pages + 1):
                url = f"https://www.futuretools.io/listing?page={pg}"
                log(f"  Source 5 FutureTools page {pg}/{max_pages}")
                try:
                    page_obj.goto(url, wait_until='domcontentloaded', timeout=30000)
                    random_delay(2, 4)
                    cards = page_obj.locator('a[href*="/tool/"], .tool-card, article').all()
                    for card in cards[:25]:
                        try:
                            href = card.get_attribute('href') or ''
                            name_el = card.locator('h2,h3,h4,.title').first
                            name = name_el.inner_text()[:120].strip()
                            desc_el = card.locator('p,.description').first
                            desc = desc_el.inner_text()[:500].strip() if desc_el else ''
                            if not name or not href:
                                continue
                            full_url = href if href.startswith('http') else f"https://www.futuretools.io{href}"
                            tools.append({
                                'name': name, 'slug': slugify(name),
                                'description': desc,
                                'short_desc': desc[:200] if desc else name,
                                'category': category_from_text(name + ' ' + desc),
                                'pricing': 'free',
                                'website_url': full_url,
                                'logo_url': get_logo_url(full_url),
                                'tags': 'ai,futuretools',
                            })
                        except Exception:
                            continue
                    if not cards:
                        log(f"    No cards on page {pg}, stopping.")
                        break
                except Exception as e:
                    log(f"    Page {pg} error: {e}")
                    break
                random_delay(2, 4)
            browser.close()
        except Exception as e:
            log(f"  Playwright failed ({e}), trying Selenium...")
            tools = _scrape_futuretools_selenium(tools)
            method = 'selenium'
    return tools, method

def _scrape_futuretools_selenium(tools):
    try:
        import undetected_chromedriver as uc
        drv = uc.Chrome(headless=True)
        for pg in range(1, 6):
            url = f"https://www.futuretools.io/listing?page={pg}"
            log(f"  Source 5 FutureTools (Selenium) page {pg}/5")
            try:
                drv.get(url)
                random_delay(2, 4)
                cards = drv.find_elements('css selector', 'a[href*="/tool/"]')
                for c in cards[:25]:
                    try:
                        name = c.text[:120].strip()
                        href = c.get_attribute('href')
                        if name and href:
                            tools.append({
                                'name': name, 'slug': slugify(name),
                                'description': '', 'short_desc': name,
                                'category': 'AI Tools', 'pricing': 'free',
                                'website_url': href,
                                'logo_url': get_logo_url(href),
                                'tags': 'ai,futuretools',
                            })
                    except Exception:
                        continue
            except Exception as e:
                log(f"    Error: {e}")
                break
        drv.quit()
    except Exception as e:
        log(f"  Selenium also failed: {e}")
    return tools

# ─────────────────────────────────────────────
# SOURCE 6: TopAI.tools
# ─────────────────────────────────────────────
def scrape_topai(page=1, max_pages=10):
    from playwright.sync_api import sync_playwright
    tools = []
    method = 'unknown'
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        try:
            ctx = browser.new_context(viewport={'width': 1280, 'height': 800})
            page_obj = ctx.new_page()
            method = 'playwright'
            for pg in range(1, max_pages + 1):
                url = f"https://topai.tools/?page={pg}"
                log(f"  Source 6 TopAI page {pg}/{max_pages}")
                try:
                    page_obj.goto(url, wait_until='domcontentloaded', timeout=30000)
                    random_delay(2, 4)
                    cards = page_obj.locator('a[href*="/tool/"], article, .tool-card').all()
                    for card in cards[:25]:
                        try:
                            href = card.get_attribute('href') or ''
                            name_el = card.locator('h2,h3,h4,.title').first
                            name = name_el.inner_text()[:120].strip()
                            desc_el = card.locator('p,.description').first
                            desc = desc_el.inner_text()[:400].strip() if desc_el else ''
                            if not name or not href:
                                continue
                            full_url = href if href.startswith('http') else f"https://topai.tools{href}"
                            tools.append({
                                'name': name, 'slug': slugify(name),
                                'description': desc,
                                'short_desc': desc[:200] if desc else name,
                                'category': category_from_text(name + ' ' + desc),
                                'pricing': 'free',
                                'website_url': full_url,
                                'logo_url': get_logo_url(full_url),
                                'tags': 'ai,topai',
                            })
                        except Exception:
                            continue
                    if not cards:
                        log(f"    No cards on page {pg}, stopping.")
                        break
                except Exception as e:
                    log(f"    Page {pg} error: {e}")
                    break
                random_delay(2, 4)
            browser.close()
        except Exception as e:
            log(f"  Playwright failed ({e}), trying Selenium...")
            tools = _scrape_topai_selenium(tools)
            method = 'selenium'
    return tools, method

def _scrape_topai_selenium(tools):
    try:
        import undetected_chromedriver as uc
        drv = uc.Chrome(headless=True)
        for pg in range(1, 11):
            url = f"https://topai.tools/?page={pg}"
            log(f"  Source 6 TopAI (Selenium) page {pg}/10")
            try:
                drv.get(url)
                random_delay(2, 4)
                cards = drv.find_elements('css selector', 'a[href*="/tool/"]')
                for c in cards[:25]:
                    try:
                        name = c.text[:120].strip()
                        href = c.get_attribute('href')
                        if name and href:
                            tools.append({
                                'name': name, 'slug': slugify(name),
                                'description': '', 'short_desc': name,
                                'category': 'AI Tools', 'pricing': 'free',
                                'website_url': href,
                                'logo_url': get_logo_url(href),
                                'tags': 'ai,topai',
                            })
                    except Exception:
                        continue
            except Exception as e:
                log(f"    Error: {e}")
                break
        drv.quit()
    except Exception as e:
        log(f"  Selenium also failed: {e}")
    return tools

# ─────────────────────────────────────────────
# SOURCE 7: AIxploria
# ─────────────────────────────────────────────
def scrape_aixploria(page=1, max_pages=5):
    from playwright.sync_api import sync_playwright
    tools = []
    method = 'unknown'
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        try:
            ctx = browser.new_context(viewport={'width': 1280, 'height': 800})
            page_obj = ctx.new_page()
            method = 'playwright'
            for pg in range(1, max_pages + 1):
                url = f"https://www.aixploria.com/en/?paged={pg}"
                log(f"  Source 7 AIxploria page {pg}/{max_pages}")
                try:
                    page_obj.goto(url, wait_until='domcontentloaded', timeout=30000)
                    random_delay(2, 4)
                    cards = page_obj.locator('article, .tool-item, .post-item').all()
                    for card in cards[:20]:
                        try:
                            a = card.locator('a[href]').first
                            href = a.get_attribute('href') or ''
                            name_el = card.locator('h2,h3,h4,.title').first
                            name = name_el.inner_text()[:120].strip()
                            desc_el = card.locator('p,.excerpt').first
                            desc = desc_el.inner_text()[:400].strip() if desc_el else ''
                            if not name or not href:
                                continue
                            if 'aixploria.com' in href:
                                continue
                            tools.append({
                                'name': name, 'slug': slugify(name),
                                'description': desc,
                                'short_desc': desc[:200] if desc else name,
                                'category': category_from_text(name + ' ' + desc),
                                'pricing': 'free',
                                'website_url': href,
                                'logo_url': get_logo_url(href),
                                'tags': 'ai,aixploria',
                            })
                        except Exception:
                            continue
                    if not cards:
                        log(f"    No cards on page {pg}, stopping.")
                        break
                except Exception as e:
                    log(f"    Page {pg} error: {e}")
                    break
                random_delay(2, 4)
            browser.close()
        except Exception as e:
            log(f"  Playwright failed ({e}), trying Selenium...")
            tools = _scrape_aixploria_selenium(tools)
            method = 'selenium'
    return tools, method

def _scrape_aixploria_selenium(tools):
    try:
        import undetected_chromedriver as uc
        drv = uc.Chrome(headless=True)
        for pg in range(1, 6):
            url = f"https://www.aixploria.com/en/?paged={pg}"
            log(f"  Source 7 AIxploria (Selenium) page {pg}/5")
            try:
                drv.get(url)
                random_delay(2, 4)
                cards = drv.find_elements('css selector', 'article')
                for c in cards[:20]:
                    try:
                        a = c.find_element('css selector', 'a[href]')
                        name = a.text[:120].strip()
                        href = a.get_attribute('href')
                        if name and href and 'aixploria.com' not in href:
                            tools.append({
                                'name': name, 'slug': slugify(name),
                                'description': '', 'short_desc': name,
                                'category': 'AI Tools', 'pricing': 'free',
                                'website_url': href,
                                'logo_url': get_logo_url(href),
                                'tags': 'ai,aixploria',
                            })
                    except Exception:
                        continue
            except Exception as e:
                log(f"    Error: {e}")
                break
        drv.quit()
    except Exception as e:
        log(f"  Selenium also failed: {e}")
    return tools

# ─────────────────────────────────────────────
# SOURCE 8: Insidr.ai
# ─────────────────────────────────────────────
def scrape_insidr(page=1, max_pages=5):
    from playwright.sync_api import sync_playwright
    tools = []
    method = 'unknown'
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        try:
            ctx = browser.new_context(viewport={'width': 1280, 'height': 800})
            page_obj = ctx.new_page()
            method = 'playwright'
            for pg in range(1, max_pages + 1):
                url = f"https://www.insidr.ai/ai-tools/?paged={pg}"
                log(f"  Source 8 Insidr page {pg}/{max_pages}")
                try:
                    page_obj.goto(url, wait_until='domcontentloaded', timeout=30000)
                    random_delay(2, 4)
                    cards = page_obj.locator('article, .tool-card, .item').all()
                    for card in cards[:20]:
                        try:
                            a = card.locator('a[href]').first
                            href = a.get_attribute('href') or ''
                            name_el = card.locator('h2,h3,h4,.title').first
                            name = name_el.inner_text()[:120].strip()
                            desc_el = card.locator('p,.description').first
                            desc = desc_el.inner_text()[:400].strip() if desc_el else ''
                            if not name or not href:
                                continue
                            if 'insidr.ai' in href:
                                continue
                            tools.append({
                                'name': name, 'slug': slugify(name),
                                'description': desc,
                                'short_desc': desc[:200] if desc else name,
                                'category': category_from_text(name + ' ' + desc),
                                'pricing': 'free',
                                'website_url': href,
                                'logo_url': get_logo_url(href),
                                'tags': 'ai,insidr',
                            })
                        except Exception:
                            continue
                    if not cards:
                        log(f"    No cards on page {pg}, stopping.")
                        break
                except Exception as e:
                    log(f"    Page {pg} error: {e}")
                    break
                random_delay(2, 4)
            browser.close()
        except Exception as e:
            log(f"  Playwright failed ({e}), trying Selenium...")
            tools = _scrape_insidr_selenium(tools)
            method = 'selenium'
    return tools, method

def _scrape_insidr_selenium(tools):
    try:
        import undetected_chromedriver as uc
        drv = uc.Chrome(headless=True)
        for pg in range(1, 6):
            url = f"https://www.insidr.ai/ai-tools/?paged={pg}"
            log(f"  Source 8 Insidr (Selenium) page {pg}/5")
            try:
                drv.get(url)
                random_delay(2, 4)
                cards = drv.find_elements('css selector', 'article')
                for c in cards[:20]:
                    try:
                        a = c.find_element('css selector', 'a[href]')
                        name = a.text[:120].strip()
                        href = a.get_attribute('href')
                        if name and href and 'insidr.ai' not in href:
                            tools.append({
                                'name': name, 'slug': slugify(name),
                                'description': '', 'short_desc': name,
                                'category': 'AI Tools', 'pricing': 'free',
                                'website_url': href,
                                'logo_url': get_logo_url(href),
                                'tags': 'ai,insidr',
                            })
                    except Exception:
                        continue
            except Exception as e:
                log(f"    Error: {e}")
                break
        drv.quit()
    except Exception as e:
        log(f"  Selenium also failed: {e}")
    return tools

# ─────────────────────────────────────────────
# SOURCE 9: ToolFk.com
# ─────────────────────────────────────────────
def scrape_toolfk(page=1, max_pages=5):
    from playwright.sync_api import sync_playwright
    tools = []
    method = 'unknown'
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        try:
            ctx = browser.new_context(viewport={'width': 1280, 'height': 800})
            page_obj = ctx.new_page()
            method = 'playwright'
            for pg in range(1, max_pages + 1):
                url = f"https://www.toolfk.com/tool-list-{pg}"
                log(f"  Source 9 ToolFk page {pg}/{max_pages}")
                try:
                    page_obj.goto(url, wait_until='domcontentloaded', timeout=30000)
                    random_delay(2, 4)
                    cards = page_obj.locator('a[href*="/tool/"], .tool-item, article').all()
                    for card in cards[:25]:
                        try:
                            href = card.get_attribute('href') or ''
                            name_el = card.locator('h2,h3,h4,.title').first
                            name = name_el.inner_text()[:120].strip()
                            desc_el = card.locator('p,.description').first
                            desc = desc_el.inner_text()[:400].strip() if desc_el else ''
                            if not name or not href:
                                continue
                            if not href.startswith('http'):
                                href = f"https://www.toolfk.com{href}"
                            tools.append({
                                'name': name, 'slug': slugify(name),
                                'description': desc,
                                'short_desc': desc[:200] if desc else name,
                                'category': category_from_text(name + ' ' + desc),
                                'pricing': 'free',
                                'website_url': href,
                                'logo_url': get_logo_url(href),
                                'tags': 'ai,toolfk',
                            })
                        except Exception:
                            continue
                    if not cards:
                        log(f"    No cards on page {pg}, stopping.")
                        break
                except Exception as e:
                    log(f"    Page {pg} error: {e}")
                    break
                random_delay(2, 4)
            browser.close()
        except Exception as e:
            log(f"  Playwright failed ({e}), trying Selenium...")
            tools = _scrape_toolfk_selenium(tools)
            method = 'selenium'
    return tools, method

def _scrape_toolfk_selenium(tools):
    try:
        import undetected_chromedriver as uc
        drv = uc.Chrome(headless=True)
        for pg in range(1, 6):
            url = f"https://www.toolfk.com/tool-list-{pg}"
            log(f"  Source 9 ToolFk (Selenium) page {pg}/5")
            try:
                drv.get(url)
                random_delay(2, 4)
                cards = drv.find_elements('css selector', 'a[href*="/tool/"]')
                for c in cards[:25]:
                    try:
                        name = c.text[:120].strip()
                        href = c.get_attribute('href')
                        if name and href and not href.startswith('http'):
                            href = f"https://www.toolfk.com{href}"
                        if name and href:
                            tools.append({
                                'name': name, 'slug': slugify(name),
                                'description': '', 'short_desc': name,
                                'category': 'AI Tools', 'pricing': 'free',
                                'website_url': href,
                                'logo_url': get_logo_url(href),
                                'tags': 'ai,toolfk',
                            })
                    except Exception:
                        continue
            except Exception as e:
                log(f"    Error: {e}")
                break
        drv.quit()
    except Exception as e:
        log(f"  Selenium also failed: {e}")
    return tools

# ─────────────────────────────────────────────
# SOURCE 10: Trendshift.io
# ─────────────────────────────────────────────
AI_KEYWORDS = [
    'ai', 'artificial intelligence', 'machine learning', 'ml', 'llm',
    'large language model', 'gpt', 'claude', 'copilot', 'automated',
    'neural network', 'deep learning', 'generative', 'nlp', 'chatbot',
    'automation', 'prompt', 'embedding', 'transformer', 'model',
    'synthesi', 'discourse', 'v0', 'cursor', ' windsurf', 'copilot'
]

def scrape_trendshift(page=1, max_pages=10):
    tools = []
    method = 'requests'
    for pg in range(1, max_pages + 1):
        url = f"https://trendshift.io/repositories?page={pg}"
        log(f"  Source 10 Trendshift page {pg}/{max_pages}")
        try:
            r = requests.get(url, headers={'User-Agent': 'Mozilla/5.0'}, timeout=20)
            soup = BeautifulSoup(r.text, 'html.parser')
            items = soup.select('a[href^="/repository/"], .repo-item, article')
            found = 0
            for item in items[:30]:
                try:
                    href = item.get('href', '')
                    if not href.startswith('/repository/'):
                        continue
                    repo_url = f"https://trendshift.io{href}"
                    name_el = item.select_one('h3,h2,h4,.repo-name')
                    name = (name_el.get_text(strip=True) if name_el else '').strip()
                    desc_el = item.select_one('.description,.repo-desc,p')
                    desc = (desc_el.get_text(strip=True) if desc_el else '')[:500]
                    if not name or not desc:
                        continue
                    # Check AI keywords
                    text = (name + ' ' + desc).lower()
                    if not any(kw in text for kw in AI_KEYWORDS):
                        continue
                    # Get actual repo URL
                    link_el = item.select_one('a')
                    actual_url = link_el.get('href', '').strip() if link_el else href
                    if actual_url.startswith('/'):
                        actual_url = f"https://github.com{actual_url}" if 'github' in actual_url else f"https://trendshift.io{actual_url}"
                    tools.append({
                        'name': name, 'slug': slugify(name),
                        'description': desc,
                        'short_desc': desc[:200],
                        'category': 'Open Source',
                        'pricing': 'free',
                        'website_url': actual_url,
                        'logo_url': get_logo_url(actual_url),
                        'tags': 'ai,opensource,trendshift',
                    })
                    found += 1
                except Exception:
                    continue
            log(f"    Found {found} AI tools on page {pg}")
            if found == 0:
                log(f"    No more AI tools on page {pg}, stopping.")
                break
        except Exception as e:
            log(f"    Error: {e}")
            if pg > 2:
                break
        random_delay(2, 4)
    return tools, method

# ─────────────────────────────────────────────
# SOURCE 11: HackerNews Algolia
# ─────────────────────────────────────────────
def scrape_hn_algolia():
    tools = []
    method = 'requests'
    queries = [
        'Show HN AI',
        'Show HN artificial intelligence',
        'Show HN machine learning',
        'Show HN LLM',
        'AI tool launch',
        'new AI tool',
    ]
    for query in queries:
        url = f"https://hn.algolia.com/api/v1/search?query={quote(query)}&tags=story&hitsPerPage=100"
        log(f"  Source 11 HN Algolia: {query}")
        try:
            r = requests.get(url, headers={'User-Agent': 'Mozilla/5.0'}, timeout=20)
            data = r.json()
            hits = data.get('hits', [])
            found = 0
            for hit in hits:
                if hit.get('points', 0) < 30:
                    continue
                title = hit.get('title', '')
                story_url = hit.get('url', '')
                if not title or not story_url:
                    continue
                # Check AI relevance
                text = (title + ' ' + hit.get('story_text', '')).lower()
                if not any(kw in text for kw in ['ai', 'artificial', 'machine learning', 'llm', 'gpt', 'claude', 'neural', 'generative', 'chatbot']):
                    continue
                tools.append({
                    'name': title, 'slug': slugify(title),
                    'description': (hit.get('story_text', '') or '')[:1000],
                    'short_desc': (hit.get('story_text', '') or '')[:200],
                    'category': 'Open Source',
                    'pricing': 'free',
                    'website_url': story_url,
                    'logo_url': get_logo_url(story_url),
                    'tags': 'ai,hackernews,show-hn',
                })
                found += 1
            log(f"    Found {found} AI tools from query")
            random_delay(2, 4)
        except Exception as e:
            log(f"    Error: {e}")
    return tools, method

# ─────────────────────────────────────────────
# SOURCE 12: Product Hunt RSS
# ─────────────────────────────────────────────
def scrape_producthunt():
    tools = []
    method = 'requests'
    url = 'https://www.producthunt.com/feed'
    log(f"  Source 12 Product Hunt RSS")
    try:
        r = requests.get(url, headers={'User-Agent': 'Mozilla/5.0'}, timeout=20)
        soup = BeautifulSoup(r.text, 'xml' if 'xml' in r.headers.get('content-type', '') else 'html.parser')
        items = soup.find_all('item') if soup.find('rss') else soup.find_all('entry')
        if not items:
            items = soup.find_all('item')
        found = 0
        for item in items[:50]:
            try:
                title = item.find('title').string if item.find('title') else ''
                link = item.find('link').string if item.find('link') else ''
                desc = item.find('description').string if item.find('description') else ''
                if not title or not link:
                    continue
                text = (title + ' ' + desc).lower()
                if not any(kw in text for kw in ['ai', 'artificial', 'machine learning', 'llm', 'gpt', 'claude', 'chatbot', 'automate', 'agent']):
                    continue
                tools.append({
                    'name': title, 'slug': slugify(title),
                    'description': desc[:500] if desc else '',
                    'short_desc': desc[:200] if desc else title,
                    'category': 'AI Tools',
                    'pricing': 'free',
                    'website_url': link,
                    'logo_url': get_logo_url(link),
                    'tags': 'ai,producthunt',
                })
                found += 1
            except Exception:
                continue
        log(f"    Found {found} AI tools from Product Hunt")
    except Exception as e:
        log(f"    Error: {e}")
    return tools, method

# ─────────────────────────────────────────────
# SOURCE 13: GitHub AI Repositories
# ─────────────────────────────────────────────
GITHUB_AI_KEYWORDS = [
    'ai', 'artificial intelligence', 'machine learning', 'ml', 'llm',
    'large language model', 'gpt', 'claude', 'copilot', 'automated',
    'neural network', 'deep learning', 'generative', 'nlp', 'chatbot',
    'automation', 'prompt', 'embedding', 'transformer', 'model',
    'synthesi', 'discourse', 'v0', 'cursor', 'agent', 'rag',
    'multimodal', 'computer vision', 'speech recognition', 'text-to-image',
]

def scrape_github(page=1, max_pages=20):
    tools = []
    method = 'requests'
    queries = [
        'AI tool', 'artificial intelligence tool', 'machine learning tool',
        'LLM application', 'generative AI', 'AI assistant', 'AI chatbot',
        'AI coding', 'AI writing', 'AI image', 'AI video', 'AI audio',
        'open source AI', 'AI framework', 'AI library', 'AI SDK',
        'LangChain', 'LLM wrapper', 'AI agent', 'AI automation',
    ]
    for query in queries:
        for pg in range(1, max_pages + 1):
            url = f"https://api.github.com/search/repositories?q={quote(query)}+language:python&sort=stars&per_page=100&page={pg}"
            log(f"  Source 13 GitHub: '{query}' page {pg}/{max_pages}")
            try:
                r = requests.get(url, headers={
                    'Accept': 'application/vnd.github.v3+json',
                    'User-Agent': 'AI-Tools-Director/1.0'
                }, timeout=20)
                if r.status_code == 403:
                    log(f"    Rate limited, waiting...")
                    random_delay(5, 10)
                    continue
                if r.status_code != 200:
                    log(f"    Status {r.status_code}, skipping")
                    break
                data = r.json()
                items = data.get('items', [])
                if not items:
                    log(f"    No more results for '{query}'")
                    break
                found = 0
                for item in items:
                    desc = (item.get('description') or '').strip()
                    name = item.get('name', '').strip()
                    full_name = item.get('full_name', '').strip()
                    html_url = item.get('html_url', '').strip()
                    stars = item.get('stargazers_count', 0)
                    if stars < 100:
                        continue
                    text = (name + ' ' + desc).lower()
                    if not any(kw in text for kw in GITHUB_AI_KEYWORDS):
                        continue
                    if not desc or len(desc) < 20:
                        continue
                    tools.append({
                        'name': name, 'slug': slugify(name),
                        'description': desc[:2000],
                        'short_desc': desc[:200],
                        'category': 'Open Source',
                        'pricing': 'free',
                        'website_url': html_url,
                        'logo_url': get_logo_url(html_url),
                        'tags': f'ai,opensource,github,{query[:20]}',
                    })
                    found += 1
                log(f"    Found {found} AI repos from '{query}' page {pg}")
                random_delay(2, 4)
                if found == 0:
                    break
            except Exception as e:
                log(f"    Error: {e}")
                random_delay(3, 5)
    return tools, method

# ─────────────────────────────────────────────
# SOURCE 14: More HN Algolia Queries
# ─────────────────────────────────────────────
def scrape_hn_extended():
    tools = []
    method = 'requests'
    queries = [
        'Show HN AI', 'Show HN artificial intelligence', 'Show HN machine learning',
        'Show HN LLM', 'Show HN chatbot', 'Show HN agent', 'Show HN automation',
        'Show HN prompt', 'Show HN generative', 'Show HN diffusion',
        'Show HN computer vision', 'Show HN speech', 'Show HN translation',
        'Show HN NLP', 'Show HN embeddings', 'Show HN RAG',
        'AI tool launch', 'new AI tool', 'best AI tool',
        'open source AI', 'AI starter kit', 'AI boilerplate',
        'AI framework', 'AI library', 'AI SDK',
    ]
    for query in queries:
        url = f"https://hn.algolia.com/api/v1/search?query={quote(query)}&tags=story&hitsPerPage=100"
        log(f"  Source 14 HN Extended: {query}")
        try:
            r = requests.get(url, headers={'User-Agent': 'Mozilla/5.0'}, timeout=20)
            data = r.json()
            hits = data.get('hits', [])
            found = 0
            for hit in hits:
                if hit.get('points', 0) < 20:
                    continue
                title = hit.get('title', '')
                story_url = hit.get('url', '')
                if not title or not story_url:
                    continue
                text = (title + ' ' + hit.get('story_text', '')).lower()
                if not any(kw in text for kw in ['ai', 'artificial', 'machine learning', 'llm', 'gpt', 'claude', 'neural', 'generative', 'chatbot', 'agent', 'prompt', 'diffusion']):
                    continue
                tools.append({
                    'name': title, 'slug': slugify(title),
                    'description': (hit.get('story_text', '') or '')[:1000],
                    'short_desc': (hit.get('story_text', '') or '')[:200],
                    'category': 'Open Source',
                    'pricing': 'free',
                    'website_url': story_url,
                    'logo_url': get_logo_url(story_url),
                    'tags': 'ai,hackernews,show-hn,extended',
                })
                found += 1
            log(f"    Found {found} AI tools from '{query}'")
            random_delay(2, 4)
        except Exception as e:
            log(f"    Error: {e}")
    return tools, method

# ─────────────────────────────────────────────
# MAIN
# ─────────────────────────────────────────────
def main():
    log("=" * 60)
    log("Playwright Scraper — Starting")
    log("=" * 60)

    progress = load_progress()
    seen_urls = load_dedup_set()
    all_tools = []

    sources = [
        ("Source 1: Toolify.ai",           scrape_toolify,           {'max_pages': 15}),
        ("Source 2: Futurepedia.io",       scrape_futurepedia,       {'max_pages': 10}),
        ("Source 3: There's An AI For That", scrape_theresanaiforthat, {'max_pages': 10}),
        ("Source 4: AllThingsAI",          scrape_allthingsai,       {'max_pages': 5}),
        ("Source 5: FutureTools.io",       scrape_futuretools,       {'max_pages': 5}),
        ("Source 6: TopAI.tools",          scrape_topai,             {'max_pages': 10}),
        ("Source 7: AIxploria",            scrape_aixploria,         {'max_pages': 5}),
        ("Source 8: Insidr.ai",            scrape_insidr,            {'max_pages': 5}),
        ("Source 9: ToolFk.com",           scrape_toolfk,            {'max_pages': 5}),
        ("Source 10: Trendshift.io",       scrape_trendshift,        {'max_pages': 10}),
        ("Source 11: HackerNews Algolia",  scrape_hn_algolia,        {}),
        ("Source 12: Product Hunt RSS",    scrape_producthunt,       {}),
        ("Source 13: GitHub AI Repos",     scrape_github,            {'max_pages': 15}),
        ("Source 14: HN Extended",         scrape_hn_extended,       {}),
    ]

    for source_name, scraper_fn, kwargs in sources:
        log(f"\n{'='*60}")
        log(f"{source_name}")
        log(f"{'='*60}")
        if source_name in progress.get('sources_completed', []):
            log(f"  SKIPPED — already completed")
            continue

        tools, method = scraper_fn(**kwargs)
        log(f"  Method used: {method}")
        log(f"  Tools scraped: {len(tools)}")

        new_tools = []
        for t in tools:
            key = dedupe_key(t['website_url'])
            if key in seen_urls:
                continue
            seen_urls.add(key)
            # Also dedupe by exact URL
            if t['website_url'] in seen_urls:
                continue
            seen_urls.add(t['website_url'])
            new_tools.append(t)

        log(f"  New unique tools: {len(new_tools)}")

        if new_tools:
            BATCH = 20
            for i in range(0, len(new_tools), BATCH):
                batch = new_tools[i:i+BATCH]
                ins, skipped = insert_into_d1(batch)
                log(f"    Inserted {ins}/{len(batch)} (batch {i//BATCH + 1})")
            progress['tools_inserted'] = progress.get('tools_inserted', 0) + len(new_tools)
        else:
            ins = 0

        progress['tools_scraped'] = progress.get('tools_scraped', 0) + len(tools)
        if source_name not in progress.get('sources_completed', []):
            progress.setdefault('sources_completed', []).append(source_name)
        save_progress(progress)

        current_count = get_d1_count()
        log(f"  D1 total after source: {current_count}")

    # Final summary
    log(f"\n{'='*60}")
    log("SCRAPING COMPLETE")
    log(f"{'='*60}")
    log(f"Sources completed: {len(progress.get('sources_completed', []))}/12")
    log(f"Total scraped: {progress.get('tools_scraped', 0)}")
    log(f"Total inserted (unique): {progress.get('tools_inserted', 0)}")
    final_count = get_d1_count()
    log(f"Final D1 count: {final_count}")

    # Show wrangler count
    subprocess.run([
        'wrangler', 'd1', 'execute', DB_NAME, '--remote',
        '--command', "SELECT COUNT(*) as total FROM tools WHERE status='published'"
    ])

if __name__ == '__main__':
    main()
