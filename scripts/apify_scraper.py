#!/usr/bin/env python3
"""
Apify-based AI Tools Scraper
Uses apify/web-scraper actor with 4 API keys, fixed site assignments, and
fallback rotation. Inserts new tools into remote D1 via wrangler.
"""

import os
import re
import json
import time
import hashlib
import subprocess
from urllib.parse import urlparse, urljoin
from datetime import datetime

import requests

# ─────────────────────────────────────────────
# Configuration
# ─────────────────────────────────────────────
APIFY_KEYS = {
    'key4': os.environ.get('APIFY_KEY_4', ''),
    'key1': os.environ.get('APIFY_KEY_1', ''),
    'key2': os.environ.get('APIFY_KEY_2', ''),
    'key3': os.environ.get('APIFY_KEY_3', ''),
}

# Fixed account assignments
SITE_KEYS = {
    'toolify': 'key4',
    'futurepedia': 'key4',
    'taaft': 'key4',
    'allthingsai': 'key1',
    'futuretools': 'key3',
    'topai': 'key1',
    'aixploria': 'key2',
    'insidr': 'key2',
    'toolfk': 'key1',
    'trendshift': 'key3',
}

SITES = {
    'toolify': {
        'startUrls': ['https://www.toolify.ai/'],
        'maxPages': 50,
        'scrollForLazyLoad': False,
    },
    'futurepedia': {
        'startUrls': ['https://www.futurepedia.io/ai-tools'],
        'maxPages': 20,
        'scrollForLazyLoad': True,
    },
    'taaft': {
        'startUrls': ['https://theresanaiforthat.com/'],
        'maxPages': 30,
        'scrollForLazyLoad': False,
    },
    'allthingsai': {
        'startUrls': ['https://allthingsai.com/'],
        'maxPages': 10,
        'scrollForLazyLoad': False,
    },
    'futuretools': {
        'startUrls': ['https://www.futuretools.io/'],
        'maxPages': 20,
        'scrollForLazyLoad': False,
    },
    'topai': {
        'startUrls': ['https://topai.tools/'],
        'maxPages': 30,
        'scrollForLazyLoad': False,
    },
    'aixploria': {
        'startUrls': ['https://www.aixploria.com/en/'],
        'maxPages': 20,
        'scrollForLazyLoad': False,
    },
    'insidr': {
        'startUrls': ['https://www.insidr.ai/ai-tools/'],
        'maxPages': 20,
        'scrollForLazyLoad': False,
    },
    'toolfk': {
        'startUrls': ['https://www.toolfk.com/'],
        'maxPages': 20,
        'scrollForLazyLoad': False,
    },
    'trendshift': {
        'startUrls': ['https://trendshift.io/'],
        'maxPages': 20,
        'scrollForLazyLoad': False,
    },
}

CF_API_TOKEN = os.environ.get('CF_API_TOKEN', '')
CF_ACCOUNT_ID = os.environ.get('CLOUDFLARE_ACCOUNT_ID', '')
CF_D1_ID = 'ff26faf5-3c7c-445a-a249-6c96fedddfdc'
DB_NAME = 'ai-directory-db'

FALLBACK_FILE = '/tmp/apify_fallback.json'
PROGRESS_FILE = '/tmp/apify_scraper_progress.json'

# Track which keys used today (to avoid same key twice per day)
USED_KEYS = set()


def log(msg):
    print(f"[{datetime.now().strftime('%H:%M:%S')}] {msg}", flush=True)


def slugify(text):
    text = re.sub(r'[^\w\s-]', '', text).strip().lower()
    text = re.sub(r'[\s]+', '-', text)
    return text[:80]


def get_logo_url(url):
    try:
        domain = urlparse(url).netloc
        return f"https://www.google.com/s2/favicons?domain={domain}&sz=64"
    except Exception:
        return ""


def escape_sql(s):
    return str(s).replace("'", "''")


def load_fallback_log():
    if os.path.exists(FALLBACK_FILE):
        try:
            with open(FALLBACK_FILE) as f:
                return json.load(f)
        except Exception:
            pass
    return {}


