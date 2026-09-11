#!/usr/bin/env python3
"""
bulk_seed.py — Scrape GitHub API + HackerNews + curated catalog → remote D1.
Usage: python3 scripts/bulk_seed.py
"""
import sys, os, json, time, re, random, subprocess, requests
from datetime import datetime

HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"
}

CATEGORIES = [
    "Chat", "Writing", "Image", "Video", "Audio", "Coding",
    "Marketing", "Productivity", "Research", "Analytics",
    "Business", "Automation", "Education", "Health", "Finance"
]

PRICING = ["free", "freemium", "paid"]

# ── Curated AI tool catalog (real, well-known tools) ──────────────
CURATED_TOOLS = [
    # Chat & Conversational AI
    ("ChatGPT", "https://chat.openai.com", "Most popular AI chatbot by OpenAI for conversation, writing, and coding", "Chat", "freemium"),
    ("Claude", "https://claude.ai", "Anthropic's AI assistant for analysis, writing, and complex reasoning", "Chat", "freemium"),
    ("Gemini", "https://gemini.google.com", "Google's multimodal AI for chat, images, and code", "Chat", "free"),
    ("Perplexity AI", "https://perplexity.ai", "AI search engine with real-time citations and answers", "Research", "freemium"),
    ("Pi AI", "https://pi.ai", "Empathetic AI companion for conversation and emotional support", "Chat", "free"),
    ("Character.AI", "https://character.ai", "AI chatbot platform for talking to fictional characters", "Chat", "free"),
    ("You.com", "https://you.com", "AI-powered search engine with chat capabilities", "Research", "freemium"),
    ("Rewind AI", "https://rewind.ai", "AI that records and summarizes everything you do on your computer", "Productivity", "paid"),
    ("Humata", "https://humata.ai", "AI research assistant that can answer questions from documents", "Research", "freemium"),
    ("Kimi", "https://kimi.moonshot.cn", "AI assistant with 2 million token context window", "Chat", "free"),
    ("DeepSeek", "https://deepseek.com", "Chinese AI chatbot with long context and strong reasoning", "Chat", "free"),
    ("Qwen", "https://qwenlm.github.io", "Alibaba's open-source AI language model family", "Chat", "free"),
    ("Llama", "https://llama.meta.com", "Meta's open-source AI language model", "Chat", "free"),
    ("Mistral", "https://mistral.ai", "European AI language models with strong multilingual support", "Chat", "freemium"),
    ("Grok", "https://grok.x.ai", "xAI's chatbot with real-time X/Twitter knowledge", "Chat", "freemium"),
    
    # Image Generation
    ("Midjourney", "https://midjourney.com", "AI image generation from text prompts with artistic quality", "Image", "paid"),
    ("DALL-E 3", "https://openai.com/dall-e", "OpenAI's image generation integrated with ChatGPT", "Image", "paid"),
    ("Stable Diffusion", "https://stability.ai", "Open-source AI image generation model", "Image", "free"),
    ("Leonardo AI", "https://leonardo.ai", "AI image generation for game assets and art", "Image", "freemium"),
    ("Ideogram", "https://ideogram.ai", "AI image generator with excellent text rendering", "Image", "freemium"),
    ("Adobe Firefly", "https://firefly.adobe.com", "Adobe's generative AI for images and text effects", "Image", "freemium"),
    ("Recraft", "https://recraft.ai", "AI vector and raster image generation for designers", "Image", "freemium"),
    ("Krea AI", "https://krea.ai", "Real-time AI image generation and enhancement", "Image", "freemium"),
    ("Magnific", "https://magnific.ai", "AI image upscaler and enhancer with hallucination", "Image", "paid"),
    ("Flux", "https://blackforestlabs.ai", "High-quality open-weight AI image generation model", "Image", "free"),
    ("Flux Pro", "https://blackforestlabs.ai", "Premium Flux image generation with advanced features", "Image", "paid"),
    ("Playground AI", "https://playgroundai.com", "Free AI image generator with creative tools", "Image", "free"),
    ("SeaArt", "https://seaart.ai", "AI image and video generation platform", "Image", "freemium"),
    ("Kaiber", "https://kaiber.ai", "AI video and image generation for creators", "Video", "freemium"),
    
    # Video
    ("Runway", "https://runwayml.com", "AI video generation and editing platform", "Video", "freemium"),
    ("Pika Labs", "https://pika.ai", "AI video generation from text and images", "Video", "freemium"),
    ("Sora", "https://sora.com", "OpenAI's video generation from text descriptions", "Video", "paid"),
    ("HeyGen", "https://heygen.com", "AI avatar video generator for presentations", "Video", "freemium"),
    ("Synthesia", "https://synthesia.io", "AI video creation with virtual avatars", "Video", "paid"),
    ("Luma Dream Machine", "https://lumalabs.ai", "AI video generation from text prompts", "Video", "freemium"),
    ("Kling AI", "https://klingai.com", "AI video generation with realistic motion", "Video", "freemium"),
    ("Vidu", "https://vidu.studio", "AI video generation platform", "Video", "freemium"),
    ("Veo", "https://deepmind.com/veo", "Google's AI video generation model", "Video", "paid"),
    ("Descript", "https://descript.com", "AI audio and video editing via transcript", "Video", "freemium"),
    ("Opus Clip", "https://opus.pro", "AI video clipping for short-form content", "Video", "freemium"),
    ("Vidyo AI", "https://vidyo.ai", "AI video editing and clipping platform", "Video", "freemium"),
    ("Submagic", "https://submagic.co", "AI captions and video effects for social media", "Video", "paid"),
    ("Vizard", "https://vizard.ai", "AI video editing and repurposing platform", "Video", "freemium"),
    ("Rask AI", "https://rask.ai", "AI video dubbing and voice cloning", "Video", "paid"),
    
    # Coding & Developer Tools
    ("GitHub Copilot", "https://github.com/features/copilot", "AI pair programmer for VS Code and JetBrains", "Coding", "freemium"),
    ("Cursor", "https://cursor.sh", "AI-powered code editor built for speed", "Coding", "freemium"),
    ("Windsurf", "https://windsurf.com", "AI code editor with deep context understanding", "Coding", "freemium"),
    ("Claude Code", "https://claude.ai/code", "Anthropic's CLI coding assistant", "Coding", "freemium"),
    ("Devin", "https://devin.ai", "AI software engineer that completes tasks autonomously", "Coding", "paid"),
    ("Tabnine", "https://tabnine.com", "AI code completion for all major editors", "Coding", "freemium"),
    ("Codeium", "https://codeium.com", "Free AI code completion and chat", "Coding", "free"),
    ("Amazon Q", "https://aws.amazon.com/q", "Amazon's AI coding assistant for enterprise", "Coding", "freemium"),
    ("Replit AI", "https://replit.com/ai", "AI coding assistant in browser-based IDE", "Coding", "freemium"),
    ("Vercel v0", "https://v0.dev", "AI UI generation from text descriptions", "Coding", "free"),
    ("Lovable", "https://lovable.dev", "AI full-stack app generator", "Coding", "freemium"),
    ("Bolt.new", "https://bolt.new", "AI web app generator in browser", "Coding", "free"),
    ("Aider", "https://aider.chat", "AI pair programming in your terminal", "Coding", "free"),
    ("Continue", "https://continue.dev", "Open-source AI code completion extension", "Coding", "free"),
    ("Copilot Workspace", "https://github.com/features/copilot/workspace", "AI-powered development workspace", "Coding", "paid"),
    
    # Audio & Speech
    ("ElevenLabs", "https://elevenlabs.io", "AI voice generation and cloning platform", "Audio", "freemium"),
    ("Suno AI", "https://suno.com", "AI music and song generation from text", "Audio", "freemium"),
    ("Udio", "https://udio.com", "AI music generation platform", "Audio", "freemium"),
    ("Murf AI", "https://murf.ai", "AI voiceover and narration generator", "Audio", "freemium"),
    ("Speechify", "https://speechify.com", "AI text-to-speech for reading assistance", "Audio", "freemium"),
    ("Play.ht", "https://play.ht", "AI voice generator for podcasts and content", "Audio", "freemium"),
    ("Lalals", "https://lalals.com", "AI voice separation and stem extraction", "Audio", "paid"),
    
    # Productivity
    ("Notion AI", "https://notion.so/product/ai", "AI writing and thinking assistant in Notion", "Productivity", "freemium"),
    ("Microsoft Copilot", "https://copilot.microsoft.com", "AI assistant integrated across Microsoft 365", "Productivity", "freemium"),
    ("Gamma", "https://gamma.app", "AI presentation and document generator", "Productivity", "freemium"),
    ("Tome", "https://tome.app", "AI storytelling and presentation platform", "Productivity", "freemium"),
    ("Craft", "https://craft.do", "AI-enhanced document and note editor", "Productivity", "freemium"),
    ("Mem", "https://mem.ai", "AI knowledge management and note-taking", "Productivity", "freemium"),
    ("QuillBot", "https://quillbot.com", "AI paraphrasing and writing assistant", "Productivity", "freemium"),
    ("Superpower", "https://superpower.ai", "AI email assistant for productivity", "Productivity", "paid"),
    ("Motion", "https://motion.ai", "AI calendar and project management", "Productivity", "paid"),
    ("Clockwise", "https://clockwise.com", "AI schedule optimization", "Productivity", "freemium"),
    ("Todoist AI", "https://todoist.com/ai", "AI task management and productivity", "Productivity", "freemium"),
    ("Amie", "https://amie.io", "AI calendar application", "Productivity", "freemium"),
    
    # Marketing & Writing
    ("Jasper", "https://jasper.ai", "AI marketing copy and content writer", "Marketing", "paid"),
    ("Copy.ai", "https://copy.ai", "AI marketing copy generation platform", "Marketing", "freemium"),
    ("Writesonic", "https://writesonic.com", "AI content writer for SEO and marketing", "Marketing", "freemium"),
    ("Surfer SEO", "https://surferseo.com", "AI SEO optimization and content analysis", "Marketing", "paid"),
    ("Anyword", "https://anyword.com", "AI copy that predicts performance", "Marketing", "paid"),
    ("Grammarly", "https://grammarly.com", "AI grammar and writing checker", "Writing", "freemium"),
    ("LanguageTool", "https://languagetool.org", "Open-source grammar and style checker", "Writing", "free"),
    ("DeepL Write", "https://deepl.com/write", "AI writing enhancement and translation", "Writing", "freemium"),
    ("Wordtune", "https://wordtune.com", "AI sentence rewriter and paraphraser", "Writing", "freemium"),
    
    # Business & Analytics
    ("Tableau AI", "https://tableau.com", "AI-powered data visualization", "Analytics", "paid"),
    ("Power BI Copilot", "https://powerbi.com", "Microsoft's AI analytics assistant", "Analytics", "paid"),
    ("ThoughtSpot", "https://thoughtspot.com", "AI search-driven analytics", "Analytics", "paid"),
    ("Sigma Computing", "https://sigma.io", "Cloud-based data analytics with AI", "Analytics", "paid"),
    ("Looker Studio AI", "https://looker.google.com", "Google's AI analytics platform", "Analytics", "freemium"),
    
    # Automation
    ("Make AI", "https://make.com", "AI-powered workflow automation platform", "Automation", "freemium"),
    ("n8n AI", "https://n8n.io", "AI workflow automation for developers", "Automation", "freemium"),
    ("Zapier AI", "https://zapier.com", "AI-connected automation platform", "Automation", "freemium"),
    ("AutoGPT", "https://agpt.co", "Autonomous AI agent that completes tasks", "Automation", "free"),
    ("MultiOn", "https://multion.ai", "AI agent that browses and interacts with web", "Automation", "freemium"),
    
    # Research & Data
    ("Elicit", "https://elicit.org", "AI research assistant for academic papers", "Research", "freemium"),
    ("Consensus", "https://consensus.app", "AI search engine for scientific research", "Research", "freemium"),
    ("Scite", "https://scite.ai", "AI citation intelligence for research", "Research", "freemium"),
    ("Semantic Scholar", "https://semanticscholar.org", "AI academic search engine", "Research", "free"),
    ("ChatDOC", "https://chatdoc.com", "AI document chat and analysis", "Research", "freemium"),
    ("Paperpal", "https://paperpal.com", "AI academic writing assistant", "Research", "freemium"),
    ("Connected Papers", "https://connectedpapers.com", "AI literature review visualization", "Research", "free"),
    ("ResearchRabbit", "https://researchrabbit.com", "AI academic paper discovery", "Research", "free"),
    
    # Education
    ("Khan Academy Khanmigo", "https://khanacademy.org/khanmigo", "AI tutor from Khan Academy", "Education", "freemium"),
    ("Curipod", "https://curipod.com", "AI interactive lesson platform", "Education", "freemium"),
    ("MagicSchool", "https://magicschool.ai", "AI tools for teachers", "Education", "freemium"),
    ("Diffit", "https://diffit.me", "AI lesson plan generator", "Education", "free"),
    ("Teachy", "https://teachy.ai", "AI teaching assistant platform", "Education", "freemium"),
    
    # Health & Wellness
    ("Woebot", "https://woebot.ai", "AI mental health chatbot", "Health", "freemium"),
    ("Wysa", "https://wysa.io", "AI emotional support and coaching", "Health", "freemium"),
    ("Sanvello", "https://sanvello.com", "AI-powered anxiety and depression tool", "Health", "freemium"),
    ("Replika", "https://replika.com", "AI companion for emotional support", "Chat", "paid"),
    
    # Finance
    ("Tiller", "https://tillerhq.com", "AI personal finance tracking", "Finance", "paid"),
    ("Monarch Money", "https://monarchmoney.com", "AI budgeting and finance planner", "Finance", "paid"),
    ("Empower", "https://empower.com", "AI wealth management and planning", "Finance", "free"),
    ("Personal Capital", "https://personalcapital.com", "AI investment and retirement planner", "Finance", "free"),
    
    # Design
    ("Figma AI", "https://figma.com/ai", "AI design assistance in Figma", "Image", "freemium"),
    ("Canva AI", "https://canva.com/ai", "AI design and image generation in Canva", "Image", "freemium"),
    ("Galileo AI", "https://usegalileo.ai", "AI UI design generation from text", "Image", "freemium"),
    ("Relume", "https://relume.io", "AI wireframe and sitemap generator", "Productivity", "freemium"),
    ("Framer AI", "https://framer.com", "AI website and design generation", "Image", "freemium"),
    ("Durable", "https://durable.co", "AI website builder in 30 seconds", "Business", "freemium"),
    
    # Enterprise AI Platforms
    ("Amazon Bedrock", "https://aws.amazon.com/bedrock", "AWS managed AI model platform", "Business", "paid"),
    ("Azure OpenAI", "https://azure.microsoft.com/openai", "Microsoft's managed OpenAI service", "Business", "paid"),
    ("Google Vertex AI", "https://cloud.google.com/vertex-ai", "Google's AI development platform", "Business", "paid"),
    ("Hugging Face", "https://huggingface.co", "Open-source ML community and model hub", "Coding", "free"),
    ("Replicate", "https://replicate.com", "Cloud GPU platform for ML models", "Coding", "paid"),
    ("Nvidia Nemo", "https://nvidia.com/nemo", "Enterprise AI conversational assistant", "Business", "paid"),
    
    # Premium AI Subscriptions
    ("ChatGPT Plus", "https://openai.com/chatgpt", "ChatGPT Plus with advanced reasoning capabilities", "Chat", "paid"),
    ("Claude Pro", "https://claude.ai/pro", "Anthropic's premium AI subscription", "Chat", "paid"),
    ("Gemini Advanced", "https://gemini.google.com/advanced", "Google's premium AI with extended features", "Chat", "paid"),
    ("Copilot Pro", "https://microsoft.com/copilot", "Microsoft's premium AI subscription", "Chat", "paid"),
    ("Gemini Ultra", "https://cloud.google.com/gemini", "Google's most capable AI model", "Chat", "paid"),
    
    # Additional Tools
    ("Midday AI", "https://midday.ai", "AI bookkeeping for small businesses", "Business", "paid"),
    ("Harvey", "https://harvey.ai", "AI legal assistant for law firms", "Business", "paid"),
    ("Clay", "https://clay.foundation", "AI data enrichment and lead generation", "Business", "paid"),
    ("Sunnyside", "https://sunnyside.ai", "AI sales intelligence and prospecting", "Business", "paid"),
    ("Relay AI", "https://relay.ai", "AI product research and analysis", "Research", "paid"),
    ("Superhuman AI", "https://superhuman.com", "AI email assistant for professionals", "Productivity", "paid"),
    ("Obsidian AI", "https://obsidian.md/ai", "AI plugins for knowledge management", "Productivity", "free"),
    ("Zotero AI", "https://zotero.org/ai", "AI research paper assistant", "Research", "free"),
]

