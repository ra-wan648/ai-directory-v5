#!/usr/bin/env python3
"""
Fresh AI Tools Pipeline
Collects new AI tools from Product Hunt, HuggingFace, GitHub, HN Algolia,
and RSS feeds. Inserts new tools into remote D1 via wrangler.

Sources (Task 3):
  - Product Hunt GraphQL: top 50 AI posts in last 30 days
  - HuggingFace models (downloads > 100k, max 200) + spaces (likes > 50, max 200)
  - GitHub: topic:ai-tools + topic:llm+topic:tool, stars > 100
  - HN Algolia: points > 30
  - RSS: tldr.tech/ai + bensbites + therundown
"""

import os
import re
import json
import time
import subprocess
from urllib.parse import urlparse, quote
from datetime import datetime, timedelta

import requests

CF_API_TOKEN = os.environ.get('CF_API_TOKEN', '')
CF_ACCOUNT_ID = os.environ.get('CLOUDFLARE_ACCOUNT_ID', '')
CF_D1_ID = 'ff26faf5-3c7c-445a-a249-6c96fedddfdc'
DB_NAME = 'ai-directory-db'

PROGRESS_FILE = '/tmp/fresh_data_progress.json'
DEDUP_FILE = '/tmp/fresh_data_dedup.json'


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


def d1_env():
    env = os.environ.copy()
    env['CF_API_TOKEN'] = CF_API_TOKEN
    env['CLOUDFLARE_API_TOKEN'] = CF_API_TOKEN
    env['CLOUDFLARE_ACCOUNT_ID'] = CF_ACCOUNT_ID
    return env


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


def get_existing_urls():
    """Fetch all existing website_url values from D1.

    Fails loudly instead of returning an empty set. D1's free tier has a daily
    row-read limit, and once it is hit every read fails - we saw that on
    12 Sep, which is what made the pipeline report "Published: 0" while the
    table still held 12,326 rows. If this quietly returned empty, every scraped
    tool would look brand new: thousands of duplicate inserts, and the write
    quota burned with them. Refusing to run is the safer failure.
    """
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

    return {(row.get('url') or '').strip().lower()
            for row in rows if row.get('url')}


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


# Blog/news feeds produce articles, not tools. Their URLs live on news domains.
NEWS_DOMAINS = (
    'news.ycombinator.com', 'bensbites.com', 'tldr.tech', 'therundown.ai',
    'commentary', 'arxiv.org', 'nature.com', 'bloomberg.com', 'techcrunch.com',
    'youtube.com', 'davidepiffer.com', 'netflixtechblog.com', 'lists.debian.org',
    'cnn.com', 'bbc.com', 'wired.com', 'theverge.com', 'medium.com',
)


def is_real_tool_url(url):
    """Return True if the URL points to a real tool website (not a news host)."""
    try:
        host = urlparse(url).netloc.lower()
    except Exception:
        return False
    if not host:
        return False
    if host == 'x.ai' or host == 'openai.com':
        return True
    for d in NEWS_DOMAINS:
        if d in host:
            return False
    return True


def batch_insert_blogs(blogs_batch):
    """Batch insert articles into the blogs table."""
    if not blogs_batch:
        return 0, 0
    env = d1_env()
    values = []
    now = datetime.utcnow().strftime('%Y-%m-%d %H:%M:%S')
    for blog in blogs_batch:
        title = escape_sql(blog['title'])
        slug = escape_sql(blog['slug'])
        content = escape_sql(blog.get('content', '')[:8000])
        meta = escape_sql(blog.get('meta_description', '')[:255])
        cat = escape_sql(blog.get('category', 'news'))
        tool_slug = escape_sql(blog.get('tool_slug', ''))
        values.append(f"('{title}', '{slug}', '{content}', '{meta}', '{cat}', '{tool_slug}', 'published', '{now}', '{now}')")

    if not values:
        return 0, 0

    total_inserted = 0
    for i in range(0, len(values), 30):
        chunk = values[i:i+30]
        sql = (f"INSERT INTO blogs (title, slug, content, meta_description, category, tool_slug, status, published_at, created_at) "
               f"VALUES {', '.join(chunk)} ON CONFLICT(slug) DO NOTHING")
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

    return total_inserted, len(blogs_batch) - total_inserted


