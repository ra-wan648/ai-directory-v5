import sys
import time
from scrapers import scrape_all
from rss import fetch_all_feeds
from llm import parse_tool_from_raw, generate_blog_from_news, llm_find_new_tools, generate_prompt_ideas
from db import tool_exists, save_tool, save_blog, save_prompt, bulk_insert
from telegram import send_blog_notification, send_prompt_notification, send_error, send_summary

tools_added = 0
tools_updated = 0
blogs_generated = 0
prompts_generated = 0
errors = 0

def process_tools(max_pages=15):
    global tools_added, tools_updated, errors
    print(f"\n{'='*50}")
    print("STEP 1: Scraping tools from all sources")
    print(f"{'='*50}")
    
    raw_all = scrape_all(max_pages_normal=max_pages)
    
    # Also use LLM to find new tools
    try:
        print("\n🤖 LLM searching for new tools...")
        llm_tools = llm_find_new_tools()
        raw_all.extend([{
            "name": t.get("name", ""),
            "url": t.get("url", ""),
            "raw_desc": t.get("description", ""),
            "source": "llm_search",
            "_structured": t
        } for t in llm_tools])
        print(f"   → LLM found {len(llm_tools)} tools")
    except Exception as e:
        print(f"[WARN] LLM find tools failed: {e}")
    
    print(f"\n📦 Processing {len(raw_all)} raw tool entries...")
    
    # Deduplicate by URL before processing
    seen_urls = set()
    unique_raw = []
    for raw in raw_all:
        url = raw.get('url', '').strip()
        if url and url not in seen_urls:
            seen_urls.add(url)
            unique_raw.append(raw)
    print(f"🔍 After URL deduplication: {len(unique_raw)} unique tools")
    
    for i, raw in enumerate(unique_raw):
        try:
            if raw.get('_structured'):
                tool = raw['_structured']
            else:
                tool = parse_tool_from_raw(raw)
            if not tool:
                print(f"[{i+1}/{len(unique_raw)}] SKIP: {raw.get('name', 'unknown')} - LLM could not parse")
                continue
            
            slug = tool.get('slug', '')
            url = tool.get('url', '')
            
            # Check if exists in D1
            if tool_exists(slug, url):
                # Update if description or pricing changed
                existing = d1_query("SELECT description, pricing FROM tools WHERE slug=? OR url=?", [slug, url or ''])
                should_update = False
                if existing and existing.get('result') and existing['result'][0]['results']:
                    existing_tool = existing['result'][0]['results'][0]
                    if existing_tool['description'] != tool.get('description', '') or existing_tool['pricing'] != tool.get('pricing', ''):
                        should_update = True
                
                if should_update:
                    result = save_tool(tool)
                    if result and result.get('status') == 'updated':
                        tools_updated += 1
                        print(f"[{i+1}/{len(unique_raw)}] UPD: {tool.get('name')}")
                    else:
                        print(f"[{i+1}/{len(unique_raw)}] SKP: {tool.get('name')}")
                else:
                    print(f"[{i+1}/{len(unique_raw)}] SKP: {tool.get('name')} (exists)")
            else:
                result = save_tool(tool)
                if result and result.get('status') == 'inserted':
                    tools_added += 1
                    print(f"[{i+1}/{len(unique_raw)}] NEW: {tool.get('name')}")
                else:
                    print(f"[{i+1}/{len(unique_raw)}] SKP: {tool.get('name', 'unknown')}")
        except Exception as e:
            errors += 1
            print(f"[ERR] tool {raw.get('name', '?')}: {e}")
        time.sleep(0.5)
    
    print(f"\n✅ Tools done! Added: {tools_added}, Updated: {tools_updated}")

def process_blogs(max_blogs=5):
    global blogs_generated, errors
    print(f"\n{'='*50}")
    print("STEP 2: Fetching RSS feeds for blog posts")
    print(f"{'='*50}")
    
    rss_items = fetch_all_feeds()
    
    # Filter for AI-relevant items
    ai_items = [item for item in rss_items if item.get('type') in ('news', 'tools')]
    print(f"📰 {len(ai_items)} AI-relevant items from RSS")
    
    count = 0
    for item in ai_items:
        if count >= max_blogs:
            break
        try:
            print(f"📝 Generating blog: {item['title'][:60]}...")
            blog = generate_blog_from_news(item)
            if not blog:
                continue
            blog_id = save_blog(blog)
            if blog_id:
                send_blog_notification(blog, blog_id)
                blogs_generated += 1
                count += 1
                print(f"   ✅ Blog saved: {blog.get('title')}")
            else:
                print(f"   ❌ Blog save failed")
        except Exception as e:
            errors += 1
            print(f"[ERR] blog: {e}")
    
    print(f"\n✅ Blogs done! Generated: {blogs_generated}")