def save_fallback_log(data):
    with open(FALLBACK_FILE, 'w') as f:
        json.dump(data, f, indent=2)


def load_progress():
    if os.path.exists(PROGRESS_FILE):
        try:
            with open(PROGRESS_FILE) as f:
                return json.load(f)
        except Exception:
            pass
    return {'sources_completed': []}


def save_progress(data):
    with open(PROGRESS_FILE, 'w') as f:
        json.dump(data, f, indent=2)


# ─────────────────────────────────────────────
# D1 helpers
# ─────────────────────────────────────────────
def d1_env():
    env = os.environ.copy()
    env['CF_API_TOKEN'] = CF_API_TOKEN
    env['CLOUDFLARE_API_TOKEN'] = CF_API_TOKEN
    env['CLOUDFLARE_ACCOUNT_ID'] = CF_ACCOUNT_ID
    return env


def get_existing_urls():
    """Fetch all existing website_url values from D1."""
    env = d1_env()
    r = subprocess.run(
        ['wrangler', 'd1', 'execute', DB_NAME, '--remote', '--json',
         '--command', "SELECT url FROM tools WHERE status='published'"],
        capture_output=True, text=True, timeout=60, env=env
    )
    urls = set()
    try:
        data = json.loads(r.stdout)
        if isinstance(data, list) and data and data[0].get('results'):
            for row in data[0]['results']:
                u = row.get('url')
                if u:
                    urls.add(u.strip().lower())
    except Exception:
        pass
    return urls


def get_d1_count():
    env = d1_env()
    r = subprocess.run(
        ['wrangler', 'd1', 'execute', DB_NAME, '--remote', '--json',
         '--command', "SELECT COUNT(*) as c FROM tools WHERE status='published'"],
        capture_output=True, text=True, timeout=60, env=env
    )
    try:
        data = json.loads(r.stdout)
        if isinstance(data, list) and data and data[0].get('results'):
            return data[0]['results'][0]['c']
    except Exception:
        pass
    return '?'


def batch_insert(tools_batch):
    """Batch insert using single SQL with multiple VALUES."""
    if not tools_batch:
        return 0, 0
    env = d1_env()

    values = []
    for tool in tools_batch:
        name = escape_sql(tool['name'])
        slug = escape_sql(tool['slug'])
        desc = escape_sql((tool.get('description', '') or '')[:2000])
        short_desc = escape_sql((tool.get('short_desc', '') or '')[:255])
        category = escape_sql(tool.get('category', 'AI Tools'))
        pricing = escape_sql(tool.get('pricing', 'free'))
        url = escape_sql(tool['website_url'])
        logo = escape_sql(tool.get('logo_url', ''))
        tags = escape_sql(tool.get('tags', 'ai'))
        created = datetime.utcnow().strftime('%Y-%m-%d %H:%M:%S')
        values.append(f"('{name}', '{slug}', '{desc}', '{short_desc}', '{category}', '{pricing}', '{url}', '{logo}', 'favicon', '{tags}', 'published', '{created}')")

    if not values:
        return 0, 0

    chunk_size = 30
    total_inserted = 0
    for i in range(0, len(values), chunk_size):
        chunk = values[i:i+chunk_size]
        sql = f"INSERT INTO tools (name, slug, description, short_desc, category, pricing, url, logo_url, logo_type, tags, status, created_at) VALUES {', '.join(chunk)} ON CONFLICT(slug) DO NOTHING"
        r = subprocess.run(
            ['wrangler', 'd1', 'execute', DB_NAME, '--remote', '--json', '--command', sql],
            capture_output=True, text=True, timeout=60, env=env
        )
        if r.returncode == 0 and '✘' not in r.stdout and 'ERROR' not in r.stdout:
            try:
                data = json.loads(r.stdout)
                meta = data[0].get('meta', {})
                total_inserted += meta.get('changes', 0)
            except Exception:
                total_inserted += len(chunk)
        time.sleep(0.3)

    return total_inserted, len(tools_batch) - total_inserted