def dedupe_key(url):
    try:
        parsed = urlparse(url)
        return hashlib_md5(parsed.netloc.lower().encode() + parsed.path.encode())
    except Exception:
        return hashlib_md5(url.encode())


def hashlib_md5(data):
    import hashlib
    return hashlib.md5(data).hexdigest()


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


# ─────────────────────────────────────────────
# Category / pricing inference
# ─────────────────────────────────────────────
def categorize(text):
    t = (text or '').lower()
    if any(w in t for w in ['coding', 'dev', 'programming', 'code', 'developer', 'vscode', 'cursor', 'api', 'framework', 'sdk']):
        return 'Coding'
    if any(w in t for w in ['image', 'photo', 'art', 'design', 'generat', 'logo']):
        return 'Image'
    if any(w in t for w in ['video', 'animation', 'editor', 'movie']):
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


# ─────────────────────────────────────────────
# Product Hunt GraphQL
# ─────────────────────────────────────────────
PH_URL = 'https://api.producthunt.com/v2/api/graphql'
PH_TOKEN = os.environ.get('PRODUCT_HUNT_KEY', '')
PH_SECRET = os.environ.get('PRODUCT_HUNT_SECRET', '')


def ph_get_access_token():
    """Exchange client credentials for a bearer token."""
    if not PH_TOKEN or not PH_SECRET:
        return None
    try:
        r = requests.post(
            'https://api.producthunt.com/v2/oauth/token',
            json={
                'client_id': PH_TOKEN,
                'client_secret': PH_SECRET,
                'grant_type': 'client_credentials',
            },
            timeout=20
        )
        if r.status_code == 200:
            return r.json().get('access_token')
    except Exception as e:
        log(f"    Token exchange error: {e}")
    return None


def scrape_product_hunt():
    tools = []
    log("  Source A: Product Hunt")
    if not PH_TOKEN or not PH_SECRET:
        log("    SKIP: PRODUCT_HUNT_KEY/SECRET not set")
        return tools, 'product_hunt'

    access_token = ph_get_access_token()
    if not access_token:
        log("    SKIP: could not obtain access token")
        return tools, 'product_hunt'

    since = (datetime.utcnow() - timedelta(days=30)).date().isoformat()
    query = """
    query {
      posts(order: RANKING, first: 50, postedAfter: "%s") {
        edges { node {
          name
          tagline
          url
          website
          votesCount
          commentsCount
          topics { edges { node { name } } }
        } }
      }
    }
    """ % since

    headers = {
        'Authorization': f'Bearer {access_token}',
        'Content-Type': 'application/json',
        'Accept': 'application/json',
    }
    try:
        r = requests.post(PH_URL, json={'query': query}, headers=headers, timeout=30)
        if r.status_code != 200:
            log(f"    API error {r.status_code}: {r.text[:150]}")
            return tools, 'product_hunt'
        data = r.json()
        if 'errors' in data:
            log(f"    GraphQL errors: {str(data['errors'])[:200]}")
            return tools, 'product_hunt'
        edges = data.get('data', {}).get('posts', {}).get('edges', [])
        for edge in edges:
            node = edge.get('node', {})
            name = node.get('name', '')
            website = node.get('website') or node.get('url') or ''
            votes = node.get('votesCount', 0)
            tagline = node.get('tagline', '')
            if not name or not website:
                continue
            topics = [t.get('node', {}).get('name', '') for t in node.get('topics', {}).get('edges', [])]
            topic_text = ' '.join(topics)
            category = categorize(topic_text + ' ' + tagline + ' ' + name)
            # is_trending if votes > 200; Freemium if votes > 500 else Free
            if votes > 500:
                pricing = 'freemium'
            else:
                pricing = 'free'
            tools.append({
                'name': name,
                'slug': slugify(name),
                'description': tagline or f"{name} — launched on Product Hunt.",
                'short_desc': (tagline or name)[:100],
                'category': category,
                'pricing': pricing,
                'website_url': website,
                'logo_url': get_logo_url(website),
                'tags': f"ai,product-hunt,tool",
                'source': 'product_hunt',
                'votes': votes,
            })
        log(f"    Found {len(tools)} posts")
    except Exception as e:
        log(f"    Error: {e}")
    return tools, 'product_hunt'


