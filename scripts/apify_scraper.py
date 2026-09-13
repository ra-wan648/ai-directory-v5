#!/usr/bin/env python3
"""
Apify-based AI Tools Scraper
Uses the apify/web-scraper actor with any number of API keys (APIFY_KEY_1..N),
auto-distributed site assignments, and quota-aware fallback rotation.
Inserts new tools into remote D1 via wrangler.
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

import validate

# ─────────────────────────────────────────────
# Configuration
# ─────────────────────────────────────────────
APIFY_KEY_SLOTS = int(os.environ.get('APIFY_KEY_SLOTS', '12'))


def _load_apify_keys():
    """Read APIFY_KEY_1..APIFY_KEY_N from the environment, skipping holes.

    Any number of keys works: one for a solo run, or many when several people
    pool their Apify quota. Slots may be left empty on purpose — a gap must not
    hide the keys after it, otherwise one revoked token silently disables the
    whole rest of the pool and the run quietly shrinks to fewer keys.
    """
    keys = {}
    for i in range(1, APIFY_KEY_SLOTS + 1):
        val = (os.environ.get(f'APIFY_KEY_{i}') or '').strip()
        if val:
            keys[f'key{i}'] = val
    return keys


APIFY_KEYS = _load_apify_keys()
KEY_ORDER = list(APIFY_KEYS.keys())

if not APIFY_KEYS:
    raise SystemExit(
        'No Apify keys found. Set APIFY_KEY_1 '
        '(APIFY_KEY_2, APIFY_KEY_3, ... are optional but must not have gaps).'
    )

# SITE_KEYS is derived from the available keys just below, once SITES is defined.
SITE_KEYS = {}

# Page budgets are deliberately shallow. Every one of these directories lists
# its newest tools first, so a run only has to reach far enough to cover what
# appeared since the last run - the deep tail is stuff we already have. Run 1
# proved the point: 10,470 of the 12,000 scraped URLs were duplicates. Apify
# bills by compute time, so pages we do not need are money burnt. If a site ever
# reorders to "oldest first" this breaks, and the silent-source alert will say so.
SITES = {
    'toolify': {
        'startUrls': ['https://www.toolify.ai/'],
        'maxPages': 15,          # was 50
        'scrollForLazyLoad': False,
    },
    'futurepedia': {
        'startUrls': ['https://www.futurepedia.io/ai-tools'],
        'maxPages': 10,          # was 20
        'scrollForLazyLoad': True,
    },
    'taaft': {
        'startUrls': ['https://theresanaiforthat.com/'],
        'maxPages': 15,          # was 30
        'scrollForLazyLoad': False,
    },
    'allthingsai': {
        'startUrls': ['https://allthingsai.com/'],
        'maxPages': 5,           # was 10
        'scrollForLazyLoad': False,
    },
    'futuretools': {
        'startUrls': ['https://www.futuretools.io/'],
        'maxPages': 10,          # was 20
        'scrollForLazyLoad': False,
    },
    'topai': {
        'startUrls': ['https://topai.tools/'],
        'maxPages': 10,          # was 30
        'scrollForLazyLoad': False,
    },
    'aixploria': {
        'startUrls': ['https://www.aixploria.com/en/'],
        'maxPages': 10,          # was 20
        'scrollForLazyLoad': False,
    },
    'insidr': {
        'startUrls': ['https://www.insidr.ai/ai-tools/'],
        'maxPages': 5,           # was 20
        'scrollForLazyLoad': False,
    },
    'toolfk': {
        'startUrls': ['https://www.toolfk.com/'],
        'maxPages': 10,          # was 20
        'scrollForLazyLoad': False,
    },
    # trendshift.io is now covered for free by Source G in fresh_data_pipeline,
    # so paying Apify for the same page is wasted budget.
    'trendshift': {
        'startUrls': ['https://trendshift.io/'],
        'maxPages': 5,           # was 20
        'scrollForLazyLoad': False,
    },
}

# ─────────────────────────────────────────────
# Crawl cadence
# ─────────────────────────────────────────────
# Measured over one full 10-site run ($1.4421, 245 new tools):
#   toolify + taaft produced 244 of those 245 tools for 35% of the budget,
#   while insidr cost $0.5659 (39% of the budget) and produced nothing.
# So the two producers run nightly, the long tail runs weekly, and insidr is
# off. Daily freshness still comes from fresh_data_pipeline.py, which spends no
# Apify credit at all. See FULL-PLAN.md sections 2-3.
WEEKLY_WEEKDAY = 6          # Sunday (Monday=0 ... Sunday=6)
CADENCE = {
    'toolify':     'daily',
    'taaft':       'daily',
    'futurepedia': 'weekly',
    # trendshift runs free via Source G (GitHub API), so Apify stays off it.
    'trendshift':  'off',
    'toolfk':      'weekly',
    'aixploria':   'weekly',
    'futuretools': 'weekly',
    'topai':       'weekly',
    'allthingsai': 'weekly',
    'insidr':      'off',
}


def should_run(site, weekday=None):
    """Is this site due today? Returns (bool, reason)."""
    cadence = CADENCE.get(site, 'daily')
    if weekday is None:
        weekday = datetime.utcnow().weekday()
    if cadence == 'off':
        return False, 'cadence=off'
    if cadence == 'weekly' and weekday != WEEKLY_WEEKDAY:
        return False, 'cadence=weekly (Sundays only)'
    return True, f'cadence={cadence}'


# ─────────────────────────────────────────────
# Key distribution
# ─────────────────────────────────────────────
def _key_headroom(key):
    """Remaining monthly spend for one key, in USD. None when unknown."""
    try:
        r = requests.get(f'https://api.apify.com/v2/users/me/limits?token={key}',
                         timeout=20)
        if r.status_code != 200:
            return None
        d = r.json().get('data', {})
        cap = (d.get('limits') or {}).get('maxMonthlyUsageUsd')
        used = (d.get('current') or {}).get('monthlyUsageUsd') or 0
        if cap is None:
            return None
        return max(0.0, float(cap) - float(used))
    except Exception:
        return None


def build_key_slots():
    """Turn the key list into a weighted rotation.

    Free keys do not all carry the same allowance ($5 and $10 here), and a key
    that has already spent most of its budget must not be handed the same share
    as a fresh one. Each key is weighted by its *remaining* budget, normalised
    so an average key gets one slot, and a key that is out of budget drops out
    of the rotation. Costs are per run, so this is recomputed on every run.
    """
    headroom = {name: _key_headroom(APIFY_KEYS[name]) for name in KEY_ORDER}
    known = [v for v in headroom.values() if v is not None]
    slots = []
    if not known:
        log('Key budgets unknown - falling back to an even rotation')
        return [k for k in KEY_ORDER], headroom
    average = sum(known) / len(known)
    for name in KEY_ORDER:
        h = headroom[name]
        if h is None:
            shares = 1                       # unknown budget: treat as average
        elif h <= 0:
            shares = 0                       # spent up: skip this key entirely
        else:
            shares = max(1, min(4, round(h / average)))
        log(f'  {name}: ${h:.2f} left' if h is not None else f'  {name}: budget unknown'
            f' -> {shares} slot(s)')
        slots.extend([name] * shares)
    return (slots or list(KEY_ORDER)), headroom


# Spread the sites over the keys, heaviest crawl first, and rotate the whole
# assignment one step per day. A fixed assignment is unsafe once the schedule is
# cost-weighted: toolify alone spends ~$6.65/month, which is more than a free
# key's cap, so it must not land on the same key every night.
_sites_by_load = sorted(SITES.keys(), key=lambda s: SITES[s]['maxPages'], reverse=True)
KEY_SLOTS = None          # filled in main(), once logging is available
_nightly_shift = datetime.utcnow().timetuple().tm_yday
SITE_KEYS = {
    site: KEY_ORDER[(i + _nightly_shift) % len(KEY_ORDER)]
    for i, site in enumerate(_sites_by_load)
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


_EXISTING_URLS_CACHE = None


def get_existing_urls():
    """Fetch all existing website_url values from D1, once per run.

    Cached on purpose. This used to be called inside the per-site loop, so a
    Sunday run re-read the whole table nine times - 12,326 rows a go - and that
    repeated scanning is what burned through D1's free-tier daily row-read
    limit. The set only grows as we insert, and new rows are added to it by the
    caller, so one read up front is correct.

    Fails loudly rather than returning an empty set: once the daily read limit
    is hit every read errors out, and an empty set would make every scraped tool
    look new and insert duplicates by the thousand.
    """
    global _EXISTING_URLS_CACHE
    if _EXISTING_URLS_CACHE is not None:
        return set(_EXISTING_URLS_CACHE)

    env = d1_env()
    r = subprocess.run(
        ['wrangler', 'd1', 'execute', DB_NAME, '--remote', '--json',
         '--command', "SELECT url FROM tools WHERE status='published'"],
        capture_output=True, text=True, timeout=60, env=env
    )
    rows = None
    try:
        data = json.loads(r.stdout)
        if isinstance(data, list) and data and isinstance(data[0], dict):
            rows = data[0].get('results')
        elif isinstance(data, dict):
            rows = data.get('results') or (data.get('result') or {}).get('results')
    except Exception:
        rows = None

    if rows is None:
        detail = (r.stdout or r.stderr or '').strip()[:300]
        raise RuntimeError(
            'could not read existing URLs from D1 (row-read limit or auth?) - '
            f'refusing to continue rather than insert duplicates. Said: {detail}'
        )

    _EXISTING_URLS_CACHE = {(row.get('url') or '').strip().lower()
                            for row in rows if row.get('url')}
    log(f"  loaded {len(_EXISTING_URLS_CACHE)} existing URLs from D1 (cached for this run)")
    return set(_EXISTING_URLS_CACHE)


_D1_COUNT_CACHE = None


def get_d1_count():
    """Published tool count, read at most once per run.

    Every COUNT(*) here scans the whole table and D1's free tier bills by rows
    read. This is called from each site's return value, so an uncached version
    meant a Sunday run counted the same 12k rows nine times over - part of what
    exhausted the daily row-read limit.
    """
    global _D1_COUNT_CACHE
    if _D1_COUNT_CACHE is not None:
        return _D1_COUNT_CACHE
    env = d1_env()
    r = subprocess.run(
        ['wrangler', 'd1', 'execute', DB_NAME, '--remote', '--json',
         '--command', "SELECT COUNT(*) as c FROM tools WHERE status='published'"],
        capture_output=True, text=True, timeout=60, env=env
    )
    try:
        data = json.loads(r.stdout)
        if isinstance(data, list) and data and data[0].get('results'):
            _D1_COUNT_CACHE = data[0]['results'][0]['c']
            return _D1_COUNT_CACHE
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
        sql = f"INSERT OR IGNORE INTO tools (name, slug, description, short_desc, category, pricing, url, logo_url, logo_type, tags, status, created_at) VALUES {', '.join(chunk)}"
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

    # Ordered fallback: try every configured key, never reuse one already used today
    key_order = [primary_key] + [k for k in KEY_ORDER if k != primary_key]

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
    # Plain DOM APIs, not jQuery. The previous version reached for `$(this)`
    # inside the .each() callback, where `$` is not callable, and the Actor
    # failed every request with "TypeError: $ is not a function" after three
    # retries -- a successful run that silently produced zero items. That went
    # unnoticed because the crawler fallback was covering for it.
    # Kept as a raw string so the regex escape survives into the Actor input.
    page_function = r"""
    async function pageFunction(context) {
        const { request } = context;
        const items = [];
        const anchors = document.querySelectorAll('a[href]');
        for (const a of anchors) {
            const href = a.getAttribute('href');
            const text = (a.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 200);
            if (href && text.length > 3) {
                items.push({ url: href, text: text });
            }
        }
        return {
            pageUrl: request.url,
            title: (document.title || '').trim(),
            links: items,
        };
    }
    """
    # Without these the Actor reads only the start URL and stops: a run that
    # reported SUCCEEDED returned 7 links where the content crawler had pulled
    # 259 from the same site. These let it walk the site's own links
    # (pagination, tool pages) up to maxPagesPerCrawl.
    host = urlparse(site_cfg['startUrls'][0]).netloc

    return {
        "startUrls": start_urls,
        "maxPagesPerCrawl": site_cfg['maxPages'],
        "maxPagesPerCrawlDeprecated": site_cfg['maxPages'],
        "pageFunction": page_function,
        "linkSelector": "a[href]",
        "pseudoUrls": [{"purl": f"https://{host}/.*"}],
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

    # The content crawler leads. It is empirically the productive route: on
    # toolify it pulled 259 items where the web-scraper returned 7-9, because it
    # reads the full HTML of every page it follows and our parser understands
    # that shape directly. The web-scraper stays as the fallback.
    payload = build_input(site_cfg)
    used_crawler = True
    log("  starting website-content-crawler (primary)")
    r = start_crawler_run(key_val, site_cfg)
    if r.status_code not in (200, 201):
        log(f"  crawler would not start ({r.status_code}); falling back to web-scraper")
        used_crawler = False
        r = start_actor_run(key_val, payload)

    if r.status_code == 402:
        log(f"  QUOTA EXHAUSTED on {key_name} for {site}, trying fallback")
        fallback_log[key_name] = {
            'quota_exhausted_date': datetime.utcnow().strftime('%Y-%m-%d'),
            'sites': fallback_log.get(key_name, {}).get('sites', []) + [site],
        }
        save_fallback_log(fallback_log)
        # Try next key
        for alt_name in KEY_ORDER:
            alt_val = APIFY_KEYS.get(alt_name, '')
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
            # retry with whichever actor this site is using
            r = (start_crawler_run(key_val, site_cfg) if used_crawler
                 else start_actor_run(key_val, payload))
            break

    if r.status_code == 402:
        log(f"  SKIP {site}: all keys quota exhausted")
        return {'site': site, 'key': key_name, 'scraped': 0, 'inserted': 0, 'd1_total': get_d1_count(), 'status': 'quota'}

    # 403 full-permission-actor-not-approved. Since May 2026 Apify makes
    # full-permission Actors require a one-time approval *per account*, and the
    # error body carries an approvalUrl. Surface that link so the account owner
    # can just click it, instead of silently falling back to the crawler.
    if r.status_code == 403:
        approval = ''
        try:
            err = (r.json() or {}).get('error', {}) or {}
            data = err.get('data') or {}
            approval = data.get('approvalUrl') or err.get('approvalUrl') or ''
        except Exception:
            pass
        if not approval:
            m = re.search(r'https://console\.apify\.com/\S+', r.text or '')
            approval = m.group(0).rstrip('",}').rstrip('\\') if m else ''
        log(f"  web-scraper needs ONE-TIME approval on {key_name} "
            f"-> using website-content-crawler fallback")
        if approval:
            log(f"    approve it here: {approval}")
        else:
            log("    approve it on the apify~web-scraper page in Apify Console")
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

    # A web-scraper run can report SUCCEEDED while having read only the start
    # page, which looks identical to a site that genuinely has nothing new.
    # If it came back empty, try the same site once through the content
    # crawler, which returns full HTML that this same parser also understands.
    if not tools and used_crawler:
        log("  crawler returned nothing; retrying via web-scraper")
        r2 = start_actor_run(key_val, build_input(site_cfg))
        if r2.status_code in (200, 201):
            rid2 = (r2.json().get('data') or {}).get('id')
            if rid2:
                st2, _ = wait_for_run(key_val, rid2)
                if st2 == 'SUCCEEDED':
                    items2 = get_run_dataset(key_val, rid2)
                    if items2:
                        items = items2
                        tools = extract_tools_from_items(items2, site, site_url,
                                                         existing_urls)
                        log(f"  web-scraper retry recovered {len(tools)} potential tools")
        else:
            log(f"  web-scraper retry could not start ({r2.status_code})")

    log(f"  Scraped {len(tools)} potential tools")

    # Validation lives in validate.py so both scrapers share one rule set, and
    # every rejection carries a reason. The thin checks that stood here let
    # '";> API' and 'cloudflare.com' through onto the live site.
    filtered, rejected = validate.filter_rows(tools)
    if rejected:
        log(f"  dropped {sum(rejected.values())} low-quality row(s): "
            + ', '.join(f'{k}={v}' for k, v in sorted(rejected.items())))

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
    global SITE_KEYS, KEY_SLOTS
    log(f"Apify keys detected: {len(KEY_ORDER)} ({', '.join(KEY_ORDER)})")
    log("Key budgets -> rotation slots:")
    KEY_SLOTS, _ = build_key_slots()
    SITE_KEYS = {
        site: KEY_SLOTS[(i + _nightly_shift) % len(KEY_SLOTS)]
        for i, site in enumerate(_sites_by_load)
    }
    log(f"Site -> key distribution: {json.dumps(SITE_KEYS)}")
    all_results = []
    for site in SITES:
        due, why = should_run(site)
        if not due:
            log(f"--- {site}: skipped ({why})")
            continue
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

    # Feed the Telegram report. A site that is due and returns nothing is the
    # failure worth shouting about: toolify once came back with 0 items from a
    # 2-minute crawl after a normal run had pulled 259 from it.
    silent = []
    try:
        path = '/tmp/source_health.json'
        try:
            with open(path) as f:
                health = json.load(f)
        except Exception:
            health = {}
        for r in all_results:
            due, why = should_run(r['site'])
            fresh = r.get('inserted', 0)
            health[f"apify:{r['site']}"] = {
                'scraped': r.get('scraped', 0),
                'fresh': fresh,
                'articles': 0,
                'status': 'ok' if fresh or r.get('scraped', 0) else 'silent',
            }
            if not r.get('scraped', 0):
                silent.append(r['site'])
        if not all_results:
            health['apify:all'] = {'scraped': 0, 'fresh': 0, 'articles': 0,
                                   'status': 'silent'}
        with open(path, 'w') as f:
            json.dump(health, f)
    except Exception as e:
        print(f"  (source health not recorded: {e})")

    if silent:
        print(f"\n!! SILENT SITES (due but scraped 0): {', '.join(silent)}")
        print("   Check the actor approval and whether the site changed its markup.")


if __name__ == '__main__':
    main()