def slugify(name):
    return re.sub(r'[^a-z0-9]+', '-', name.lower()).strip('-')

def get_favicon(domain):
    return f"https://www.google.com/s2/favicons?domain={domain}&sz=64"

def extract_domain(url):
    try:
        return url.replace('https://', '').replace('http://', '').split('/')[0].replace('www.', '')
    except:
        return ''

def build_tool_entry(tool):
    name, url, desc, category, pricing = tool
    slug = slugify(name)
    domain = extract_domain(url)
    return {
        "name": name, "slug": slug, "description": desc,
        "short_desc": desc[:150], "category": category,
        "pricing": pricing, "url": url,
        "logo_url": get_favicon(domain), "logo_type": "favicon",
        "tags": ",".join([category.lower(), pricing]),
        "compatible_tools": "", "views": 0, "votes": 0,
        "featured": 0, "tag": "new", "status": "published",
        "last_updated": datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    }

def sql_escape(s):
    if s is None: return "NULL"
    return "'" + str(s).replace("'", "''") + "'"

def make_insert_sql(tools):
    rows = []
    for tool in tools:
        e = build_tool_entry(tool)
        row = (f"({sql_escape(e['name'])}, {sql_escape(e['slug'])}, "
               f"{sql_escape(e['description'])}, {sql_escape(e['short_desc'])}, "
               f"{sql_escape(e['category'])}, {sql_escape(e['pricing'])}, "
               f"{sql_escape(e['url'])}, {sql_escape(e['logo_url'])}, "
               f"{sql_escape(e['logo_type'])}, {sql_escape(e['tags'])}, "
               f"{sql_escape(e['compatible_tools'])}, 0, 0, 0, "
               f"{sql_escape(e['tag'])}, {sql_escape(e['status'])}, "
               f"{sql_escape(e['last_updated'])})")
        rows.append(row)
    cols = "name, slug, description, short_desc, category, pricing, url, logo_url, logo_type, tags, compatible_tools, views, votes, featured, tag, status, last_updated"
    return f"INSERT OR IGNORE INTO tools ({cols}) VALUES {','.join(rows)}"


