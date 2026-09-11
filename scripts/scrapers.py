import requests
from bs4 import BeautifulSoup
import time
import random
import re
import json
from urllib.parse import urljoin, urlparse

HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    "Accept-Language": "en-US,en;q=0.9",
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8"
}

MIN_DELAY = 2.0
MAX_DELAY = 4.0

def random_delay():
    time.sleep(random.uniform(MIN_DELAY, MAX_DELAY))

def get_favicon(domain):
    return f"https://www.google.com/s2/favicons?domain={domain}&sz=64"

def slugify(name):
    return re.sub(r'[^a-z0-9]+', '-', name.lower()).strip('-')

def safe_scrape(url, timeout=20):
    try:
        r = requests.get(url, headers=HEADERS, timeout=timeout, allow_redirects=True)
        if r.status_code in (403, 429):
            print(f"  [WARN] HTTP {r.status_code}: {url[:60]}")
            return None
        r.raise_for_status()
        return BeautifulSoup(r.text, 'html.parser')
    except Exception as e:
        print(f"  [WARN] fetch failed {url[:60]}: {e}")
        return None

def extract_domain(url):
    try:
        return urlparse(url).netloc.replace('www.', '')
    except Exception:
        return ''

def clean_text(text):
    return re.sub(r'\s+', ' ', text).strip()

def build_tool(name, url, description, category, pricing, source, raw_tags=None):
    if not name or not url or not str(url).startswith('http'):
        return None
    slug = slugify(name)
    domain = extract_domain(url)
    logo_url = get_favicon(domain)
    tags = []
    if raw_tags:
        if isinstance(raw_tags, str):
            tags = [t.strip() for t in raw_tags.split(',')]
        elif isinstance(raw_tags, list):
            tags = raw_tags
    return {
        "name": name.strip()[:80],
        "slug": slug[:80],
        "description": (description or "").strip()[:500],
        "short_desc": (description or "").strip()[:120],
        "category": category or "Productivity",
        "pricing": pricing or "freemium",
        "url": url.strip()[:200],
        "logo_url": logo_url,
        "logo_type": "favicon",
        "tags": ','.join(tags[:8]),
        "views": 0, "votes": 0, "featured": 0, "tag": "new", "status": "published"
    }

def pick_text(card, selectors, default=''):
    for sel in selectors:
        el = card.select_one(sel) if hasattr(card, 'select_one') else None
        if el is None and hasattr(card, 'find'):
            try:
                el = card.find(sel.split('[', 1)[0], attrs=dict([sel.split('[')[1].rstrip(']').split('=')]) if '[' in sel else {})
            except Exception:
                pass
        if el:
            return clean_text(el.get_text())
    return default

def pick_pricing_from_text(text):
    t = text.lower()
    if 'freemium' in t or 'free tier' in t or 'free trial' in t:
        return 'freemium'
    if 'paid' in t or '$' in t or 'premium' in t or 'subscription' in t:
        return 'paid'
    if 'free' in t:
        return 'free'
    return 'freemium'

def pick_category_from_text(text):
    cat_map = {
        'writing': 'Writing', 'coding': 'Coding', 'image': 'Image', 'video': 'Video',
        'marketing': 'Marketing', 'productivity': 'Productivity', 'research': 'Research',
        'audio': 'Audio', 'chat': 'Chat', 'business': 'Business',
        'automation': 'Automation', 'analytics': 'Analytics'
    }
    t = text.lower()
    for key, val in cat_map.items():
        if key in t:
            return val
    return 'Productivity'


# ===========================================
# DATA EXTRACTORS — use ALL available signals
# ===========================================

