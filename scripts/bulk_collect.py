#!/usr/bin/env python3
"""
Fast bulk data collector — GitHub API + HN Algolia
Collects AI tools from APIs (no Playwright needed), inserts into D1.
"""

import os
import re
import sys
import json
import time
import hashlib
import subprocess
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

PROGRESS_FILE = '/tmp/bulk_collect_progress.json'
DEDUP_FILE = '/tmp/bulk_collect_dedup.json'

# ─────────────────────────────────────────────
# UTILITIES
# ─────────────────────────────────────────────

def log(msg):
    print(f"[{datetime.now().strftime('%H:%M:%S')}] {msg}", flush=True)

def random_delay(min_s=1, max_s=3):
    time.sleep(random.uniform(min_s, max_s))

def slugify(text):
    text = re.sub(r'[^\w\s-]', '', text).strip().lower()
    text = re.sub(r'[\s]+', '-', text)
    return text[:80]

def get_logo_url(url):
    domain = urlparse(url).netloc
    return f"https://www.google.com/s2/favicons?domain={domain}&sz=64"

def category_from_text(text):
    t = (text or '').lower()
    if any(w in t for w in ['coding', 'dev', 'programming', 'code', 'developer', 'vscode', 'cursor']):
        return 'Coding'
    if any(w in t for w in ['image', 'photo', 'art', 'design', 'generate']):
        return 'Image'
    if any(w in t for w in ['video', 'animation', 'editor']):
        return 'Video'
    if any(w in t for w in ['audio', 'music', 'sound', 'voice']):
        return 'Audio'
    if any(w in t for w in ['chat', 'conversat', 'assistant', 'llm', 'gpt', 'claude']):
        return 'Chat'
    if any(w in t for w in ['research', 'search', 'academic', 'paper']):
        return 'Research'
    if any(w in t for w in ['marketing', 'seo', 'social', 'advertis', 'email']):
        return 'Marketing'
    if any(w in t for w in ['finance', 'money', 'invest', 'crypto', 'trading']):
        return 'Finance'
    if any(w in t for w in ['writing', 'copy', 'content', 'blog', 'essay']):
        return 'Writing'
    if any(w in t for w in ['education', 'learn', 'course', 'teach', 'study']):
        return 'Education'
    if any(w in t for w in ['automation', 'workflow', 'zapier', 'process']):
        return 'Automation'
    if any(w in t for w in ['analytics', 'data', 'insight', 'metric', 'dashboard']):
        return 'Analytics'
    if any(w in t for w in ['business', 'productivity', 'project', 'management']):
        return 'Business'
    return 'AI Tools'

def dedupe_key(url):
    try:
        parsed = urlparse(url)
        return hashlib.md5(parsed.netloc.lower().encode() + parsed.path.encode()).hexdigest()
    except Exception:
        return hashlib.md5(url.encode()).hexdigest()

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

def insert_into_d1(tools_batch):
    """Insert tools in batches via wrangler CLI."""
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
        pricing = (tool.get('pricing', 'free') or '').replace("'", "''")
        url = tool['website_url'].replace("'", "''")
        logo = (tool.get('logo_url', '') or '').replace("'", "''")
        tags = (tool.get('tags', '') or '').replace("'", "''")
        created = datetime.utcnow().strftime('%Y-%m-%d %H:%M:%S')
        cmd = f"INSERT INTO tools (name, slug, description, short_desc, category, pricing, url, logo_url, logo_type, tags, status, created_at) VALUES ('{name}', '{slug}', '{desc}', '{short_desc}', '{category}', '{pricing}', '{url}', '{logo}', 'favicon', '{tags}', 'published', '{created}') ON CONFLICT(slug) DO NOTHING"
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
# GITHUB API SOURCE
# ─────────────────────────────────────────────
GITHUB_KEYWORDS = [
    'ai', 'artificial intelligence', 'machine learning', 'ml', 'llm',
    'large language model', 'gpt', 'claude', 'copilot', 'automated',
    'neural network', 'deep learning', 'generative', 'nlp', 'chatbot',
    'automation', 'prompt', 'embedding', 'transformer', 'model',
    'agent', 'rag', 'multimodal', 'computer vision', 'speech',
    'text-to-image', 'text to image', 'stable diffusion', 'diffusion',
    'openai', 'anthropic', 'meta ai', 'google ai',
]

