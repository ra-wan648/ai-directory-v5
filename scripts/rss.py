import feedparser
import time
import re
from datetime import datetime

RSS_FEEDS = [
    {"url": "https://www.producthunt.com/feed?category=artificial-intelligence", "type": "tools", "source": "producthunt"},
    {"url": "https://tldr.tech/ai/rss", "type": "news", "source": "tldr_ai"},
    {"url": "https://www.bensbites.com/rss", "type": "news", "source": "bensbites"},
    {"url": "https://feeds.feedburner.com/venturebeat/SZYF", "type": "news", "source": "venturebeat"},
    {"url": "https://openai.com/news/rss", "type": "news", "source": "openai"},
    {"url": "https://www.anthropic.com/rss.xml", "type": "news", "source": "anthropic"},
    {"url": "https://blog.google/technology/ai/rss/", "type": "news", "source": "google_ai"},
    {"url": "https://www.marktechpost.com/feed/", "type": "news", "source": "marktechpost"},
    {"url": "https://www.therundown.ai/rss", "type": "news", "source": "therundown"},
]

CATEGORY_KEYWORDS = {
    "Reviews": ["review", "hands-on", "tested", "benchmark", "comparison", "vs"],
    "Tutorials": ["tutorial", "how to", "guide", "build", "create", "step by step", "getting started"],
    "News": ["launch", "release", "announce", "funding", "acquisition", "partnership", "update", "new feature"]
}

def auto_categorize(title, summary=""):
    text = (title + " " + summary).lower()
    scores = {}
    for cat, keywords in CATEGORY_KEYWORDS.items():
        scores[cat] = sum(1 for kw in keywords if kw in text)
    if scores:
        best = max(scores, key=scores.get)
        if scores[best] > 0:
            return best
    return "News"

def clean_html(raw_html):
    clean = re.sub('<[^<]+?>', '', raw_html)
    clean = re.sub(r'\s+', ' ', clean).strip()
    return clean[:500]

def fetch_rss(feed):
    try:
        f = feedparser.parse(feed["url"])
        items = []
        for entry in f.entries[:10]:
            title = entry.get("title", "")
            url = entry.get("link", "")
            summary = clean_html(entry.get("summary", entry.get("description", "")))
            published = entry.get("published", entry.get("updated", ""))
            try:
                if published:
                    pub_date = datetime.strptime(published[:19], "%a, %d %b %Y %H:%M:%S").isoformat()
                else:
                    pub_date = datetime.utcnow().isoformat()
            except Exception:
                pub_date = datetime.utcnow().isoformat()
            
            category = auto_categorize(title, summary)
            
            items.append({
                "title": title,
                "url": url,
                "summary": summary,
                "type": feed["type"],
                "source": feed["source"],
                "category": category,
                "pub_date": pub_date
            })
        time.sleep(1)
        return items
    except Exception as e:
        print(f"[WARN] RSS {feed['source']} failed: {e}")
        return []

def fetch_all_feeds():
    all_items = []
    for feed in RSS_FEEDS:
        print(f"📡 RSS: {feed['source']}...")
        items = fetch_rss(feed)
        all_items.extend(items)
        print(f"   → {len(items)} items")
    print(f"✅ Total RSS items: {len(all_items)}")
    return all_items

if __name__ == "__main__":
    fetch_all_feeds()