def extract_tool_from_link(link_el, base_url, source, seen):
    """Extract tool from an <a> element's text and surrounding context."""
    href = link_el.get('href', '') if hasattr(link_el, 'get') else ''
    if not href:
        return None
    if href.startswith('/'):
        href = urljoin(base_url, href)
    if not href.startswith('http'):
        return None
    text = clean_text(link_el.get_text())
    parts = [p.strip() for p in text.split('\n') if p.strip()]
    if not parts:
        return None
    name = parts[0]
    if len(name) < 3 or len(name) > 80:
        return None
    slug = slugify(name)
    if slug in seen:
        return None
    seen.add(slug)
    desc = ' '.join(parts[1:4]) if len(parts) > 1 else ''
    parent = link_el.parent
    price = pick_pricing_from_text(clean_text(parent.get_text()) if parent else '')
    cat = pick_category_from_text(clean_text(parent.get_text()) if parent else '')
    return build_tool(name, href, desc, cat, price, source)

def extract_from_nuxt_data(soup, base_url, source, seen):
    """Extract from Nuxt __NUXT__ JSON."""
    tools = []
    for script in soup.find_all('script'):
        txt = script.string or ''
        if '__NUXT__' not in txt and 'nuxt' not in (script.get('src', '') or '').lower():
            continue
        try:
            m = re.search(r'window\.__NUXT__\s*=\s*(\{.*?\});\s*</script>', txt, re.DOTALL)
            if not m:
                continue
            data = json.loads(m.group(1))
        except Exception:
            continue
        # Walk NUXT state
        state = data.get('data', data)
        def walk(obj, depth=0):
            if depth > 6 or not isinstance(obj, (dict, list)):
                return []
            items = []
            if isinstance(obj, list):
                for item in obj:
                    items.extend(walk(item, depth+1))
            elif isinstance(obj, dict):
                name = obj.get('name') or obj.get('title') or obj.get('heading')
                url = obj.get('url') or obj.get('link') or obj.get('href') or obj.get('slug', '')
                desc = obj.get('description') or obj.get('summary') or obj.get('excerpt', '')
                cat = obj.get('category') or obj.get('type', '')
                price = obj.get('pricing') or obj.get('price_type', '')
                if name and url:
                    if not str(url).startswith('http'):
                        url = urljoin(base_url, str(url))
                    item_slug = slugify(name)
                    if item_slug not in seen:
                        seen.add(item_slug)
                        pricing = price if price in ('free','freemium','paid') else pick_pricing_from_text(str(price))
                        category = cat if cat else pick_category_from_text(str(cat))
                        tool = build_tool(name, url, desc, category, pricing, source)
                        if tool:
                            items.append(tool)
                for v in obj.values():
                    items.extend(walk(v, depth+1))
            return items
        tools.extend(walk(state))
    return tools

def extract_from_next_data(soup, base_url, source, seen):
    """Extract from __NEXT_DATA__ JSON (Next.js)."""
    tools = []
    script = soup.find('script', id='__NEXT_DATA__')
    if not script:
        return tools
    try:
        data = json.loads(script.string or '{}')
    except Exception:
        return tools
    def walk(obj, depth=0):
        if depth > 6 or not isinstance(obj, (dict, list)):
            return []
        items = []
        if isinstance(obj, list):
            for item in obj: items.extend(walk(item, depth+1))
        elif isinstance(obj, dict):
            name = obj.get('name') or obj.get('title') or obj.get('heading')
            url = obj.get('url') or obj.get('link') or obj.get('slug', '')
            desc = obj.get('description') or obj.get('excerpt', '') or ''
            cat = obj.get('category') or obj.get('type', '') or ''
            price = obj.get('pricing') or obj.get('price_type', '') or ''
            if name and url:
                if not str(url).startswith('http'):
                    url = urljoin(base_url, str(url))
                slug = slugify(name)
                if slug not in seen:
                    seen.add(slug)
                    pricing = price if price in ('free','freemium','paid') else pick_pricing_from_text(str(price))
                    category = cat if cat else pick_category_from_text(str(cat))
                    tool = build_tool(name, url, desc, category, pricing, source)
                    if tool:
                        items.append(tool)
            for v in obj.values():
                items.extend(walk(v, depth+1))
        return items
    tools = walk(data)
    return tools