# ─────────────────────────────────────────────
# HuggingFace
# ─────────────────────────────────────────────
HF_PIPELINE_MAP = {
    'text-generation': 'Chat', 'text2text-generation': 'Writing', 'summarization': 'Writing',
    'translation': 'Writing', 'image-generation': 'Image', 'text-to-image': 'Image',
    'image-to-image': 'Image', 'image-classification': 'Image', 'object-detection': 'Image',
    'image-segmentation': 'Image', 'text-to-video': 'Video', 'video-generation': 'Video',
    'text-to-audio': 'Audio', 'text-to-speech': 'Audio', 'speech-recognition': 'Audio',
    'audio-classification': 'Audio', 'automatic-speech-recognition': 'Audio',
    'question-answering': 'Research', 'text-classification': 'Analytics',
    'token-classification': 'Analytics', 'feature-extraction': 'Coding',
    'sentence-similarity': 'Analytics', 'code-generation': 'Coding',
    'fill-mask': 'Writing', 'zero-shot-classification': 'Analytics',
    'table-question-answering': 'Analytics', 'conversational': 'Chat',
    'robotics': 'Automation', 'reinforcement-learning': 'Automation',
    'other': 'AI Tools',
}


def scrape_huggingface():
    tools = []
    log("  Source B: HuggingFace")
    try:
        # Models with downloads > 100k, sorted by downloads, max 200
        models_url = ("https://huggingface.co/api/models?sort=downloads&direction=-1"
                      "&limit=200")
        r = requests.get(models_url, timeout=30)
        if r.status_code == 200:
            models = r.json()
            count = 0
            for m in models:
                downloads = m.get('downloads', 0)
                if downloads < 100000:
                    continue
                pipeline = m.get('pipeline_tag', '') or 'other'
                if pipeline == 'other':
                    continue
                name = m.get('modelId', '') or m.get('id', '')
                if not name:
                    continue
                category = HF_PIPELINE_MAP.get(pipeline, 'AI Tools')
                display = name.split('/')[-1].replace('-', ' ').replace('_', ' ').title()
                desc = m.get('cardData', {}).get('short_description', '') or \
                       m.get('cardData', {}).get('description', '') or \
                       f"HuggingFace model {name} ({pipeline})."
                tools.append({
                    'name': display[:200],
                    'slug': slugify(display),
                    'description': str(desc)[:2000],
                    'short_desc': str(desc)[:100],
                    'category': category,
                    'pricing': 'free',
                    'website_url': f"https://huggingface.co/{name}",
                    'logo_url': get_logo_url(f"https://huggingface.co/{name}"),
                    'tags': f"ai,huggingface,{pipeline}",
                    'source': 'huggingface',
                })
                count += 1
                if count >= 200:
                    break
            log(f"    Models: {count}")
        else:
            log(f"    Models API error {r.status_code}")

        # Spaces with likes > 50, max 200
        spaces_url = "https://huggingface.co/api/spaces?sort=likes&direction=-1&limit=200"
        r2 = requests.get(spaces_url, timeout=30)
        if r2.status_code == 200:
            spaces = r2.json()
            count = 0
            for s in spaces:
                likes = s.get('likes', 0)
                if likes < 50:
                    continue
                name = s.get('subdir', '') or s.get('id', '')
                if not name:
                    continue
                pipeline = s.get('sdk', '') or 'other'
                category = HF_PIPELINE_MAP.get(pipeline, 'AI Tools')
                display = name.split('/')[-1].replace('-', ' ').replace('_', ' ').title()
                desc = s.get('cardData', {}).get('short_description', '') or \
                       s.get('cardData', {}).get('description', '') or \
                       f"HuggingFace Space {name}."
                tools.append({
                    'name': display[:200],
                    'slug': slugify(display),
                    'description': str(desc)[:2000],
                    'short_desc': str(desc)[:100],
                    'category': category,
                    'pricing': 'free',
                    'website_url': f"https://huggingface.co/spaces/{name}",
                    'logo_url': get_logo_url(f"https://huggingface.co/spaces/{name}"),
                    'tags': f"ai,huggingface,space",
                    'source': 'huggingface',
                })
                count += 1
                if count >= 200:
                    break
            log(f"    Spaces: {count}")
        else:
            log(f"    Spaces API error {r2.status_code}")
    except Exception as e:
        log(f"    Error: {e}")
    log(f"  HF total: {len(tools)}")
    return tools, 'huggingface'