# ─────────────────────────────────────────────
# Apify API helpers
# ─────────────────────────────────────────────
def pick_key(primary_key, site):
    """Return a usable key for the site with fallback rotation."""
    global USED_KEYS
    fallback_log = load_fallback_log()
    today = datetime.utcnow().strftime('%Y-%m-%d')

    # Ordered fallback: try all 4 keys, never reuse a key used today
    key_order = [primary_key] + [k for k in ['key1', 'key2', 'key3', 'key4'] if k != primary_key]

    for k in key_order:
        key_val = APIFY_KEYS.get(k, '')
        if not key_val:
            continue
        # Skip keys already used today unless it's the primary (first attempt)
        if k in USED_KEYS:
            continue
        # Skip keys that had quota exhausted today per fallback log
        fb_key = fallback_log.get(k, {})
        if fb_key.get('quota_exhausted_date') == today and k != key_order[0]:
            continue
        USED_KEYS.add(k)
        return k, key_val

    # If all used, allow primary anyway
    USED_KEYS.add(primary_key)
    return primary_key, APIFY_KEYS.get(primary_key, '')


ACTOR_WEB_SCRAPER = 'apify~web-scraper'
ACTOR_CONTENT_CRAWLER = 'apify~website-content-crawler'


def start_actor_run(key, input_payload):
    """Start a web-scraper run and return the response."""
    url = f"https://api.apify.com/v2/acts/{ACTOR_WEB_SCRAPER}/runs?token={key}"
    r = requests.post(url, json=input_payload, timeout=30)
    return r


def build_crawler_input(site_cfg):
    """Build website-content-crawler input (full HTML preserved for parsing)."""
    start_urls = [{'url': u} for u in site_cfg['startUrls']]
    return {
        'startUrls': start_urls,
        'maxCrawlPages': site_cfg['maxPages'],
        'maxCrawlDepth': 1,
        'crawlerType': 'playwright:adaptive',
        'htmlTransformer': 'none',
        'removeElementsCssSelector': 'dummy_keep_everything',
        'saveHtml': True,
        'saveMarkdown': False,
        'blockMedia': True,
        'removeCookieWarnings': False,
        'proxyConfiguration': {'useApifyProxy': True},
    }


def start_crawler_run(key, site_cfg):
    """Start a website-content-crawler run (works without actor approval)."""
    url = f"https://api.apify.com/v2/acts/{ACTOR_CONTENT_CRAWLER}/runs?token={key}"
    r = requests.post(url, json=build_crawler_input(site_cfg), timeout=30)
    return r


def wait_for_run(key, run_id, timeout=1500):
    """Poll run status until finished."""
    start = time.time()
    while time.time() - start < timeout:
        r = requests.get(
            f"https://api.apify.com/v2/actor-runs/{run_id}?token={key}",
            timeout=30
        )
        if r.status_code != 200:
            return None, f"API error {r.status_code}"
        data = r.json().get('data', {})
        status = data.get('status')
        if status in ('SUCCEEDED', 'FAILED', 'ABORTED', 'TIMED_OUT'):
            return status, data
        time.sleep(5)
    return 'TIMED_OUT', None


def get_run_dataset(key, run_id):
    """Get dataset items from a run."""
    # Resolve defaultDatasetId from the run first
    rr = requests.get(
        f"https://api.apify.com/v2/actor-runs/{run_id}?token={key}",
        timeout=30
    )
    if rr.status_code != 200:
        return None
    dataset_id = rr.json().get('data', {}).get('defaultDatasetId')
    if not dataset_id:
        return None
    r = requests.get(
        f"https://api.apify.com/v2/datasets/{dataset_id}/items?token={key}&format=json",
        timeout=60
    )
    if r.status_code != 200:
        return None
    return r.json()