def extract_from_jsonld(soup, base_url, source, seen):
    """Extract from JSON-LD structured data."""
    tools = []
    for script in soup.find_all('script', type='application/ld+json'):
        try:
            data = json.loads(script.string or '{}')
        except Exception:
            continue
        items = data if isinstance(data, list) else [data]
        for item in items:
            if not isinstance(item, dict):
                continue
            itype = item.get('@type', '')
            if itype not in ('SoftwareApplication', 'WebApplication', 'WebSite', 'ListItem', 'ItemList'):
                continue
            if itype == 'ItemList':
                for entry in item.get('itemListElement', []):
                    e = entry.get('item', entry)
                    if isinstance(e, dict):
                        name = e.get('name', '')
                        url_val = e.get('url', '') or e.get('@id', '')
                        if name and url_val and not str(url_val).startswith('http'):
                            url_val = urljoin(base_url, str(url_val))
                        if name and url_val:
                            slug = slugify(name)
                            if slug not in seen:
                                seen.add(slug)
                                tool = build_tool(name, url_val, e.get('description', '')[:300],
                                                  'Productivity', 'freemium', source)
                                if tool: tools.append(tool)
                continue
            name = item.get('name', '')
            url_val = item.get('url', '') or item.get('@id', '')
            if isinstance(url_val, dict):
                url_val = url_val.get('url', '')
            if not name or not url_val:
                continue
            if not str(url_val).startswith('http'):
                url_val = urljoin(base_url, str(url_val))
            slug = slugify(name)
            if slug not in seen:
                seen.add(slug)
                desc = (item.get('description', '') or '')[:300]
                cat = item.get('applicationCategory', '') or 'Productivity'
                offers = item.get('offers', {})
                if isinstance(offers, dict):
                    price = str(offers.get('price', '0'))
                    pricing = 'free' if price == '0' else 'freemium'
                else:
                    pricing = 'freemium'
                tool = build_tool(name, url_val, desc, cat, pricing, source)
                if tool: tools.append(tool)
    return tools


# ===========================================
# SOURCE 1: Toolify.ai — Nuxt SSR, uses tool-dom cards
# ===========================================
def scrape_toolify(max_pages=50):
    tools = []
    base = "https://www.toolify.ai"
    for page in range(1, max_pages + 1):
        url = f"{base}/?page={page}"
        print(f"  Toolify p{page}")
        soup = safe_scrape(url)
        if not soup:
            random_delay()
            continue
        seen = set()
        # Strategy 1: All <a> links that go to /ai-tools/ or have length
        all_links = soup.select(f'a[href*="{base}/ai-tools/"], a[href*="/tool/"]')
        for link in all_links:
            if hasattr(link, 'get'):
                href = link.get('href', '')
                if not href.startswith('http'):
                    href = urljoin(base, href)
                name = clean_text(link.get_text())
                if not name or len(name) < 3 or len(name) > 80:
                    continue
                slug = slugify(name)
                if slug in seen: continue
                seen.add(slug)
                tool = build_tool(name, href, f"AI tool on Toolify", 'Productivity', 'freemium', 'toolify')
                if tool: tools.append(tool)
        # Strategy 2: tool-dom classes
        if not tools:
            for card in soup.select('[class*="tool-dom"], [class*="tool-card"]'):
                link = card.select_one('a[href]')
                if not link: continue
                href = link.get('href', '')
                if href.startswith('/'): href = urljoin(base, href)
                name = clean_text(card.get_text())[:80]
                if name and slugify(name) not in seen:
                    seen.add(slugify(name))
                    tool = build_tool(name, href, f"AI tool on Toolify", 'Productivity', 'freemium', 'toolify')
                    if tool: tools.append(tool)
        found = len(tools)
        print(f"   -> {found}")
        if found == 0 and page > 3:
            break
        random_delay()
    return tools


