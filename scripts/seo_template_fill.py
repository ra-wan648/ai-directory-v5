"""Template-based SEO enrichment for all tools - no LLM needed.
Generates SEO title, meta description, full description, and FAQ from tool metadata."""
import os, re, json, subprocess, sys, html

DB = "ai-directory-db"

def d1_env():
    env = os.environ.copy()
    env["CLOUDFLARE_API_TOKEN"] = os.environ.get("CF_API_TOKEN") or os.environ.get("CLOUDFLARE_API_TOKEN", "")
    env["CLOUDFLARE_ACCOUNT_ID"] = os.environ.get("CLOUDFLARE_ACCOUNT_ID", "")
    return env

def run_sql(sql, timeout=120):
    r = subprocess.run(
        ["wrangler", "d1", "execute", DB, "--remote", "--json", "--command", sql],
        capture_output=True, text=True, timeout=timeout, env=d1_env(),
    )
    if r.returncode != 0:
        print("SQL ERR:", r.stderr[:300])
        return []
    try:
        data = json.loads(r.stdout)
        return data[0].get("results", []) if isinstance(data, list) else []
    except Exception as e:
        print("Parse err:", str(e)[:100])
        return []

def esc(s):
    return (s or "").replace("'", "''")

def clean_name(name):
    # Remove junk suffixes
    name = re.sub(r'\s*\|\s*.*$', '', name or '')
    name = re.sub(r'\s*[-–—]\s*.*$', '', name)
    return name.strip()[:60] or "AI Tool"

def make_seo(tool):
    raw_name = tool.get("name") or "AI Tool"
    name = clean_name(raw_name)
    cat = (tool.get("category") or "AI tool").strip()
    pricing = (tool.get("pricing") or "").strip().lower()
    
    # Pricing text
    if "free" in pricing:
        price_txt = "free"
    elif "paid" in pricing or "premium" in pricing:
        price_txt = "paid"
    elif "freemium" in pricing:
        price_txt = "freemium"
    else:
        price_txt = "AI-powered"
    
    # SEO title (under 60 chars)
    seo_title = f"{name} - {cat} AI Tool"
    if len(seo_title) > 60:
        seo_title = f"{name} | AI Tool"
    seo_title = seo_title[:60]
    
    # Meta description (150-155 chars)
    meta = f"Discover {name}, a {price_txt} {cat} tool. Explore features, pricing, alternatives & honest review on AI Directory."
    if len(meta) > 155:
        meta = f"Discover {name} - {price_txt} {cat} AI tool. Features, pricing & alternatives on AI Directory."
    meta = meta[:155]
    
    # Full description
    desc_full = (
        f"{name} is a {price_txt} AI tool in the {cat} category. "
        f"It helps users streamline their workflow with AI-powered capabilities. "
        f"Visit the official website to explore its features, pricing plans, and see if it fits your needs."
    )
    
    # FAQ (4 Q&A)
    faq = [
        {"q": f"What is {name}?", "a": f"{name} is a {price_txt} AI tool categorized under {cat}. It uses artificial intelligence to help users accomplish tasks more efficiently."},
        {"q": f"Is {name} free to use?", "a": f"{name} is listed as {price_txt} on AI Directory. Check the official website for the most current pricing details and any free trial options."},
        {"q": f"Who should use {name}?", "a": f"Anyone interested in {cat} tools powered by AI. {name} is suitable for both beginners and professionals looking to enhance their productivity."},
        {"q": f"Where can I learn more about {name}?", "a": f"Visit the official {name} website for detailed documentation, tutorials, and support. You can also find alternatives and comparisons on AI Directory."},
    ]
    
    return {
        "seo_title": seo_title,
        "meta_description": meta,
        "description_full": desc_full[:2000],
        "faq": json.dumps(faq)[:8000],
    }

def main():
    max_tools = int(os.environ.get("SEO_MAX", "0"))  # 0 = all
    limit_sql = "" if max_tools <= 0 else f" LIMIT {max_tools}"
    
    tools = run_sql(
        f"SELECT id, name, category, pricing FROM tools WHERE status='published' "
        f"AND ((faq IS NULL OR faq='') OR (seo_title IS NULL OR seo_title='')) "
        f"ORDER BY id{limit_sql}"
    )
    print(f"Found {len(tools)} tools needing enrichment")
    if not tools:
        print("Nothing to do")
        return
    
    done = 0
    batch = []
    for t in tools:
        seo = make_seo(t)
        batch.append(
            f"UPDATE tools SET seo_title='{esc(seo['seo_title'])}', "
            f"description='{esc(seo['meta_description'])}', "
            f"description_full='{esc(seo['description_full'])}', "
            f"faq='{esc(seo['faq'])}', llm_filled=1 WHERE id={t['id']};"
        )
        # Execute in batches of 50
        if len(batch) >= 50:
            run_sql(" ".join(batch))
            done += len(batch)
            batch = []
            print(f"  {done}/{len(tools)} done")
    
    if batch:
        run_sql(" ".join(batch))
        done += len(batch)
    
    print(f"COMPLETE: {done} tools enriched")

if __name__ == "__main__":
    main()

def enrich_blogs():
    blogs = run_sql(
        "SELECT id, title FROM blogs WHERE (meta_description IS NULL OR meta_description='') ORDER BY id"
    )
    print(f"Found {len(blogs)} blogs needing enrichment")
    done = 0
    batch = []
    for b in blogs:
        title = (b.get("title") or "Blog Post")[:60]
        meta = f"{title} - Read the full article on AI Directory. AI tools news, guides & insights."[:155]
        batch.append(
            f"UPDATE blogs SET meta_description='{esc(meta)}' WHERE id={b['id']};"
        )
        if len(batch) >= 50:
            run_sql(" ".join(batch))
            done += len(batch)
            batch = []
    if batch:
        run_sql(" ".join(batch))
        done += len(batch)
    print(f"Blogs: {done} enriched")
    return done

def enrich_prompts():
    prompts = run_sql(
        "SELECT id, title, description FROM prompts WHERE (description IS NULL OR description='') ORDER BY id"
    )
    print(f"Found {len(prompts)} prompts needing enrichment")
    done = 0
    batch = []
    for p in prompts:
        title = (p.get("title") or "AI Prompt")[:60]
        desc = f"{title} - Copy-paste AI prompt for ChatGPT & Claude. Free on AI Directory."[:500]
        batch.append(
            f"UPDATE prompts SET description='{esc(desc)}' WHERE id={p['id']};"
        )
        if len(batch) >= 50:
            run_sql(" ".join(batch))
            done += len(batch)
            batch = []
    if batch:
        run_sql(" ".join(batch))
        done += len(batch)
    print(f"Prompts: {done} enriched")
    return done

# Extend main to include blogs/prompts
import sys
_orig_main = main
def main():
    _orig_main()
    try:
        enrich_blogs()
    except Exception as e:
        print(f"Blog enrich failed: {e}")
    try:
        enrich_prompts()
    except Exception as e:
        print(f"Prompt enrich failed: {e}")

if __name__ == "__main__":
    # Re-run with blogs/prompts (tools already done, will skip)
    main()
