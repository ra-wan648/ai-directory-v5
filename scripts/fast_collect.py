#!/usr/bin/env python3
"""
Fast AI Tools Bulk Inserter
Collects from HN Algolia + Curated catalog, batch inserts into D1.
GitHub source skipped due to rate limiting.
"""

import os
import re
import json
import time
import hashlib
import subprocess
from urllib.parse import urlparse, quote
from datetime import datetime

import requests

CF_API_TOKEN = os.environ.get('CF_API_TOKEN', '')
CF_ACCOUNT_ID = os.environ.get('CLOUDFLARE_ACCOUNT_ID', '')
CF_D1_ID = 'ff26faf5-3c7c-445a-a249-6c96fedddfdc'
DB_NAME = 'ai-directory-db'

PROGRESS_FILE = '/tmp/fast_collect_progress.json'
DEDUP_FILE = '/tmp/fast_collect_dedup.json'

def log(msg):
    print(f"[{datetime.now().strftime('%H:%M:%S')}] {msg}", flush=True)

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

def escape_sql(s):
    return str(s).replace("'", "''")

def batch_insert(tools_batch):
    """Batch insert using single SQL with multiple VALUES."""
    if not tools_batch:
        return 0, 0
    env = os.environ.copy()
    env['CF_API_TOKEN'] = CF_API_TOKEN
    env['CLOUDFLARE_API_TOKEN'] = CF_API_TOKEN
    env['CLOUDFLARE_ACCOUNT_ID'] = CF_ACCOUNT_ID
    
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
    
    # Split into chunks of 30 to avoid query size limits
    chunk_size = 30
    total_inserted = 0
    for i in range(0, len(values), chunk_size):
        chunk = values[i:i+chunk_size]
        sql = f"INSERT INTO tools (name, slug, description, short_desc, category, pricing, url, logo_url, logo_type, tags, status, created_at) VALUES {', '.join(chunk)} ON CONFLICT(slug) DO NOTHING"
        r = subprocess.run(
            ['wrangler', 'd1', 'execute', DB_NAME, '--remote', '--command', sql],
            capture_output=True, text=True, timeout=60, env=env
        )
        if r.returncode == 0 and '✘' not in r.stdout and 'ERROR' not in r.stdout:
            try:
                data = json.loads(r.stdout)
                meta = data.get('result', [{}])[0].get('meta', {})
                total_inserted += meta.get('changes', 0)
            except Exception:
                total_inserted += len(chunk)
        time.sleep(0.3)
    
    return total_inserted, len(tools_batch) - total_inserted

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
# HN ALGOLIA
# ─────────────────────────────────────────────
HN_KEYWORDS = ['ai', 'artificial intelligence', 'machine learning', 'llm', 'gpt', 'claude', 
               'chatbot', 'agent', 'generative', 'prompt', 'neural', 'diffusion', 'nlp',
               'computer vision', 'speech', 'translation', 'automate', 'automation', 
               'coding', 'assistant', 'text-to-image', 'stable diffusion']

def scrape_hn():
    tools = []
    log("  Source A: HackerNews Algolia")
    
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
        'AI assistant', 'AI search', 'AI coding', 'AI design',
        'Show HN AI startup', 'Show HN SaaS AI', 'Show HN open source LLM',
        'AI API', 'AI platform', 'AI SaaS', 'AI startup',
        'machine learning tool', 'deep learning tool', 'neural network tool',
        'text generation AI', 'image generation AI', 'video generation AI',
        'code generation AI', 'writing AI', 'design AI',
        'Show HN AI tool', 'Show HN GPT', 'Show HN Claude',
        'AI writing assistant', 'AI code editor', 'AI video editor',
        'AI image editor', 'AI music generator', 'AI podcast tool',
        'AI translation', 'AI summarizer', 'AI research',
    ]
    
    for query in queries:
        url = f"https://hn.algolia.com/api/v1/search?query={quote(query)}&tags=story&hitsPerPage=100"
        try:
            r = requests.get(url, headers={'User-Agent': 'Mozilla/5.0'}, timeout=20)
            data = r.json()
            hits = data.get('hits', [])
            found = 0
            for hit in hits:
                if hit.get('points', 0) < 10:
                    continue
                title = hit.get('title', '')
                story_url = hit.get('url', '')
                if not title or not story_url:
                    continue
                text = (title + ' ' + hit.get('story_text', '')).lower()
                if not any(kw in text for kw in HN_KEYWORDS):
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
            time.sleep(0.5)
        except Exception as e:
            log(f"    Error: {e}")
    
    log(f"  HN total: {len(tools)}")
    return tools, 'requests'