def build_input(site_cfg):
    """Build web-scraper actor input for a site."""
    start_urls = [{'url': u} for u in site_cfg['startUrls']]
    page_function = """
    async function pageFunction(context) {
        const { request, $ } = context;
        const items = [];
        $('a').each(function() {
            const href = $(this).attr('href');
            const text = $(this).text().trim().replace(/\\s+/g, ' ').slice(0, 200);
            if (href && text && text.length > 3) {
                items.push({ url: href, text: text });
            }
        });
        return {
            pageUrl: request.url,
            title: $('title').text().trim(),
            links: items,
        };
    }
    """
    return {
        "startUrls": start_urls,
        "maxPagesPerCrawl": site_cfg['maxPages'],
        "maxPagesPerCrawlDeprecated": site_cfg['maxPages'],
        "pageFunction": page_function,
        "scrollForLazyLoad": site_cfg['scrollForLazyLoad'],
        "proxyConfiguration": {"useApifyProxy": True},
        "runMode": "PRODUCTION",
    }


def normalize_url(url, base):
    """Resolve relative URLs and normalize."""
    if not url:
        return None
    if url.startswith('//'):
        url = 'https:' + url
    if url.startswith('#'):
        return None
    if not url.startswith('http'):
        url = urljoin(base, url)
    parsed = urlparse(url)
    if parsed.netloc == '':
        return None
    return f"{parsed.scheme}://{parsed.netloc}{parsed.path}".rstrip('/')


TOOL_CARD_RE = re.compile(
    r'<a[^>]*data-tool-name="([^"]+)"[^>]*href="([^"]+)"'
)
ANCHOR_RE = re.compile(r'<a[^>]*href="([^"]*)"[^>]*>(.*?)</a>', re.S)


def extract_tools_from_html(html, base_url, site, existing_urls):
    """Extract tool-like links from a crawled page's raw HTML.

    Prefers sites that expose data-tool-name on their tool cards
    (futurepedia, etc.), then falls back to generic anchor parsing.
    """
    if not html:
        return []

    tools = []
    seen_slugs = set()
    site_domains = {urlparse(su).netloc for su in SITES[site]['startUrls']}

    # 1) data-tool-name cards (clean name + url)
    cards = TOOL_CARD_RE.findall(html)
    for name_raw, href in cards:
        name = re.sub(r'\s+', ' ', name_raw).strip()
        resolved = normalize_url(href, base_url)
        if not resolved:
            continue
        parsed = urlparse(resolved)
        domain = parsed.netloc.lower()
        if domain in site_domains:
            continue
        if any(d in domain for d in ['google.com', 'twitter.com', 'x.com', 'facebook.com',
                                     'linkedin.com', 'instagram.com', 'youtube.com',
                                     'reddit.com', 'tiktok.com', 'cdn2.', 'cdn.']):
            continue
        if resolved.lower() in existing_urls:
            continue
        slug = slugify(name)
        if slug in seen_slugs or len(slug) < 3:
            continue
        seen_slugs.add(slug)
        category = categorize(parsed.path + ' ' + name, site)
        pricing = infer_pricing(parsed.path, name)
        tools.append({
            'name': name[:200],
            'slug': slug,
            'description': name,
            'short_desc': name[:100],
            'category': category,
            'pricing': pricing,
            'website_url': resolved,
            'logo_url': get_logo_url(resolved),
            'tags': f"ai,{site}",
            'source': site,
        })

    if tools:
        return tools

    # 1b) trendshift: repos are GitHub links in RSC/HTML
    if site == 'trendshift':
        gh_re = re.compile(r'https://github\.com/([\w\-\.]+)/([\w\-\.]+)')
        seen_repos = set()
        for match in gh_re.finditer(html):
            owner, repo = match.group(1), match.group(2)
            repo_key = f"{owner}/{repo}"
            if repo_key in seen_repos or repo_key in ('login', 'features', 'topics', 'collections'):
                continue
            seen_repos.add(repo_key)
            name = repo.replace('-', ' ').replace('_', ' ').title()
            resolved = f"https://github.com/{owner}/{repo}"
            if resolved.lower() in existing_urls:
                continue
            slug = slugify(name)
            if len(slug) < 3:
                continue
            tools.append({
                'name': name[:200],
                'slug': slug,
                'description': f"{name} — an open source AI project on GitHub.",
                'short_desc': name[:100],
                'category': 'Open Source',
                'pricing': 'free',
                'website_url': resolved,
                'logo_url': get_logo_url(resolved),
                'tags': f"ai,{site},open-source",
                'source': site,
            })
        if tools:
            return tools

    # 2) Generic anchor fallback
    for href, inner in ANCHOR_RE.findall(html):
        text = re.sub(r'<[^>]+>', ' ', inner)
        text = re.sub(r'\s+', ' ', text).strip()[:200]
        if not href or not text or len(text) < 5:
            continue
        resolved = normalize_url(href, base_url)
        if not resolved:
            continue
        parsed = urlparse(resolved)
        domain = parsed.netloc.lower()
        if domain in site_domains or any(d in domain for d in
           ['google.com', 'twitter.com', 'x.com', 'facebook.com', 'linkedin.com',
            'instagram.com', 'youtube.com', 'reddit.com', 'tiktok.com', 'cdn2.', 'cdn.']):
            continue
        if resolved.lower() in existing_urls:
            continue
        name = re.sub(r'\s+', ' ', text)[:200]
        slug = slugify(name)
        if slug in seen_slugs or len(slug) < 3:
            continue
        seen_slugs.add(slug)
        category = categorize(parsed.path + ' ' + name, site)
        pricing = infer_pricing(parsed.path, name)
        tools.append({
            'name': name,
            'slug': slug,
            'description': name,
            'short_desc': name[:100],
            'category': category,
            'pricing': pricing,
            'website_url': resolved,
            'logo_url': get_logo_url(resolved),
            'tags': f"ai,{site}",
            'source': site,
        })
    return tools