def scrape_github_fast():
    tools = []
    log("  Source A: GitHub API — collecting AI repos")
    
    queries = [
        'AI tool', 'artificial intelligence', 'machine learning',
        'LLM application', 'generative AI', 'AI assistant',
        'AI chatbot', 'AI coding', 'AI writing', 'AI image',
        'AI video', 'AI agent', 'AI automation', 'AI framework',
        'open source AI', 'AI library', 'AI SDK', 'LangChain',
        'RAG pipeline', 'AI wrapper', 'AI boilerplate',
    ]
    
    for query in queries:
        for pg in range(1, 6):
            url = f"https://api.github.com/search/repositories?q={quote(query)}+language:python&sort=stars&per_page=100&page={pg}"
            try:
                r = requests.get(url, headers={
                    'Accept': 'application/vnd.github.v3+json',
                    'User-Agent': 'AI-Tools-Director/1.0'
                }, timeout=20)
                if r.status_code == 403:
                    log(f"    Rate limited on '{query}' pg{pg}, waiting...")
                    time.sleep(10)
                    continue
                if r.status_code != 200:
                    break
                data = r.json()
                items = data.get('items', [])
                if not items:
                    break
                for item in items:
                    desc = (item.get('description') or '').strip()
                    name = item.get('name', '').strip()
                    html_url = item.get('html_url', '').strip()
                    stars = item.get('stargazers_count', 0)
                    if stars < 200 or not desc or len(desc) < 30:
                        continue
                    text = (name + ' ' + desc).lower()
                    if not any(kw in text for kw in GITHUB_KEYWORDS):
                        continue
                    tools.append({
                        'name': name, 'slug': slugify(name),
                        'description': desc[:2000],
                        'short_desc': desc[:200],
                        'category': category_from_text(name + ' ' + desc),
                        'pricing': 'free',
                        'website_url': html_url,
                        'logo_url': get_logo_url(html_url),
                        'tags': f'ai,opensource,github,{query[:15]}',
                    })
                log(f"    '{query}' pg{pg}: {len(items)} items, {sum(1 for i in items if i.get('stargazers_count',0)>=200)} qualifying")
                time.sleep(1)
            except Exception as e:
                log(f"    Error: {e}")
                time.sleep(2)
    
    log(f"  GitHub total collected: {len(tools)}")
    return tools, 'requests'

# ─────────────────────────────────────────────
# HNSPECIFIC KEYWORDS FOR HN
# ─────────────────────────────────────────────
HN_AI_KEYWORDS = [
    'ai', 'artificial intelligence', 'machine learning', 'ml', 'llm',
    'gpt', 'claude', 'chatbot', 'agent', 'generative', 'prompt',
    'neural', 'diffusion', 'nlp', 'computer vision', 'speech',
    'translation', 'automate', 'automation', 'coding', 'assistant',
]

def scrape_hn_fast():
    tools = []
    log("  Source B: HackerNews Algolia — collecting AI tools")
    
    queries = [
        'Show HN AI', 'Show HN artificial intelligence', 'Show HN machine learning',
        'Show HN LLM', 'Show HN chatbot', 'Show HN agent', 'Show HN automation',
        'Show HN prompt', 'Show HN generative', 'Show HN diffusion',
        'Show HN computer vision', 'Show HN speech', 'Show HN translation',
        'Show HN NLP', 'Show HN embeddings', 'Show HN RAG',
        'AI tool launch', 'new AI tool', 'best AI tool',
        'open source AI', 'AI starter kit', 'AI boilerplate',
        'AI framework', 'AI library', 'AI SDK',
        'AI code', 'AI writer', 'AI image', 'AI video', 'AI audio',
    ]
    
    for query in queries:
        url = f"https://hn.algolia.com/api/v1/search?query={quote(query)}&tags=story&hitsPerPage=100"
        try:
            r = requests.get(url, headers={'User-Agent': 'Mozilla/5.0'}, timeout=20)
            data = r.json()
            hits = data.get('hits', [])
            found = 0
            for hit in hits:
                if hit.get('points', 0) < 15:
                    continue
                title = hit.get('title', '')
                story_url = hit.get('url', '')
                if not title or not story_url:
                    continue
                text = (title + ' ' + hit.get('story_text', '')).lower()
                if not any(kw in text for kw in HN_AI_KEYWORDS):
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
            log(f"    '{query}': {found} tools")
            time.sleep(1)
        except Exception as e:
            log(f"    Error: {e}")
    
    log(f"  HN total collected: {len(tools)}")
    return tools, 'requests'