# ─────────────────────────────────────────────
# CURATED TOOLS (large catalog)
# ─────────────────────────────────────────────
CURATED = [
    # Writing
    ("Jasper AI", "jasper-ai", "AI content platform for marketing teams", "Writing", "freemium", "https://jasper.ai"),
    ("Copy.ai", "copyai", "AI copywriting tool for marketers", "Writing", "freemium", "https://copy.ai"),
    ("Rytr", "rytr", "AI writing assistant for content creators", "Writing", "freemium", "https://rytr.me"),
    ("Writesonic", "writesonic", "AI content generator for marketing", "Writing", "freemium", "https://writesonic.com"),
    ("QuillBot", "quillbot", "AI paraphrasing and grammar tool", "Writing", "freemium", "https://quillbot.com"),
    ("Grammarly", "grammarly", "AI writing assistant and checker", "Writing", "freemium", "https://grammarly.com"),
    ("Surfer SEO", "surfer-seo", "AI-powered SEO content optimizer", "Marketing", "paid", "https://surferseo.com"),
    ("Wordtune", "wordtune", "AI writing companion for Gmail", "Writing", "freemium", "https://wordtune.com"),
    ("Hemingway Editor", "hemingway-editor", "AI-powered text editor for clarity", "Writing", "free", "https://hemingwayapp.com"),
    ("Scripted", "scripted", "AI content marketplace", "Writing", "paid", "https://scripted.com"),
    # Image
    ("DALL-E", "dall-e", "OpenAI image generation from text", "Image", "paid", "https://openai.com/dall-e-2"),
    ("Midjourney", "midjourney", "AI art generation via Discord", "Image", "paid", "https://midjourney.com"),
    ("Stable Diffusion", "stable-diffusion", "Open-source image generation model", "Image", "free", "https://stability.ai"),
    ("Leonardo AI", "leonardo-ai", "AI image generation platform", "Image", "freemium", "https://leonardo.ai"),
    ("ComfyUI", "comfyui", "Stable Diffusion GUI for power users", "Image", "free", "https://github.com/comfyanonymous/ComfyUI"),
    ("Adobe Firefly", "adobe-firefly", "Adobe AI image generation", "Image", "freemium", "https://firefly.adobe.com"),
    ("Canva AI", "canva-ai", "AI design platform", "Image", "freemium", "https://canva.com"),
    ("DreamStudio", "dreamstudio", "Stable Diffusion web UI", "Image", "paid", "https://dreamstudio.ai"),
    ("Magnific AI", "magnific-ai", "AI image upscaler and enhancer", "Image", "paid", "https://magnific.ai"),
    ("Clipdrop", "clipdrop", "AI image editing tools", "Image", "freemium", "https://clipdrop.co"),
    # Video
    ("Runway", "runwayml", "AI video editing and generation", "Video", "freemium", "https://runwayml.com"),
    ("Pictory", "pictory", "AI video creation from articles", "Video", "freemium", "https://pictory.ai"),
    ("Descript", "descript", "AI-powered video and podcast editor", "Video", "freemium", "https://descript.com"),
    ("HeyGen", "heygen", "AI video generation with avatars", "Video", "freemium", "https://heygen.com"),
    ("Synthesia", "synthesia", "AI video generator with virtual avatars", "Video", "paid", "https://synthesia.io"),
    ("InVideo AI", "invideo-ai", "AI video creation platform", "Video", "freemium", "https://invideo.io"),
    ("Kapwing", "kapwing", "AI video editor and meme maker", "Video", "freemium", "https://kapwing.com"),
    ("Opus Clip", "opus-clip", "AI video clipping for shorts", "Video", "freemium", "https://opus.pro"),
    # Chat
    ("Character.AI", "character-ai", "AI character chatbot platform", "Chat", "freemium", "https://character.ai"),
    ("Pi AI", "pi-ai", "Empathetic AI companion", "Chat", "free", "https://pi.ai"),
    ("Perplexity", "perplexity-ai", "AI search engine with citations", "Research", "freemium", "https://perplexity.ai"),
    ("Grok", "grok-ai", "xAI chatbot by Elon Musk", "Chat", "freemium", "https://grok.x.ai"),
    ("HuggingChat", "huggingchat", "Open-source AI chat interface", "Chat", "free", "https://huggingface.co/chat"),
    ("ChatGLM", "chatglm", "Open bilingual LLM chatbot", "Chat", "free", "https://github.com/THUDM/ChatGLM-6B"),
    # Audio
    ("ElevenLabs", "elevenlabs", "AI voice generation and cloning", "Audio", "freemium", "https://elevenlabs.io"),
    ("Murf AI", "murf-ai", "AI voiceover generator", "Audio", "freemium", "https://murf.ai"),
    ("Speechify", "speechify", "AI text-to-speech reader", "Audio", "freemium", "https://speechify.com"),
    ("Replicate", "replicate", "AI audio model hosting", "Audio", "paid", "https://replicate.com"),
    # Coding
    ("Cursor", "cursor-ai", "AI code editor built on VS Code", "Coding", "freemium", "https://cursor.sh"),
    ("Tabnine", "tabnine", "AI code completion for developers", "Coding", "freemium", "https://tabnine.com"),
    ("Codeium", "codeium", "Free AI code completion plugin", "Coding", "free", "https://codeium.com"),
    ("Goose", "goose-ai", "Open source AI coding assistant", "Coding", "free", "https://github.com/block/goose"),
    ("Windsurf", "windsurf-ai", "AI code editor by Codeium", "Coding", "freemium", "https://windsurf.ai"),
    ("Replit AI", "replit-ai", "AI coding assistant in browser", "Coding", "freemium", "https://replit.com"),
    # Research
    ("Elicit", "elicit", "AI research assistant for papers", "Research", "freemium", "https://elicit.org"),
    ("Consensus", "consensus-ai", "AI research search engine", "Research", "freemium", "https://consensus.app"),
    ("Scite", "scite-ai", "AI citation intelligence", "Research", "freemium", "https://scite.ai"),
    ("Scholarcy", "scholarcy", "AI research paper summarizer", "Research", "freemium", "https://scholarcy.com"),
    # Business
    ("Notion AI", "notion-ai", "AI features for Notion workspace", "Business", "freemium", "https://notion.so"),
    ("Tome", "tome-ai", "AI presentation generator", "Business", "freemium", "https://tome.app"),
    ("Gamma", "gamma-ai", "AI document and deck creator", "Business", "freemium", "https://gamma.app"),
    ("Decktopus", "decktopus", "AI slide deck generator", "Business", "freemium", "https://decktopus.com"),
    ("Beautiful.ai", "beautiful-ai", "AI-powered presentation tool", "Business", "paid", "https://beautiful.ai"),
    # Automation
    ("Make", "make-com", "Visual automation platform", "Automation", "freemium", "https://make.com"),
    ("n8n", "n8n-io", "Fair-code workflow automation", "Automation", "free", "https://n8n.io"),
    ("Zapier AI", "zapier-ai", "AI-powered automation platform", "Automation", "freemium", "https://zapier.com"),
    ("Bardeen", "bardeen", "AI automation for browsers", "Automation", "freemium", "https://bardeen.ai"),
    # Analytics
    ("Vercel AI", "vercel-ai", "AI toolkit for web applications", "Analytics", "free", "https://vercel.com/ai"),
    ("LangSmith", "langsmith", "Debug and evaluate LLM apps", "Analytics", "freemium", "https://smith.langchain.com"),
    # Finance
    ("Kepler", "kepler-finance", "AI financial planning", "Finance", "free", "https://kepler.money"),
    ("Gem", "gem-finance", "AI personal finance assistant", "Finance", "freemium", "https://gem.com"),
    ("Plainills", "plainills", "AI expense tracking", "Finance", "free", "https://plainills.com"),
    # Education
    ("Quizlet", "quizlet-ai", "AI-powered flashcards", "Education", "freemium", "https://quizlet.com"),
    ("Duolingo", "duolingo-ai", "AI language learning", "Education", "free", "https://duolingo.com"),
    ("Khan Academy", "khan-academy", "Free AI-powered education", "Education", "free", "https://khanacademy.org"),
    # Health
    ("Woebot", "woebot", "AI mental health companion", "Health", "freemium", "https://woebotehealth.com"),
    ("Mindset", "mindset-ai", "AI wellness and meditation", "Health", "freemium", "https://getmindset.com"),
    ("Wysa", "wysa", "AI mental health coach", "Health", "freemium", "https://wysa.io"),
    # Marketing
    ("Hypedesk", "hypedesk", "AI social media content", "Marketing", "freemium", "https://hypedesk.ai"),
    ("Quill", "quill-marketing", "AI marketing copy", "Marketing", "freemium", "https://quill.ai"),
    # Open Source Projects
    ("AutoGPT", "autogpt", "Autonomous AI agent", "Automation", "free", "https://github.com/Significant-Gravitas/AutoGPT"),
    ("Dify", "dify-ai", "LLM app development platform", "Coding", "free", "https://github.com/langgenius/dify"),
    ("FlowiseAI", "flowiseai", "Drag & drop UI for LangChain", "Coding", "free", "https://github.com/FlowiseAI/Flowise"),
    ("PrivateGPT", "privategpt", "Ask questions to your documents privately", "Research", "free", "https://github.com/zylon-ai/private-gpt"),
    ("Oobabooga", "oobabooga", "WebUI for running LLMs locally", "Coding", "free", "https://github.com/oobabooga/text-generation-webui"),
    ("Vicuna", "vicuna-ai", "Chatbot trained by fine-tuning LLaMA", "Chat", "free", "https://github.com/lm-sys/FastChat"),
    ("LlamaIndex", "llamaindex", "Data framework for LLM applications", "Coding", "free", "https://github.com/run-ai/llama-index"),
    ("LangChain", "langchain", "Framework for LLM-powered applications", "Coding", "free", "https://github.com/langchain-ai/langchain"),
]