# ─────────────────────────────────────────────
# GitHub
# ─────────────────────────────────────────────
GITHUB_TOKEN = os.environ.get('GITHUB_TOKEN', '')


def scrape_github():
    tools = []
    log("  Source C: GitHub")
    headers = {'Accept': 'application/vnd.github+json'}
    if GITHUB_TOKEN:
        headers['Authorization'] = f'token {GITHUB_TOKEN}'

    queries = [
        'topic:ai-tools stars:>100',
        'topic:llm topic:tool stars:>100',
    ]
    seen = set()
    try:
        for query in queries:
            url = ("https://api.github.com/search/repositories?q="
                   + quote(query) + "&sort=stars&order=desc&per_page=50")
            r = requests.get(url, headers=headers, timeout=30)
            if r.status_code != 200:
                log(f"    GitHub API error {r.status_code}: {r.text[:150]}")
                if r.status_code == 403:
                    log("    Rate limited; stopping GitHub source")
                    break
                continue
            data = r.json()
            for repo in data.get('items', []):
                full = repo.get('full_name', '')
                stars = repo.get('stargazers_count', 0)
                if full in seen:
                    continue
                seen.add(full)
                if stars < 100:
                    continue
                name = repo.get('name', '')
                desc = repo.get('description', '') or f"GitHub repo {full}."
                topics = repo.get('topics', [])
                category = categorize(' '.join(topics) + ' ' + desc + ' ' + name)
                tools.append({
                    'name': name[:200],
                    'slug': slugify(name),
                    'description': desc[:2000],
                    'short_desc': desc[:100],
                    'category': category,
                    'pricing': 'free',
                    'website_url': repo.get('html_url', f"https://github.com/{full}"),
                    'logo_url': get_logo_url(repo.get('html_url', f"https://github.com/{full}")),
                    'tags': f"ai,github,open-source,{','.join(topics[:3])}",
                    'source': 'github',
                })
            time.sleep(0.5)
    except Exception as e:
        log(f"    Error: {e}")
    log(f"  GitHub total: {len(tools)}")
    return tools, 'github'


# ─────────────────────────────────────────────
# HN Algolia
# ─────────────────────────────────────────────
HN_KEYWORDS = ['ai', 'artificial intelligence', 'machine learning', 'llm', 'gpt', 'claude',
               'chatbot', 'agent', 'generative', 'prompt', 'neural', 'diffusion', 'nlp',
               'computer vision', 'speech', 'translation', 'automation', 'coding',
               'text-to-image', 'stable diffusion', 'rag', 'embedding']