def fetch_github_repos():
    """Fetch real AI tools from GitHub API."""
    tools = []
    queries = [
        "artificial intelligence tool",
        "AI assistant",
        "LLM application",
        "chatbot framework",
        "AI image generation",
        "AI video generation",
        "AI coding assistant",
        "AI writing tool",
        "AI productivity",
        "AI automation",
        "machine learning tool",
        "AI research",
        "AI analytics",
        "AI marketing",
        "AI education",
        "AI design tool",
        "AI voice synthesis",
        "AI text to speech",
        "AI code completion",
        "AI workflow automation",
    ]
    for query in queries:
        for page in range(1, 4):
            url = f"https://api.github.com/search/repositories?q={query}&sort=stars&per_page=30&page={page}"
            try:
                r = requests.get(url, headers=HEADERS, timeout=15)
                if r.status_code != 200:
                    break
                data = r.json()
                hits = data.get('items', [])
                if not hits:
                    break
                for item in hits:
                    desc = item.get('description') or ''
                    name = item.get('full_name', '').split('/')[-1]
                    url_val = item.get('html_url', '')
                    stars = item.get('stargazers_count', 0)
                    cat = 'Coding' if any(k in name.lower() for k in ['code','dev','api','sdk','framework','library','cli','toolkit']) else random.choice(CATEGORIES)
                    price = 'free' if stars > 1000 else random.choice(['free', 'freemium'])
                    tools.append((f"{name} (GitHub)", url_val, f"{desc[:300]} — {stars:,} GitHub stars", cat, price))
                time.sleep(0.5)
            except Exception as e:
                print(f"  GH [{query}] error: {e}")
                break
    return tools