def infer_pricing(path, name):
    p = (path + ' ' + name).lower()
    if any(w in p for w in ['pricing', '/pro', '/premium', 'paid']):
        return 'paid'
    if any(w in p for w in ['open source', 'open-source', 'free']):
        return 'free'
    return 'free'


def extract_tools_from_items(items, site, site_url, existing_urls):
    """Extract tool-like links from scraped page items.

    Handles both web-scraper output ({pageUrl, links}) and
    website-content-crawler output ({url, html}).
    """
    tools = []
    seen_slugs = set()
    ignored_domains = {urlparse(su).netloc for su in SITES[site]['startUrls']}

    for item in items:
        if not isinstance(item, dict):
            continue

        # website-content-crawler format: {url, html}
        if item.get('html'):
            page_url = item.get('url', site_url)
            tools.extend(extract_tools_from_html(
                item.get('html'), page_url, site, existing_urls))
            continue

        # web-scraper format: {pageUrl, links}
        page_url = item.get('pageUrl', '')
        links = item.get('links', []) or []

        for link in links:
            href = link.get('url', '')
            text = link.get('text', '').strip()
            if not href or not text or len(text) < 5:
                continue

            resolved = normalize_url(href, page_url or site_url)
            if not resolved:
                continue

            parsed = urlparse(resolved)
            domain = parsed.netloc.lower()

            # Skip directory site's own domain and social/nav links
            if domain in ignored_domains or any(d in domain for d in
               ['google.com', 'twitter.com', 'x.com', 'facebook.com', 'linkedin.com',
                'instagram.com', 'youtube.com', 'reddit.com', 'tiktok.com', 'cdn2.', 'cdn.']):
                continue

            # Skip if already in D1
            if resolved.lower() in existing_urls:
                continue

            name = re.sub(r'\s+', ' ', text)[:200]
            slug = slugify(name)
            if slug in seen_slugs or len(slug) < 3:
                continue

            category = categorize(parsed.path + ' ' + name, site)
            pricing = infer_pricing(parsed.path, name)

            seen_slugs.add(slug)
            tools.append({
                'name': name,
                'slug': slug,
                'description': name,
                'short_desc': name[:100],
                'category': category,
                'pricing': pricing,
                'website_url': resolved,
                'logo_url': get_logo_url(resolved),
                'tags': f"ai,{site}",
                'source': site,
            })

    return tools