def scrape_hn():
    blogs = []
    tools = []
    log("  Source D: HN Algolia")
    try:
        # Top posts from last 7 days mentioning AI keywords
        url = "https://hn.algolia.com/api/v1/search_by_date?tags=story&hitsPerPage=100&numericFilters=points%3E30"
        r = requests.get(url, headers={'User-Agent': 'Mozilla/5.0'}, timeout=20)
        data = r.json()
        hits = data.get('hits', [])
        found_blog = 0
        found_tool = 0
        for hit in hits:
            if hit.get('points', 0) <= 30:
                continue
            title = hit.get('title', '')
            story_url = hit.get('url', '')
            if not title or not story_url:
                continue
            text = (title + ' ' + (hit.get('story_text') or '')).lower()
            if not any(kw in text for kw in HN_KEYWORDS):
                continue
            # Sort into real tools vs news/articles.
            is_tool_like = any(s in text for s in ['show hn', 'launch', 'app', 'api',
                                                   'library', 'framework', 'sdk', 'generator',
                                                   'assistant', 'engine'])
            if is_tool_like and is_real_tool_url(story_url) and 'show hn' in text:
                tools.append({
                    'name': title,
                    'slug': slugify(title),
                    'description': (hit.get('story_text') or title)[:1000],
                    'short_desc': (hit.get('story_text') or title)[:100],
                    'category': categorize(title + ' ' + (hit.get('story_text') or '')),
                    'pricing': 'free',
                    'website_url': story_url,
                    'logo_url': get_logo_url(story_url),
                    'tags': 'ai,hackernews,show-hn',
                    'source': 'hackernews',
                    'kind': 'tool',
                })
                found_tool += 1
            else:
                # News / article -> route to blogs table.
                blogs.append({
                    'title': title,
                    'slug': slugify(title),
                    'content': hit.get('story_text') or title,
                    'meta_description': title[:200],
                    'category': 'news',
                    'tool_slug': '',
                    'website_url': story_url,
                    'kind': 'blog',
                })
                found_blog += 1
        log(f"    Found {found_blog} articles -> blogs, {found_tool} tools -> tools")
    except Exception as e:
        log(f"    Error: {e}")
    log(f"  HN total: {len(blogs)} blogs, {len(tools)} tools")
    return blogs, tools, 'hackernews'


# ─────────────────────────────────────────────
# RSS feeds
# ─────────────────────────────────────────────
RSS_FEEDS = {
    'tldr': 'https://tldr.tech/ai/rss',
    'bensbites': 'https://bensbites.com/feed',
    'therundown': 'https://www.therundown.ai/rss',
}


def scrape_rss():
    blogs = []
    tools = []
    log("  Source E: RSS feeds")
    try:
        from xml.etree import ElementTree as ET
    except Exception:
        return blogs, tools, 'rss'

    for name, feed_url in RSS_FEEDS.items():
        try:
            r = requests.get(feed_url, headers={'User-Agent': 'Mozilla/5.0'}, timeout=20)
            if r.status_code != 200:
                log(f"    {name}: HTTP {r.status_code}")
                continue
            root = ET.fromstring(r.content)
            items = root.iter('item')
            found = 0
            for item in items:
                title_el = item.find('title')
                link_el = item.find('link')
                desc_el = item.find('description')
                title = (title_el.text if title_el is not None and title_el.text else '').strip()
                link = (link_el.text if link_el is not None and link_el.text else '').strip()
                desc = (desc_el.text if desc_el is not None and desc_el.text else '')[:1500]
                if not title or not link:
                    continue
                text = (title + ' ' + desc).lower()
                if not any(kw in text for kw in HN_KEYWORDS):
                    continue
                # RSS items are news/editions -> route to blogs table.
                blogs.append({
                    'title': title[:200],
                    'slug': slugify(title),
                    'content': desc or title,
                    'meta_description': (desc or title)[:200],
                    'category': 'news',
                    'tool_slug': '',
                    'website_url': link,
                    'kind': 'blog',
                })
                found += 1
                if found >= 40:
                    break
            log(f"    {name}: {found} items -> blogs")
        except Exception as e:
            log(f"    {name}: Error {e}")
    log(f"  RSS total: {len(blogs)} blogs, {len(tools)} tools")
    return blogs, tools, 'rss'


# ─────────────────────────────────────────────
# MAIN
# ─────────────────────────────────────────────
# ─────────────────────────────────────────────
# Source health
# ─────────────────────────────────────────────
HEALTH_FILE = '/tmp/source_health.json'