# ===========================================
# SOURCE 2: Futurepedia.io
# ===========================================
def scrape_futurepedia(max_pages=50):
    tools = []
    base = "https://www.futurepedia.io"
    for page in range(1, max_pages + 1):
        url = f"{base}/ai-tools?page={page}"
        print(f"  Futurepedia p{page}")
        soup = safe_scrape(url)
        if not soup:
            random_delay()
            continue
        seen = set()
        # Strategy 1: direct /ai-tools/ links
        for link in soup.select(f'a[href*="/ai-tools/"]'):
            href = link.get('href', '')
            if href.startswith('/'): href = urljoin(base, href)
            name = clean_text(link.get_text())
            if not name or len(name) < 3 or len(name) > 80: continue
            slug = slugify(name)
            if slug in seen: continue
            seen.add(slug)
            tool = build_tool(name, href, f"AI tool listed on Futurepedia", 'Productivity', 'freemium', 'futurepedia')
            if tool: tools.append(tool)
        if not tools:
            # Strategy 2: h3/h4 headings near links
            for heading in soup.select('h3, h4, h2'):
                name = clean_text(heading.get_text())
                if not name or len(name) < 3: continue
                slug = slugify(name)
                if slug in seen: continue
                link = heading.find_parent('a') or heading.select_one('a[href]')
                if not link: continue
                href = link.get('href', '')
                if href.startswith('/'): href = urljoin(base, href)
                seen.add(slug)
                tool = build_tool(name, href, f"AI tool on Futurepedia", 'Productivity', 'freemium', 'futurepedia')
                if tool: tools.append(tool)
        print(f"   -> {len(tools)}")
        if not tools and page > 3: break
        random_delay()
    return tools


# ===========================================
# SOURCE 3: TAAFT — Next.js, use __NEXT_DATA__ and JSON-LD
# ===========================================
def scrape_taaft(max_pages=50):
    tools = []
    base = "https://theresanaiforthat.com"
    for page in range(1, max_pages + 1):
        url = f"{base}/?page={page}"
        print(f"  TAAFT p{page}")
        soup = safe_scrape(url)
        if not soup:
            random_delay()
            continue
        seen = set()
        # Strategy 1: __NEXT_DATA__
        tools.extend(extract_from_next_data(soup, base, 'taaft', seen))
        # Strategy 2: JSON-LD items
        tools.extend(extract_from_jsonld(soup, base, 'taaft', seen))
        # Strategy 3: direct links
        if not tools:
            for link in soup.select('a[href*="/ai-tool/"], a[href*="/tool/"]'):
                href = link.get('href', '')
                if href.startswith('/'): href = urljoin(base, href)
                name = clean_text(link.get_text())
                if name and len(name) >= 3 and slugify(name) not in seen:
                    seen.add(slugify(name))
                    tool = build_tool(name, href, f"AI tool on TAAFT", 'Productivity', 'freemium', 'taaft')
                    if tool: tools.append(tool)
        print(f"   -> {len(tools)}")
        if not tools and page > 3: break
        random_delay()
    return tools