def categorize(text, site):
    t = text.lower()
    if site in ('trendshift',):
        return 'Open Source'
    if site == 'futurepedia':
        return 'AI Tools'
    if any(w in t for w in ['coding', 'dev', 'programming', 'code', 'developer', 'vscode', 'cursor', 'api']):
        return 'Coding'
    if any(w in t for w in ['image', 'photo', 'art', 'design', 'generate', 'logo', 'designer']):
        return 'Image'
    if any(w in t for w in ['video', 'animation', 'editor']):
        return 'Video'
    if any(w in t for w in ['audio', 'music', 'sound', 'voice', 'tts', 'speech']):
        return 'Audio'
    if any(w in t for w in ['chat', 'conversat', 'assistant', 'llm', 'gpt', 'claude', 'copilot']):
        return 'Chat'
    if any(w in t for w in ['research', 'search', 'academic', 'paper']):
        return 'Research'
    if any(w in t for w in ['marketing', 'seo', 'social', 'advertis', 'email', 'copy']):
        return 'Marketing'
    if any(w in t for w in ['finance', 'money', 'invest', 'crypto', 'trading']):
        return 'Finance'
    if any(w in t for w in ['writing', 'content', 'blog', 'essay']):
        return 'Writing'
    if any(w in t for w in ['education', 'learn', 'course', 'teach', 'study']):
        return 'Education'
    if any(w in t for w in ['automation', 'workflow', 'process', 'agent']):
        return 'Automation'
    if any(w in t for w in ['analytics', 'data', 'insight', 'metric', 'dashboard']):
        return 'Analytics'
    if any(w in t for w in ['business', 'productivity', 'project', 'management', 'team']):
        return 'Business'
    if any(w in t for w in ['health', 'medical', 'fitness']):
        return 'Health'
    return 'AI Tools'