def record_health(source, scraped, fresh, articles=0):
    """Record this source's counts for the Telegram report later in the same job.

    There is no persistence between runs (every Actions runner starts clean), so
    this is a per-run picture rather than a trend. Its job is to make a source
    that has quietly stopped working visible, instead of letting a dead scraper
    look exactly like a day with nothing new to add.
    """
    try:
        try:
            with open(HEALTH_FILE) as f:
                health = json.load(f)
        except Exception:
            health = {}
        health[source] = {
            'scraped': scraped,
            'fresh': fresh,
            'articles': articles,
            'status': 'ok' if (scraped or articles) else 'silent',
        }
        with open(HEALTH_FILE, 'w') as f:
            json.dump(health, f)
    except Exception as e:
        log(f"  (source health not recorded: {e})")


# ─────────────────────────────────────────────
# Source F: SerpAPI (Google)
# ─────────────────────────────────────────────
SERPAPI_KEY = os.environ.get('SERPAPI_KEY', '')

SERP_QUERIES = [
    '"AI tool" launch 2026 -site:reddit.com',
    'best new AI tools this week',
    'site:producthunt.com AI tool',
    'new AI SaaS tool launched',
    'AI assistant app free tier 2026',
]


def scrape_serpapi():
    """Source F: Google results via SerpAPI, aimed at brand-new AI tools.

    Only successful searches are billed (cached/errored ones are free), and the
    free plan covers 250 searches a month. Five queries a night is ~130 a month,
    so this stays inside the free tier. Skips itself cleanly when the key is
    absent, the same way the Product Hunt source does.
    """
    blogs, tools = [], []
    log("  Source F: SerpAPI (Google)")
    if not SERPAPI_KEY:
        log("    SERPAPI_KEY not set - skipping")
        return blogs, tools, 'serpapi'

    for query in SERP_QUERIES:
        try:
            r = requests.get("https://serpapi.com/search.json", params={
                'engine': 'google',
                'q': query,
                'num': 20,
                'api_key': SERPAPI_KEY,
            }, timeout=25)
            if r.status_code != 200:
                log(f"    '{query}' -> HTTP {r.status_code}")
                continue
            results = r.json().get('organic_results', [])
            found_tool = found_blog = 0
            for item in results:
                link = (item.get('link') or '').strip()
                title = (item.get('title') or '').strip()
                if not link or not title:
                    continue
                snippet = (item.get('snippet') or '').strip()
                text = (title + ' ' + snippet).lower()
                if not any(kw in text for kw in HN_KEYWORDS):
                    continue
                # Sort into real tools vs news/articles, like the HN source.
                is_tool_like = any(s in text for s in ['tool', 'app', 'platform',
                                                       'assistant', 'generator', 'api'])
                if is_tool_like and is_real_tool_url(link):
                    tools.append({
                        'name': title,
                        'slug': slugify(title),
                        'description': snippet[:1000],
                        'short_desc': snippet[:100],
                        'category': categorize(title + ' ' + snippet),
                        'pricing': 'unknown',
                        'website_url': link,
                        'logo_url': get_logo_url(link),
                        'tags': 'ai,google',
                        'source': 'serpapi',
                        'kind': 'tool',
                    })
                    found_tool += 1
                else:
                    blogs.append({
                        'title': title,
                        'slug': slugify(title),
                        'content': snippet or title,
                        'meta_description': snippet[:200] or title[:200],
                        'category': 'news',
                        'tool_slug': '',
                        'website_url': link,
                        'kind': 'blog',
                    })
                    found_blog += 1
            log(f"    '{query}' -> {found_tool} tools, {found_blog} articles")
        except Exception as e:
            log(f"    '{query}' error: {e}")

    log(f"  SerpAPI total: {len(blogs)} blogs, {len(tools)} tools")
    return blogs, tools, 'serpapi'


# ─────────────────────────────────────────────
# Source G: Trendshift (free) — trending GitHub AI repos
# ─────────────────────────────────────────────
TRENDSHIFT_PAGES = ['https://trendshift.io/', 'https://trendshift.io/weekly']
GH_API_TOKEN = os.environ.get('GITHUB_TOKEN', '')
TRENDSHIFT_MAX_REPOS = 40