# ─────────────────────────────────────────────
# PUBLIC AI API SOURCES
# ─────────────────────────────────────────────
def scrape_public_apis():
    tools = []
    log("  Source C: Public AI APIs — collecting tool directories")
    
    # Alternative AI tool directories with open APIs
    api_sources = [
        ("AI Tool Directory API", "https://aitoolsdir.com/api/tools", None),
    ]
    
    # Try scraping some accessible AI tool listing pages
    accessible_pages = [
        ("OpenAI Cookbook", "https://github.com/openai/openai-cookbook", "Collection of examples for solving common tasks with OpenAI APIs"),
        ("LangChain Docs", "https://github.com/langchain-ai/langchain", "Building applications with LLMs through composability"),
        ("LlamaIndex", "https://github.com/run-ai/llama-index", "Data framework for LLM applications"),
        ("AutoGPT", "https://github.com/Significant-Gravitas/AutoGPT", "Autonomous AI agent"),
        ("Dify", "https://github.com/langgenius/dify", "LLM app development platform"),
        ("FlowiseAI", "https://github.com/FlowiseAI/Flowise", "Drag & drop UI for LangChain"),
        ("ChatGLM", "https://github.com/THUDM/ChatGLM-6B", "Open bilingual LLM"),
        ("Vicuna", "https://github.com/lm-sys/FastChat", "Chatbot trained by fine-tuning LLaMA"),
        ("Oobabooga", "https://github.com/oobabooga/text-generation-webui", "WebUI for running LLMs locally"),
        ("PrivateGPT", "https://github.com/zylon-ai/private-gpt", "Ask questions to your documents using privacy"),
    ]
    
    for name, url, desc in accessible_pages:
        tools.append({
            'name': name, 'slug': slugify(name),
            'description': desc or '',
            'short_desc': (desc or '')[:200],
            'category': 'Open Source',
            'pricing': 'free',
            'website_url': url,
            'logo_url': get_logo_url(url),
            'tags': 'ai,opensource,github,direct',
        })
    
    # Also try the AI tools API if available
    try:
        r = requests.get('https://ai-api.vercel.app/api/tools', timeout=10)
        if r.status_code == 200:
            data = r.json()
            for item in data.get('tools', [])[:50]:
                tools.append({
                    'name': item.get('name', 'Unknown'),
                    'slug': slugify(item.get('name', 'Unknown')),
                    'description': item.get('description', ''),
                    'short_desc': (item.get('description', '') or '')[:200],
                    'category': item.get('category', 'AI Tools'),
                    'pricing': 'free',
                    'website_url': item.get('url', ''),
                    'logo_url': get_logo_url(item.get('url', '')),
                    'tags': 'ai,public-api',
                })
        log(f"    AI API returned {len([t for t in tools if 'vercel' in t.get('tags', '')])} tools")
    except Exception:
        pass
    
    log(f"  Public APIs total collected: {len(tools)}")
    return tools, 'requests'

