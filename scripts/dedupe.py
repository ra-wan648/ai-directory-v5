#!/usr/bin/env python3
"""
4-layer deduplication to protect D1 quota.

Layer 1 — URL normalization: lowercase host, strip tracking params
           (utm_*, fbclid, gclid, ref, ...), drop trailing slash.
Layer 2 — In-run memory set: same normalized URL seen twice in one run
           collapses to a single candidate before any D1/LLM work.
Layer 3 — Name fingerprint: lowercase alphanumeric only. Catches
           "ChatGPT" vs "ChatGPT – AI Chatbot" style near-duplicates.
Layer 4 — Source priority merge: on conflict keep the higher-priority
           source's row and merge missing fields (description, image)
           instead of inserting a new row.

Only tools that survive all layers reach the LLM enrichment step and D1.
"""

import re
from urllib.parse import urlparse, parse_qsl, urlencode, urlunparse

TRACKING_PARAMS = {
    'utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content',
    'utm_id', 'fbclid', 'gclid', 'dclid', 'msclkid', 'ref', 'referrer',
    'source', 'campaign', '_ga',
}

# Higher number = wins on conflict. API sources outrank directory scrapes.
SOURCE_PRIORITY = {
    'producthunt': 100,
    'github': 90,
    'huggingface': 80,
    'beyondtools': 70,
    'theresanaiforthat': 60,
    'taaft': 60,
    'futuretools': 55,
    'topaitools': 50,
    'topai': 50,
    'futurepedia': 45,
    'toolfk': 40,
    'hackernews': 35,
    'trendshift': 30,
}


def normalize_url(url):
    """Canonical URL for dedupe comparisons."""
    try:
        u = urlparse(str(url).strip())
        host = u.netloc.lower()
        if host.startswith('www.'):
            host = host[4:]
        qs = [(k, v) for k, v in parse_qsl(u.query)
              if k.lower() not in TRACKING_PARAMS]
        path = u.path.rstrip('/') or '/'
        return urlunparse((u.scheme.lower(), host, path, '', urlencode(qs), ''))
    except Exception:
        return str(url).strip().lower()


def name_fingerprint(name):
    """Lowercase alphanumeric only — for fuzzy name matching."""
    return re.sub(r'[^a-z0-9]', '', str(name or '').lower())


def fingerprints_close(a, b):
    """True when one fingerprint contains the other (min length 5)."""
    if len(a) < 5 or len(b) < 5:
        return a == b
    return a in b or b in a


class RunDeduper:
    """In-memory dedupe for a single pipeline run (Layer 2)."""

    def __init__(self):
        self.seen_urls = set()
        self.seen_fps = set()

    def is_duplicate(self, tool):
        url = normalize_url(tool.get('url', ''))
        fp = name_fingerprint(tool.get('name', ''))
        if url in self.seen_urls:
            return True
        for seen in self.seen_fps:
            if fingerprints_close(fp, seen):
                return True
        self.seen_urls.add(url)
        self.seen_fps.add(fp)
        return False


def merge_tool(existing, incoming):
    """Merge missing fields from a lower-priority duplicate into the keeper."""
    merged = dict(existing)
    for field in ('description', 'short_desc', 'logo_url', 'tags'):
        if not merged.get(field) and incoming.get(field):
            merged[field] = incoming[field]
    # Keep the higher-priority source label
    if SOURCE_PRIORITY.get(incoming.get('source'), 0) > SOURCE_PRIORITY.get(existing.get('source'), 0):
        merged['source'] = incoming['source']
    return merged


def fetch_og_image(page_url, timeout=12):
    """Best-effort og:image extraction for card thumbnails. Returns URL or ''."""
    try:
        import requests
        from bs4 import BeautifulSoup
        r = requests.get(page_url, timeout=timeout,
                         headers={'User-Agent': 'Mozilla/5.0 (compatible; AI-Directory/1.0)'})
        if not r.ok or 'text/html' not in r.headers.get('content-type', ''):
            return ''
        soup = BeautifulSoup(r.text, 'html.parser')
        for prop in ('og:image', 'twitter:image'):
            tag = soup.find('meta', property=prop) or soup.find('meta', attrs={'name': prop})
            if tag and tag.get('content', '').startswith('http'):
                return tag['content'].strip()[:300]
    except Exception:
        pass
    return ''