# ===========================================
# SOURCE 4: TopAI.tools
# ===========================================
def scrape_topaitools(max_pages=50):
    tools = []
    base = "https://topai.tools"
    for page in range(1, max_pages + 1):
        url = f"{base}/?page={page}"
        print(f"  TopAI p{page}")
        soup = safe_scrape(url)
        if not soup:
            random_delay()
            continue
        seen = set()
        # Strategy 1: direct tool links
        for link in soup.select('a[href*="/tool/"], a[href*="/tools/"]'):
            href = link.get('href', '')
            if href.startswith('/'): href = urljoin(base, href)
            name = clean_text(link.get_text())
            if not name or len(name) < 3 or len(name) > 80: continue
            slug = slugify(name)
            if slug in seen: continue
            seen.add(slug)
            tool = build_tool(name, href, f"AI tool on TopAI.tools", 'Productivity', 'freemium', 'topaitools')
            if tool: tools.append(tool)
        if not tools:
            for card in soup.select('div[class*="tool"], div[class*="card"]'):
                link = card.select_one('a[href]')
                if not link: continue
                href = link.get('href', '')
                if href.startswith('/'): href = urljoin(base, href)
                name = clean_text(card.get_text())[:80]
                if name and slugify(name) not in seen:
                    seen.add(slugify(name))
                    tool = build_tool(name, href, f"AI tool on TopAI.tools", 'Productivity', 'freemium', 'topaitools')
                    if tool: tools.append(tool)
        print(f"   -> {len(tools)}")
        if not tools and page > 3: break
        random_delay()
    return tools


# ===========================================
# SOURCE 5: AIxploria
# ===========================================
def scrape_aixploria(max_pages=50):
    tools = []
    base = "https://www.aixploria.com"
    for page in range(1, max_pages + 1):
        url = f"{base}/en/ai-tools/page/{page}/"
        print(f"  AIxploria p{page}")
        soup = safe_scrape(url)
        if not soup:
            random_delay()
            continue
        seen = set()
        # Strategy 1: JSON-LD
        tools.extend(extract_from_jsonld(soup, base, 'aixploria', seen))
        # Strategy 2: direct links
        for link in soup.select(f'a[href*="{base}/"], a[href*="/ai-"]'):
            href = link.get('href', '')
            if href.startswith('/'): href = urljoin(base, href)
            name = clean_text(link.get_text())
            if not name or len(name) < 3 or len(name) > 80: continue
            slug = slugify(name)
            if slug in seen: continue
            seen.add(slug)
            tool = build_tool(name, href, f"AI tool on AIxploria", 'Productivity', 'freemium', 'aixploria')
            if tool: tools.append(tool)
        print(f"   -> {len(tools)}")
        if not tools and page > 3: break
        random_delay()
    return tools


# ===========================================
# SOURCE 6: AllThingsAI
# ===========================================
def scrape_allthingsai(max_pages=50):
    tools = []
    base = "https://allthingsai.com"
    for page in range(1, max_pages + 1):
        url = f"{base}/?page={page}"
        print(f"  AllThingsAI p{page}")
        soup = safe_scrape(url)
        if not soup:
            random_delay()
            continue
        seen = set()
        for link in soup.select('a[href]'):
            href = link.get('href', '')
            if href.startswith('/'): href = urljoin(base, href)
            name = clean_text(link.get_text())
            if not name or len(name) < 3 or len(name) > 100: continue
            if any(x in name.lower() for x in ['login', 'sign up', 'home', 'about', 'contact', 'privacy', 'terms']):
                continue
            slug = slugify(name)
            if slug in seen: continue
            seen.add(slug)
            tool = build_tool(name, href, f"AI tool on AllThingsAI", 'Productivity', 'freemium', 'allthingsai')
            if tool: tools.append(tool)
        print(f"   -> {len(tools)}")
        if not tools and page > 3: break
        random_delay()
    return tools


# ===========================================
# SOURCE 7: Insidr.ai
# ===========================================
def scrape_insidr(max_pages=50):
    tools = []
    base = "https://www.insidr.ai"
    for page in range(1, max_pages + 1):
        url = f"{base}/ai-tools/page/{page}/"
        print(f"  Insidr p{page}")
        soup = safe_scrape(url)
        if not soup:
            random_delay()
            continue
        seen = set()
        for link in soup.select('a[href]'):
            href = link.get('href', '')
            if href.startswith('/'): href = urljoin(base, href)
            name = clean_text(link.get_text())
            if not name or len(name) < 3 or len(name) > 100: continue
            if any(x in name.lower() for x in ['login', 'sign up', 'home', 'about', 'contact']):
                continue
            slug = slugify(name)
            if slug in seen: continue
            seen.add(slug)
            tool = build_tool(name, href, f"AI tool on Insidr.ai", 'Productivity', 'freemium', 'insidr')
            if tool: tools.append(tool)
        print(f"   -> {len(tools)}")
        if not tools and page > 3: break
        random_delay()
    return tools