# ─────────────────────────────────────────────
# CURATED AI CATALOG (supplemental data)
# ─────────────────────────────────────────────
CURATED_TOOLS = [
    # Writing
    ("Jasper AI", "jasper-ai", "AI content platform for marketing teams", "Writing", "freemium", "https://jasper.ai"),
    ("Copy.ai", "copyai", "AI copywriting tool for marketers", "Writing", "freemium", "https://copy.ai"),
    ("Rytr", "rytr", "AI writing assistant for content creators", "Writing", "freemium", "https://rytr.me"),
    ("Writesonic", "writesonic", "AI content generator for marketing", "Writing", "freemium", "https://writesonic.com"),
    ("Synthesia", "synthesia", "AI video generator with virtual avatars", "Video", "paid", "https://synthesia.io"),
    # Image
    ("DALL-E", "dall-e", "OpenAI image generation from text", "Image", "paid", "https://openai.com/dall-e-2"),
    ("Midjourney", "midjourney", "AI art generation via Discord", "Image", "paid", "https://midjourney.com"),
    ("Stable Diffusion", "stable-diffusion", "Open-source image generation model", "Image", "free", "https://stability.ai"),
    ("Leonardo AI", "leonardo-ai", "AI image generation platform", "Image", "freemium", "https://leonardo.ai"),
    ("ComfyUI", "comfyui", "Stable Diffusion GUI for power users", "Image", "free", "https://github.com/comfyanonymous/ComfyUI"),
    # Video
    ("Runway", "runwayml", "AI video editing and generation", "Video", "freemium", "https://runwayml.com"),
    ("Pictory", "pictory", "AI video creation from articles", "Video", "freemium", "https://pictory.ai"),
    ("Descript", "descript", "AI-powered video and podcast editor", "Video", "freemium", "https://descript.com"),
    ("HeyGen", "heygen", "AI video generation with avatars", "Video", "freemium", "https://heygen.com"),
    # Coding
    ("Cursor", "cursor-ai", "AI code editor built on VS Code", "Coding", "freemium", "https://cursor.sh"),
    ("Tabnine", "tabnine", "AI code completion for developers", "Coding", "freemium", "https://tabnine.com"),
    ("Codeium", "codeium", "Free AI code completion plugin", "Coding", "free", "https://codeium.com"),
    ("Goose", "goose-ai", "Open source AI coding assistant", "Coding", "free", "https://github.com/block/goose"),
    # Chat
    ("Character.AI", "character-ai", "AI character chatbot platform", "Chat", "freemium", "https://character.ai"),
    ("Pi AI", "pi-ai", "Empathetic AI companion", "Chat", "free", "https://pi.ai"),
    ("Perplexity", "perplexity-ai", "AI search engine with citations", "Research", "freemium", "https://perplexity.ai"),
    ("Grok", "grok-ai", "xAI chatbot by Elon Musk", "Chat", "freemium", "https://grok.x.ai"),
    # Audio
    ("ElevenLabs", "elevenlabs", "AI voice generation and cloning", "Audio", "freemium", "https://elevenlabs.io"),
    ("Murf AI", "murf-ai", "AI voiceover generator", "Audio", "freemium", "https://murf.ai"),
    ("Speechify", "speechify", "AI text-to-speech reader", "Audio", "freemium", "https://speechify.com"),
    # Business
    ("Notion AI", "notion-ai", "AI features for Notion workspace", "Business", "freemium", "https://notion.so"),
    ("Grammarly", "grammarly", "AI writing assistant and checker", "Writing", "freemium", "https://grammarly.com"),
    ("QuillBot", "quillbot", "AI paraphrasing and grammar tool", "Writing", "freemium", "https://quillbot.com"),
    ("Tome", "tome-ai", "AI presentation generator", "Business", "freemium", "https://tome.app"),
    ("Gamma", "gamma-ai", "AI document and deck creator", "Business", "freemium", "https://gamma.app"),
    # Research
    ("Elicit", "elicit", "AI research assistant for papers", "Research", "freemium", "https://elicit.org"),
    ("Consensus", "consensus-ai", "AI research search engine", "Research", "freemium", "https://consensus.app"),
    ("Scite", "scite-ai", "AI citation intelligence", "Research", "freemium", "https://scite.ai"),
    # Automation
    ("Make", "make-com", "Visual automation platform", "Automation", "freemium", "https://make.com"),
    ("n8n", "n8n-io", "Fair-code workflow automation", "Automation", "free", "https://n8n.io"),
    ("Zapier AI", "zapier-ai", "AI-powered automation platform", "Automation", "freemium", "https://zapier.com"),
    # Analytics
    ("Vercel AI", "vercel-ai", "AI toolkit for web applications", "Analytics", "free", "https://vercel.com/ai"),
    ("LangSmith", "langsmith", "Debug and evaluate LLM apps", "Analytics", "freemium", "https://smith.langchain.com"),
    # Marketing
    ("Copy.ai", "copy-ai", "AI marketing copy generator", "Marketing", "freemium", "https://copy.ai"),
    ("Hypedesk", "hypedesk", "AI social media content", "Marketing", "freemium", "https://hypedesk.ai"),
    # Finance
    ("Kepler", "kepler-finance", "AI financial planning", "Finance", "free", "https://kepler.money"),
    ("Gem", "gem-finance", "AI personal finance assistant", "Finance", "freemium", "https://gem.com"),
    # Education
    ("Quizlet", "quizlet-ai", "AI-powered flashcards", "Education", "freemium", "https://quizlet.com"),
    ("Wyzant", "wyzant-ai", "AI tutoring platform", "Education", "freemium", "https://wyzant.com"),
    ("Duolingo", "duolingo-ai", "AI language learning", "Education", "free", "https://duolingo.com"),
    # Health
    ("Woebot", "woebot", "AI mental health companion", "Health", "freemium", "https://woebothealth.com"),
    ("Mindset", "mindset-ai", "AI wellness and meditation", "Health", "freemium", "https://getmindset.com"),
]