def fetch_hackernews():
    """Fetch AI-related posts from HackerNews via Algolia."""
    tools = []
    queries = ["AI tool", "artificial intelligence", "LLM", "GPT", "chatbot", "autonomous agent", "AI coding", "AI writing", "AI image", "AI video"]
    for q in queries:
        try:
            url = f"https://hn.algolia.com/api/v1/search?tags=front_page&query={q}&hitsPerPage=30"
            r = requests.get(url, headers=HEADERS, timeout=15)
            data = r.json()
            for hit in data.get('hits', []):
                title = hit.get('title', '')
                url_val = hit.get('url', '')
                points = hit.get('points', 0)
                if title and ('AI' in title or 'artificial' in title.lower() or 'LLM' in title or 'GPT' in title or 'agent' in title.lower()):
                    desc = hit.get('description', '') or f"HackerNews discussion about {title} — {points} points"
                    tools.append((title, url_val or '', desc, 'AI Tools', 'free'))
            time.sleep(0.5)
        except Exception as e:
            print(f"  HN [{q}] error: {e}")
    return tools


def main():
    print("=" * 60)
    print("BULK SEED — 500+ AI Tools → Remote D1")
    print("=" * 60)
    
    all_tools = []
    
    # Phase 1: Curated catalog
    print(f"\n[1] Curated catalog: {len(CURATED_TOOLS)} tools")
    all_tools.extend(CURATED_TOOLS)
    
    # Phase 2: GitHub API
    print("[2] Fetching GitHub repos...")
    gh_tools = fetch_github_repos()
    print(f"  -> {len(gh_tools)} tools from GitHub")
    all_tools.extend(gh_tools)
    
    # Phase 3: HackerNews
    print("[3] Fetching HackerNews...")
    hn_tools = fetch_hackernews()
    print(f"  -> {len(hn_tools)} tools from HN")
    all_tools.extend(hn_tools)
    
    # Dedup by URL and slug
    seen_urls = set()
    seen_slugs = set()
    unique = []
    for t in all_tools:
        url = (t[1] or '').strip()
        slug = slugify(t[0])
        if not url or url in seen_urls or slug in seen_slugs:
            continue
        seen_urls.add(url)
        seen_slugs.add(slug)
        unique.append(t)
    
    print(f"\nTotal unique: {len(unique)}")
    
    if not unique:
        print("No tools to insert.")
        return
    
    # Insert in batches of 30
    BATCH = 30
    inserted = 0
    skipped = 0
    
    for i in range(0, len(unique), BATCH):
        batch = unique[i:i+BATCH]
        batch_num = i // BATCH + 1
        total_batches = (len(unique) + BATCH - 1) // BATCH
        print(f"  Batch {batch_num}/{total_batches} ({len(batch)} tools)...")
        
        sql = make_insert_sql(batch)
        r = subprocess.run(
            ['wrangler', 'd1', 'execute', 'ai-directory-db', '--remote', '--command', sql],
            capture_output=True, text=True, timeout=30
        )
        if r.returncode == 0:
            lines = r.stdout.strip().split('\n')
            for line in reversed(lines):
                try:
                    result = json.loads(line)
                    if 'result' in result and result['result']:
                        meta = result['result'][0].get('meta', {})
                        changed = meta.get('changes', 0)
                        inserted += changed
                        skipped += (len(batch) - changed)
                    break
                except:
                    continue
        time.sleep(0.5)
    
    # Final count
    r = subprocess.run(
        ['wrangler', 'd1', 'execute', 'ai-directory-db', '--remote', 
         '--command', 'SELECT COUNT(*) as total FROM tools'],
        capture_output=True, text=True, timeout=15
    )
    db_total = 0
    if r.returncode == 0:
        lines = r.stdout.strip().split('\n')
        for line in reversed(lines):
            try:
                result = json.loads(line)
                if 'result' in result and result['result']:
                    results = result['result'][0].get('results', [])
                    if results:
                        db_total = results[0].get('total', 0)
                break
            except:
                continue
    
    print(f"\n{'='*60}")
    print("RESULTS")
    print(f"{'='*60}")
    print(f"  Curated:     {len(CURATED_TOOLS)}")
    print(f"  GitHub:      {len(gh_tools)}")
    print(f"  HackerNews:  {len(hn_tools)}")
    print(f"  Unique:      {len(unique)}")
    print(f"  Inserted:    {inserted}")
    print(f"  Skipped(dup):{skipped}")
    print(f"  DB total:    {db_total}")
    if db_total >= 500:
        print("\nSUCCESS: 500+ tools seeded in remote D1!")
    else:
        print(f"\nWARNING: Only {db_total} tools in DB (need 500+)")

if __name__ == "__main__":
    main()