# ===========================================
# SOURCE 8: ToolFk.com
# ===========================================
def scrape_toolfk(max_pages=50):
    tools = []
    base = "https://toolfk.com"
    for page in range(1, max_pages + 1):
        url = f"{base}/?page={page}"
        print(f"  ToolFk p{page}")
        soup = safe_scrape(url)
        if not soup:
            random_delay()
            continue
        seen = set()
        for link in soup.select('a[href]'):
            href = link.get('href', '')
            if href.startswith('/'): href = urljoin(base, href)
            name = clean_text(link.get_text())
            if not name or len(name) < 3 or len(name) > 100: continue
            slug = slugify(name)
            if slug in seen: continue
            seen.add(slug)
            tool = build_tool(name, href, f"AI tool on ToolFk", 'Productivity', 'freemium', 'toolfk')
            if tool: tools.append(tool)
        print(f"   -> {len(tools)}")
        if not tools and page > 3: break
        random_delay()
    return tools


# ===========================================
# SOURCE 9: FutureTools.io
# ===========================================
def scrape_futuretools(max_pages=50):
    tools = []
    base = "https://www.futuretools.io"
    for page in range(1, max_pages + 1):
        url = f"{base}/?page={page}"
        print(f"  FutureTools p{page}")
        soup = safe_scrape(url)
        if not soup:
            random_delay()
            continue
        seen = set()
        for link in soup.select('a[href]'):
            href = link.get('href', '')
            if href.startswith('/'): href = urljoin(base, href)
            name = clean_text(link.get_text())
            if not name or len(name) < 3 or len(name) > 100: continue
            if any(x in name.lower() for x in ['login', 'sign up', 'subscribe', 'home']):
                continue
            slug = slugify(name)
            if slug in seen: continue
            seen.add(slug)
            tool = build_tool(name, href, f"AI tool on FutureTools.io", 'Productivity', 'freemium', 'futuretools')
            if tool: tools.append(tool)
        print(f"   -> {len(tools)}")
        if not tools and page > 3: break
        random_delay()
    return tools


# ===========================================
# SOURCE 10: HackerNews — Algolia API
# ===========================================
def scrape_hackernews():
    tools = []
    urls = [
        "https://hn.algolia.com/api/v1/search?query=AI+tool&tags=story&hitsPerPage=200&numericFilters=points>50",
        "https://hn.algolia.com/api/v1/search?query=Show+HN+AI&tags=story&hitsPerPage=200&numericFilters=points>30",
        "https://hn.algolia.com/api/v1/search?query=AI+launch&tags=story&hitsPerPage=200&numericFilters=points>30",
    ]
    ai_kw = ['ai ', ' gpt', 'llm', 'machine learn', 'neural', 'diffusion', 'chatbot', 'image gen', 'video gen', 'voice', 'copilot', 'claude', 'auto']
    for url in urls:
        print(f"  HN API: {url[:55]}...")
        try:
            r = requests.get(url, headers=HEADERS, timeout=15)
            r.raise_for_status()
            data = r.json()
            seen_hn = set()
            for hit in data.get('hits', []):
                points = hit.get('points', 0)
                if points < 30: continue
                title = hit.get('title', '').strip()
                url_val = hit.get('url', '')
                if not title or not url_val: continue
                if not any(kw in title.lower() for kw in ai_kw): continue
                slug = slugify(title[:60])
                if slug in seen_hn: continue
                seen_hn.add(slug)
                tool = build_tool(title[:100], url_val, f"Featured on HN ({points} pts): {title[:200]}",
                                  'Productivity', 'freemium', 'hackernews')
                if tool:
                    tool['votes'] = points
                    tools.append(tool)
            print(f"   -> {len(seen_hn)} tools")
        except Exception as e:
            print(f"   [WARN] HN failed: {e}")
        random_delay()
    return tools