def add_curated():
    tools = []
    log("  Source B: Curated AI Catalog")
    for name, slug, desc, category, pricing, url in CURATED:
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
    log(f"  Curated tools: {len(tools)}")
    return tools, 'curated'

# ─────────────────────────────────────────────
# MAIN
# ─────────────────────────────────────────────
def main():
    log("=" * 60)
    log("Fast AI Tools Collector — Starting")
    log("=" * 60)

    progress = load_progress()
    seen_urls = load_dedup_set()
    total_scraped = 0
    total_inserted = 0

    sources = [
        ("Source A: HackerNews Algolia", scrape_hn),
        ("Source B: Curated AI Catalog", add_curated),
    ]

    for source_name, scraper_fn in sources:
        if source_name in progress.get('sources_completed', []):
            log(f"\n{source_name} — SKIPPED")
            continue
        
        log(f"\n{'='*60}")
        log(source_name)
        log(f"{'='*60}")
        
        tools, method = scraper_fn()
        log(f"  Scraped: {len(tools)}")
        
        new_tools = []
        for t in tools:
            key = dedupe_key(t['website_url'])
            if key in seen_urls:
                continue
            seen_urls.add(key)
            new_tools.append(t)
        
        log(f"  New unique: {len(new_tools)}")
        
        # Insert in batches of 30
        BATCH = 30
        for i in range(0, len(new_tools), BATCH):
            batch = new_tools[i:i+BATCH]
            ins, skp = batch_insert(batch)
            log(f"    Batch {i//BATCH + 1}: inserted {ins}/{len(batch)}")
            total_inserted += ins
            time.sleep(0.5)
        
        total_scraped += len(new_tools)
        if source_name not in progress.get('sources_completed', []):
            progress.setdefault('sources_completed', []).append(source_name)
        progress['tools_scraped'] = total_scraped
        progress['tools_inserted'] = total_inserted
        save_progress(progress)
        save_dedup_set(seen_urls)
        
        count = get_d1_count()
        log(f"  D1 count: {count}")

    log(f"\n{'='*60}")
    log("COMPLETE")
    log(f"Scraped: {total_scraped}, Inserted: {total_inserted}")
    log(f"Final D1 count: {get_d1_count()}")

if __name__ == '__main__':
    main()