def process_site(site):
    """Run the scraper for a single site and insert new tools."""
    site_cfg = SITES[site]
    primary_key = SITE_KEYS[site]
    key_name, key_val = pick_key(primary_key, site)
    fallback_log = load_fallback_log()
    used_fallback = key_name != primary_key

    log(f"--- {site}: primary={primary_key}, using={key_name}{' (FALLBACK)' if used_fallback else ''}")

    if used_fallback:
        entry = fallback_log.get(key_name, {})
        entry['sites'] = entry.get('sites', []) + [site]
        entry['last_used'] = datetime.utcnow().strftime('%Y-%m-%dT%H:%M:%SZ')
        fallback_log[key_name] = entry
        save_fallback_log(fallback_log)

    # Start run with web-scraper
    payload = build_input(site_cfg)
    r = start_actor_run(key_val, payload)

    used_crawler = False

    if r.status_code == 402:
        log(f"  QUOTA EXHAUSTED on {key_name} for {site}, trying fallback")
        fallback_log[key_name] = {
            'quota_exhausted_date': datetime.utcnow().strftime('%Y-%m-%d'),
            'sites': fallback_log.get(key_name, {}).get('sites', []) + [site],
        }
        save_fallback_log(fallback_log)
        # Try next key
        for alt_name, alt_val in [('key4', APIFY_KEYS['key4']), ('key1', APIFY_KEYS['key1']),
                                  ('key2', APIFY_KEYS['key2']), ('key3', APIFY_KEYS['key3'])]:
            if alt_name == key_name or alt_name in USED_KEYS:
                continue
            if not alt_val:
                continue
            log(f"  Fallback to {alt_name}")
            key_name, key_val = alt_name, alt_val
            USED_KEYS.add(alt_name)
            entry = fallback_log.get(alt_name, {})
            entry['sites'] = entry.get('sites', []) + [site]
            entry['last_used'] = datetime.utcnow().strftime('%Y-%m-%dT%H:%M:%SZ')
            fallback_log[alt_name] = entry
            save_fallback_log(fallback_log)
            r = start_actor_run(key_val, payload)
            break

    if r.status_code == 402:
        log(f"  SKIP {site}: all keys quota exhausted")
        return {'site': site, 'key': key_name, 'scraped': 0, 'inserted': 0, 'd1_total': get_d1_count(), 'status': 'quota'}

    # 403 full-permission-actor-not-approved: fall back to website-content-crawler
    if r.status_code == 403:
        log(f"  web-scraper requires approval on {key_name}; using website-content-crawler fallback")
        r = start_crawler_run(key_val, site_cfg)
        used_crawler = True

    if r.status_code != 201 and r.status_code != 200:
        log(f"  SKIP {site}: API returned {r.status_code}: {r.text[:200]}")
        return {'site': site, 'key': key_name, 'scraped': 0, 'inserted': 0, 'd1_total': get_d1_count(), 'status': f'error:{r.status_code}'}

    run_id = r.json().get('data', {}).get('id')
    if not run_id:
        log(f"  SKIP {site}: no run id")
        return {'site': site, 'key': key_name, 'scraped': 0, 'inserted': 0, 'd1_total': get_d1_count(), 'status': 'error:no-run'}

    log(f"  Run {run_id} started, waiting...")
    status, data = wait_for_run(key_val, run_id)

    if status != 'SUCCEEDED':
        log(f"  SKIP {site}: run {status}")
        return {'site': site, 'key': key_name, 'scraped': 0, 'inserted': 0, 'd1_total': get_d1_count(), 'status': status}

    items = get_run_dataset(key_val, run_id)
    if items is None:
        log(f"  SKIP {site}: no dataset")
        return {'site': site, 'key': key_name, 'scraped': 0, 'inserted': 0, 'd1_total': get_d1_count(), 'status': 'error:no-dataset'}

    # Dedupe against existing D1 URLs
    existing_urls = get_existing_urls()
    site_url = site_cfg['startUrls'][0]
    tools = extract_tools_from_items(items, site, site_url, existing_urls)

    log(f"  Scraped {len(tools)} potential tools")

    # Filter out low-quality names (pure numbers, nav words)
    filtered = []
    skip_words = {'home', 'about', 'contact', 'pricing', 'sign in', 'sign up', 'login',
                  'logout', 'privacy', 'terms', 'search', 'menu', 'more', 'read more',
                  'newsletter', 'subscribe', 'categories', 'tags', 'blog', 'faq', 'help',
                  'jobs', 'careers', 'press', 'team', 'partners', 'back to top'}
    for t in tools:
        name_l = t['name'].lower().strip()
        if name_l in skip_words or len(name_l) < 4:
            continue
        if re.match(r'^[\d\W_]+$', t['name']):
            continue
        filtered.append(t)

    inserted, failed = batch_insert(filtered)
    d1_total = get_d1_count()

    log(f"  Result: {len(filtered)} scraped, {inserted} new inserted, D1={d1_total}")

    return {
        'site': site,
        'key': key_name,
        'used_fallback': used_fallback,
        'used_crawler': used_crawler,
        'scraped': len(filtered),
        'inserted': inserted,
        'failed': failed,
        'd1_total': d1_total,
        'status': 'ok',
    }


def main():
    all_results = []
    for site in SITES:
        result = process_site(site)
        all_results.append(result)
        # Save progress
        save_progress({'sources_completed': all_results})
        time.sleep(2)

    print("\n" + "=" * 60)
    print("APIFY SCRAPER SUMMARY")
    print("=" * 60)
    print(f"{'Site':<12} {'Key':<6} {'Fallback':<9} {'Crawler':<8} {'Scraped':<8} {'Inserted':<8} {'D1':<8} {'Status'}")
    print("-" * 60)
    for r in all_results:
        print(f"{r['site']:<12} {r.get('key','?'):<6} {str(r.get('used_fallback', False)):<9} {str(r.get('used_crawler', False)):<8} {r.get('scraped',0):<8} {r.get('inserted',0):<8} {r.get('d1_total','?'):<8} {r.get('status','?')}")

    total_scraped = sum(r.get('scraped', 0) for r in all_results)
    total_inserted = sum(r.get('inserted', 0) for r in all_results)
    print(f"\nTotal scraped: {total_scraped}, Total inserted: {total_inserted}")
    print(f"Fallback log: {json.dumps(load_fallback_log(), indent=2)}")


if __name__ == '__main__':
    main()