def process_prompts(max_prompts=3):
    global prompts_generated, errors
    print(f"\n{'='*50}")
    print("STEP 3: Generating AI prompts")
    print(f"{'='*50}")
    
    try:
        prompts = generate_prompt_ideas()
        count = 0
        for p in prompts:
            if count >= max_prompts:
                break
            try:
                pid = save_prompt(p)
                if pid:
                    send_prompt_notification(p, pid)
                    prompts_generated += 1
                    count += 1
                    print(f"   ✅ Prompt saved: {p.get('title')}")
                else:
                    print(f"   ❌ Prompt save failed")
            except Exception as e:
                errors += 1
                print(f"[ERR] prompt save: {e}")
    except Exception as e:
        errors += 1
        print(f"[ERR] prompts generation: {e}")
    
    print(f"\n✅ Prompts done! Generated: {prompts_generated}")

def d1_query(sql, params=None):
    import requests, os
    from config import load_env
    load_env()
    CF_ACCOUNT = os.environ['CF_ACCOUNT_ID']
    CF_TOKEN = os.environ['CF_API_TOKEN']
    CF_D1_ID = os.environ['CF_D1_ID']
    D1_URL = f"https://api.cloudflare.com/client/v4/accounts/{CF_ACCOUNT}/d1/database/{CF_D1_ID}/query"
    CF_HEADERS = {"Authorization": f"Bearer {CF_TOKEN}", "Content-Type": "application/json"}
    try:
        r = requests.post(D1_URL, headers=CF_HEADERS, json={"sql": sql, "params": params or []}, timeout=30)
        return r.json()
    except Exception as e:
        print(f"[ERROR] D1 query: {e}")
        return None

def run_pipeline(max_pages=15, max_blogs=5, max_prompts=3):
    global tools_added, tools_updated, blogs_generated, prompts_generated, errors
    
    print(f"\n{'🚀'*20}")
    print(f"🚀 AI Directory Pipeline Starting")
    print(f"{'🚀'*20}\n")
    start_time = time.time()
    
    try:
        process_tools(max_pages)
    except Exception as e:
        send_error(f"Tools phase crashed: {e}")
        errors += 1
    
    try:
        process_blogs(max_blogs)
    except Exception as e:
        send_error(f"Blogs phase crashed: {e}")
        errors += 1
    
    try:
        process_prompts(max_prompts)
    except Exception as e:
        send_error(f"Prompts phase crashed: {e}")
        errors += 1
    
    elapsed = int(time.time() - start_time)
    print(f"\n{'='*50}")
    print(f"🎉 PIPELINE COMPLETE in {elapsed}s")
    print(f"{'='*50}")
    print(f"🔧 Tools added:    {tools_added}")
    print(f"🔄 Tools updated:  {tools_updated}")
    print(f"📝 Blogs generated: {blogs_generated}")
    print(f"🎨 Prompts generated: {prompts_generated}")
    print(f"⚠️ Errors:         {errors}")
    
    send_summary(tools_added + tools_updated, blogs_generated, prompts_generated, errors)
    return {
        "tools_added": tools_added,
        "tools_updated": tools_updated,
        "blogs": blogs_generated,
        "prompts": prompts_generated,
        "errors": errors,
        "elapsed": elapsed
    }

if __name__ == "__main__":
    import argparse
    parser = argparse.ArgumentParser()
    parser.add_argument("--max-pages", type=int, default=15)
    parser.add_argument("--max-blogs", type=int, default=5)
    parser.add_argument("--max-prompts", type=int, default=3)
    parser.add_argument("--bulk", action="store_true", help="Run with bulk limits")
    args = parser.parse_args()
    
    if args.bulk:
        run_pipeline(max_pages=50, max_blogs=10, max_prompts=5)
    else:
        run_pipeline(max_pages=args.max_pages, max_blogs=args.max_blogs, max_prompts=args.max_prompts)