def _gh_repo(full_name):
    """Repo metadata from the public GitHub API (free; a token just ups the cap)."""
    headers = {'Accept': 'application/vnd.github+json',
               'User-Agent': 'ai-directory-v5'}
    if GH_API_TOKEN:
        headers['Authorization'] = f'Bearer {GH_API_TOKEN}'
    try:
        r = requests.get(f'https://api.github.com/repos/{full_name}',
                         headers=headers, timeout=20)
        if r.status_code != 200:
            return None
        return r.json()
    except Exception:
        return None


def scrape_trendshift():
    """Source G: trending GitHub repos, read from trendshift.io.

    The legacy direct scraper in scripts/scrapers.py is dead — /repositories
    now returns 404 and the page markup changed — which is why this source had
    gone quiet. The page links every trending repo out to GitHub, so collect
    those links and describe each one from the public GitHub API instead of
    trying to parse trendshift's own cards.

    The keyword gate does real work here: trendshift also sells ad slots, and
    those entries are junk (an FPS booster, an AutoCAD installer, a Monero
    miner). Ad entries never look like AI tools, so the gate drops them.
    """
    blogs, tools = [], []
    log("  Source G: Trendshift (GitHub trending, free)")

    candidates = []
    for page in TRENDSHIFT_PAGES:
        try:
            r = requests.get(page, headers={'User-Agent': 'Mozilla/5.0'}, timeout=25)
            if r.status_code != 200:
                log(f"    {page} -> HTTP {r.status_code}")
                continue
            found = re.findall(
                r'https://github\.com/([A-Za-z0-9._-]+/[A-Za-z0-9._-]+)', r.text)
            log(f"    {page} -> {len(found)} repo links")
            for full_name in found:
                full_name = full_name.rstrip('.')
                if full_name not in candidates:
                    candidates.append(full_name)
        except Exception as e:
            log(f"    {page} error: {e}")

    checked = failed = 0
    for full_name in candidates[:TRENDSHIFT_MAX_REPOS]:
        repo = _gh_repo(full_name)
        checked += 1
        if not repo:
            # Unauthenticated GitHub allows 60 reads an hour and this source
            # wants up to 40, so one pipeline run fits but a second one within
            # the hour does not. Counted rather than swallowed, because a
            # rate-limited run looks exactly like a day with nothing trending.
            failed += 1
            continue
        if repo.get('archived'):
            continue
        name = (repo.get('name') or full_name.split('/')[-1]).strip()
        desc = (repo.get('description') or '').strip()

        # An empty description is what actually identifies the ad slots - every
        # one of them (FPS-Booster-for-Wiindows, KMS-Pico-for-Win, Monero-Miner,
        # AutoCad-setup, Acrobat-Reader-Pro...) ships with none. Filtering on
        # that alone is more accurate than the keyword gate, which was also
        # throwing away genuine projects: colibri ("run frontier MoE models on
        # hardware you already own") is plainly an AI tool and got dropped only
        # because its wording missed the keyword list.
        if not desc:
            continue

        # Topics are folded in so a real AI repo is not lost to phrasing alone.
        topics = ' '.join(repo.get('topics') or [])
        text = f"{name} {desc} {topics}".lower()
        if not any(kw in text for kw in HN_KEYWORDS):
            continue
        homepage = (repo.get('homepage') or '').strip()
        url = homepage if homepage.startswith('http') else (repo.get('html_url') or '')
        if not url:
            continue
        tools.append({
            'name': name,
            'slug': slugify(name),
            'description': desc[:1000] or f"Trending open-source AI project ({full_name})",
            'short_desc': desc[:100] or full_name,
            'category': categorize(desc or name),
            'pricing': 'free',
            'website_url': url,
            'logo_url': (repo.get('owner') or {}).get('avatar_url') or get_logo_url(url),
            'tags': 'ai,github,open-source,trending',
            'source': 'trendshift',
            'kind': 'tool',
        })

    log(f"    checked {checked} repo(s), kept {len(tools)} AI tool(s)")
    if failed > len(candidates[:TRENDSHIFT_MAX_REPOS]) // 3:
        log(f"    WARNING: {failed}/{checked} GitHub API reads failed. "
            f"Unauthenticated GitHub allows only 60 reads/hour; set "
            f"GH_SEARCH_TOKEN (5,000/hour) or this source stays mostly empty.")
    log(f"  Trendshift total: {len(tools)} tools")
    return blogs, tools, 'trendshift'