# ===========================================
# SOURCE 11: Trendshift.io — GitHub trending AI repos
# ===========================================
def scrape_trendshift():
    tools = []
    urls = [
        "https://trendshift.io/repositories",
        "https://trendshift.io/weekly",
        "https://trendshift.io/monthly"
    ]
    ai_kw = ['ai', 'ml', 'llm', 'gpt', 'machine learning', 'neural', 'diffusion', 'agent', 'chatbot', 'vision', 'embedding', 'language model', 'stable']
    for url in urls:
        print(f"  Trendshift: {url}")
        soup = safe_scrape(url)
        if not soup:
            random_delay()
            continue
        cards = soup.select('div[class*="repo"], div[class*="card"], article')
        found = 0
        seen = set()
        for card in cards:
            name_el = card.select_one('h2, h3, h4, [class*="name"], [class*="title"]')
            link_el = card.select_one('a[href]')
            desc_el = card.select_one('p, [class*="desc"], [class*="description"]')
            star_el = card.select_one('[class*="star"], [class*="count"], [class*="point"]')
            if not name_el:
                continue
            name = clean_text(name_el.get_text())
            if not name: continue
            slug = slugify(name)
            if slug in seen: continue
            seen.add(slug)
            desc = clean_text(desc_el.get_text())[:300] if desc_el else ''
            if not any(kw in desc.lower() or kw in name.lower() for kw in ai_kw):
                continue
            href = link_el.get('href', '') if link_el else ''
            if href.startswith('/'):
                href = 'https://trendshift.io' + href
            stars = 0
            if star_el:
                try: stars = int(''.join(filter(str.isdigit, star_el.get_text())))
                except: pass
            tool = build_tool(name, href, desc or f"AI open-source tool on GitHub", 'Open Source', 'free', 'trendshift')
            if tool:
                tool['votes'] = stars
                tools.append(tool)
                found += 1
        print(f"   -> {found}")
        random_delay()
    return tools


# ===========================================
# MASTER SCRAPER
# ===========================================
def scrape_all(max_pages_normal=15, max_pages_bulk=50):
    is_bulk = max_pages_normal > 20
    max_pages = max_pages_bulk if is_bulk else max_pages_normal
    all_tools = []
    scrapers = [
        ("toolify",     lambda: scrape_toolify(max_pages)),
        ("futurepedia", lambda: scrape_futurepedia(max_pages)),
        ("taaft",       lambda: scrape_taaft(max_pages)),
        ("topaitools",  lambda: scrape_topaitools(max_pages)),
        ("aixploria",   lambda: scrape_aixploria(max_pages)),
        ("allthingsai", lambda: scrape_allthingsai(max_pages)),
        ("insidr",      lambda: scrape_insidr(max_pages)),
        ("toolfk",      lambda: scrape_toolfk(max_pages)),
        ("futuretools", lambda: scrape_futuretools(max_pages)),
        ("hackernews",  scrape_hackernews),
        ("trendshift",  scrape_trendshift),
    ]
    for name, fn in scrapers:
        print(f"\n[SCRAPE] {name}...")
        try:
            results = fn()
            all_tools.extend(results)
            print(f"  -> {len(results)} items")
        except Exception as e:
            print(f"  [ERROR] {name}: {e}")
    print(f"\n[SCRAPE DONE] Total raw: {len(all_tools)}")
    return all_tools

if __name__ == "__main__":
    import sys
    if len(sys.argv) > 1 and sys.argv[1] == "--bulk":
        scrape_all(max_pages_normal=50, max_pages_bulk=50)
    else:
        scrape_all()