def add_curated_tools():
    tools = []
    log("  Source D: Curated AI Catalog — adding known tools")
    for name, slug, desc, category, pricing, url in CURATED_TOOLS:
        tools.append({
            'name': name, 'slug': slug,
            'description': desc,
            'short_desc': desc[:200],
            'category': category,
            'pricing': pricing,
            'website_url': url,
            'logo_url': get_logo_url(url),
            'tags': 'ai,curated',
        })
    log(f"  Curated tools added: {len(tools)}")
    return tools, 'curated'

# ─────────────────────────────────────────────
# MAIN
# ─────────────────────────────────────────────
def main():
    log("=" * 60)
    log("Bulk Data Collector — Starting")
    log("=" * 60)

    progress = load_progress()
    seen_urls = load_dedup_set()
    total_scraped = 0
    total_inserted = 0

    # Source A: GitHub
    if "Source A: GitHub API" not in progress.get('sources_completed', []):
        log(f"\n{'='*60}")
        log("Source A: GitHub API")
        log(f"{'='*60}")
        tools, method = scrape_github_fast()
        log(f"  Method: {method}, Scraped: {len(tools)}")
        
        new_tools = []
        for t in tools:
            key = dedupe_key(t['website_url'])
            if key in seen_urls:
                continue
            seen_urls.add(key)
            new_tools.append(t)
        
        log(f"  New unique: {len(new_tools)}")
        BATCH = 25
        for i in range(0, len(new_tools), BATCH):
            batch = new_tools[i:i+BATCH]
            ins, skp = insert_into_d1(batch)
            log(f"    Batch {i//BATCH + 1}: inserted {ins}/{len(batch)}")
            total_inserted += ins
        total_scraped += len(new_tools)
        if "Source A: GitHub API" not in progress.get('sources_completed', []):
            progress.setdefault('sources_completed', []).append("Source A: GitHub API")
        progress['tools_scraped'] = total_scraped
        progress['tools_inserted'] = total_inserted
        save_progress(progress)
        save_dedup_set(seen_urls)

    # Source B: HN
    if "Source B: HackerNews Algolia" not in progress.get('sources_completed', []):
        log(f"\n{'='*60}")
        log("Source B: HackerNews Algolia")
        log(f"{'='*60}")
        tools, method = scrape_hn_fast()
        log(f"  Method: {method}, Scraped: {len(tools)}")
        
        new_tools = []
        for t in tools:
            key = dedupe_key(t['website_url'])
            if key in seen_urls:
                continue
            seen_urls.add(key)
            new_tools.append(t)
        
        log(f"  New unique: {len(new_tools)}")
        BATCH = 25
        for i in range(0, len(new_tools), BATCH):
            batch = new_tools[i:i+BATCH]
            ins, skp = insert_into_d1(batch)
            log(f"    Batch {i//BATCH + 1}: inserted {ins}/{len(batch)}")
            total_inserted += ins
        total_scraped += len(new_tools)
        if "Source B: HackerNews Algolia" not in progress.get('sources_completed', []):
            progress.setdefault('sources_completed', []).append("Source B: HackerNews Algolia")
        progress['tools_scraped'] = total_scraped
        progress['tools_inserted'] = total_inserted
        save_progress(progress)
        save_dedup_set(seen_urls)

    # Source C: Public APIs
    if "Source C: Public AI APIs" not in progress.get('sources_completed', []):
        log(f"\n{'='*60}")
        log("Source C: Public AI APIs")
        log(f"{'='*60}")
        tools, method = scrape_public_apis()
        log(f"  Method: {method}, Scraped: {len(tools)}")
        
        new_tools = []
        for t in tools:
            key = dedupe_key(t['website_url'])
            if key in seen_urls:
                continue
            seen_urls.add(key)
            new_tools.append(t)
        
        log(f"  New unique: {len(new_tools)}")
        BATCH = 25
        for i in range(0, len(new_tools), BATCH):
            batch = new_tools[i:i+BATCH]
            ins, skp = insert_into_d1(batch)
            log(f"    Batch {i//BATCH + 1}: inserted {ins}/{len(batch)}")
            total_inserted += ins
        total_scraped += len(new_tools)
        if "Source C: Public AI APIs" not in progress.get('sources_completed', []):
            progress.setdefault('sources_completed', []).append("Source C: Public AI APIs")
        progress['tools_scraped'] = total_scraped
        progress['tools_inserted'] = total_inserted
        save_progress(progress)
        save_dedup_set(seen_urls)

    # Source D: Curated
    if "Source D: Curated AI Catalog" not in progress.get('sources_completed', []):
        log(f"\n{'='*60}")
        log("Source D: Curated AI Catalog")
        log(f"{'='*60}")
        tools, method = add_curated_tools()
        log(f"  Method: {method}, Scraped: {len(tools)}")
        
        new_tools = []
        for t in tools:
            key = dedupe_key(t['website_url'])
            if key in seen_urls:
                continue
            seen_urls.add(key)
            new_tools.append(t)
        
        log(f"  New unique: {len(new_tools)}")
        BATCH = 25
        for i in range(0, len(new_tools), BATCH):
            batch = new_tools[i:i+BATCH]
            ins, skp = insert_into_d1(batch)
            log(f"    Batch {i//BATCH + 1}: inserted {ins}/{len(batch)}")
            total_inserted += ins
        total_scraped += len(new_tools)
        if "Source D: Curated AI Catalog" not in progress.get('sources_completed', []):
            progress.setdefault('sources_completed', []).append("Source D: Curated AI Catalog")
        progress['tools_scraped'] = total_scraped
        progress['tools_inserted'] = total_inserted
        save_progress(progress)
        save_dedup_set(seen_urls)

    # Final summary
    log(f"\n{'='*60}")
    log("COLLECTION COMPLETE")
    log(f"{'='*60}")
    log(f"Sources completed: {len(progress.get('sources_completed', []))}/4")
    log(f"Total scraped: {total_scraped}")
    log(f"Total inserted (unique): {total_inserted}")
    final_count = get_d1_count()
    log(f"Final D1 count: {final_count}")
    
    # Print wrangler count
    subprocess.run([
        'wrangler', 'd1', 'execute', DB_NAME, '--remote',
        '--command', "SELECT COUNT(*) as total FROM tools WHERE status='published'"
    ], env={**os.environ, 'CF_API_TOKEN': CF_API_TOKEN, 'CLOUDFLARE_API_TOKEN': CF_API_TOKEN, 'CLOUDFLARE_ACCOUNT_ID': CF_ACCOUNT_ID})

if __name__ == '__main__':
    main()