def main():
    log("=" * 60)
    log("Fresh AI Tools Pipeline — Starting")
    log("=" * 60)

    progress = load_progress()
    seen_urls = load_dedup_set()
    try:
        existing_urls = get_existing_urls()
    except RuntimeError as e:
        log(f"ABORTING: {e}")
        raise SystemExit(1)
    log(f"Existing URLs in D1: {len(existing_urls)}")

    sources = [
        ('Product Hunt', scrape_product_hunt),
        ('HuggingFace', scrape_huggingface),
        ('GitHub', scrape_github),
        ('HN Algolia', scrape_hn),
        ('RSS', scrape_rss),
        ('SerpAPI', scrape_serpapi),
        ('Trendshift', scrape_trendshift),
    ]

    total_scraped = 0
    total_inserted = 0
    summary = {}

    for source_name, scraper_fn in sources:
        if source_name in progress.get('sources_completed', []):
            log(f"\n{source_name} — SKIPPED (already completed)")
            continue

        log(f"\n{'='*60}")
        log(f"Source: {source_name}")
        log(f"{'='*60}")

        result = scraper_fn()
        if isinstance(result, tuple) and len(result) == 3:
            blogs, tools, method = result
        else:
            tools, method = result
            blogs = []
        log(f"  Scraped: {len(tools)} tools, {len(blogs)} articles")

        # Insert articles (blogs) that are news, not tools.
        if blogs:
            new_blogs = []
            for b in blogs:
                url = b.get('website_url', '').strip().lower()
                if not url:
                    continue
                key = dedupe_key(url)
                if key in seen_urls:
                    continue
                seen_urls.add(key)
                new_blogs.append(b)
            log(f"  New blog articles: {len(new_blogs)}")
            for i in range(0, len(new_blogs), 30):
                batch = new_blogs[i:i+30]
                ins, skp = batch_insert_blogs(batch)
                log(f"    Blog batch {i//30 + 1}: inserted {ins}/{len(batch)}")
                time.sleep(0.5)

        new_tools = []
        for t in tools:
            url = t['website_url'].strip().lower()
            key = dedupe_key(t['website_url'])
            if url in existing_urls or key in seen_urls:
                continue
            if len(t['name'].strip()) < 3:
                continue
            # Only insert to tools table if URL is a real tool website.
            if not is_real_tool_url(url):
                continue
            seen_urls.add(key)
            existing_urls.add(url)
            new_tools.append(t)

        log(f"  New unique tools: {len(new_tools)}")

        for i in range(0, len(new_tools), 30):
            batch = new_tools[i:i+30]
            ins, skp = batch_insert(batch)
            log(f"    Batch {i//30 + 1}: inserted {ins}/{len(batch)}")
            total_inserted += ins
            time.sleep(0.5)

        total_scraped += len(new_tools)
        summary[source_name] = len(new_tools)
        record_health(source_name, scraped=len(tools), fresh=len(new_tools),
                      articles=len(blogs))
        progress.setdefault('sources_completed', []).append(source_name)
        save_progress(progress)
        save_dedup_set(seen_urls)

        count = get_d1_count()
        log(f"  D1 count: {count}")

    log(f"\n{'='*60}")
    log("COMPLETE")
    log(f"New unique scraped: {total_scraped}, Inserted: {total_inserted}")
    log(f"Per source: {json.dumps(summary)}")
    log(f"Final D1 count: {get_d1_count()}")


if __name__ == '__main__':
    main()
