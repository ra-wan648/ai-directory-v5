"""
SEO enrichment for AI Directory tools.
Generates for each tool:
  - seo_title: SEO-optimized title (~60 chars)
  - description: SEO meta description (~155 chars, keyword-rich)
  - description_full: 2-3 sentence SEO-friendly description
  - faq: JSON array of 4-5 Q&A pairs

One Manifest LLM call per tool. Run via GitHub Actions.
"""
import os, requests, json, time, subprocess, sys

MANIFEST_URL = os.environ.get("MANIFEST_BASE_URL", "https://app.manifest.build/v1/responses")
MANIFEST_KEY = os.environ.get("MANIFEST_API_KEY", "")
DB = "ai-directory-db"
BATCH_SIZE = int(os.environ.get("SEO_BATCH", "50"))
MAX_TOOLS = int(os.environ.get("SEO_MAX", "0"))  # 0 = all

ATTEMPT_TIMEOUTS = (60, 120, 180)
FATAL_STATUS = {400, 401, 403, 404, 422}

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
    raw = (r.stdout or "").strip()
    if raw and raw[0] not in "[{":
        starts = [p for p in (raw.find("["), raw.find("{")) if p >= 0]
        if not starts:
            return []
        raw = raw[min(starts):]
    try:
        data = json.loads(raw)
    except:
        return []
    if isinstance(data, list) and data and "results" in data[0]:
        return data[0]["results"]
    if isinstance(data, dict) and "results" in data:
        return data["results"]
    return []

def ensure_columns():
    """Add faq and seo_title columns if missing (idempotent)."""
    cols = run_sql("PRAGMA table_info(tools)")
    names = {c.get("name") for c in cols}
    if "faq" not in names:
        print("Adding faq column...")
        run_sql("ALTER TABLE tools ADD COLUMN faq TEXT DEFAULT NULL")
    if "seo_title" not in names:
        print("Adding seo_title column...")
        run_sql("ALTER TABLE tools ADD COLUMN seo_title TEXT DEFAULT NULL")
    print("Columns OK")

def seo_prompt(tool):
    name = tool.get("name", "")
    url = tool.get("url", "")
    cat = tool.get("category", "AI tool")
    pricing = tool.get("pricing", "")
    return f"""You are an SEO copywriter for an AI tools directory. Write SEO-friendly content for this AI tool.

Tool: {name}
URL: {url}
Category: {cat}
Pricing: {pricing or "unknown"}

Return ONLY valid JSON, no markdown, no explanation:
{{
  "seo_title": "SEO title under 60 chars, format: '[Tool Name] - [What it does] | AI Directory'",
  "meta_description": "Compelling meta description, 150-155 chars, includes tool name + main benefit + 'AI Directory'",
  "description_full": "2-3 sentences describing what the tool does, who it's for, and key benefit. Natural, not salesy.",
  "faq": [
    {{"q": "What is {name}?", "a": "1-2 sentence answer"}},
    {{"q": "Is {name} free?", "a": "1-2 sentence answer about pricing"}},
    {{"q": "Who should use {name}?", "a": "1-2 sentence answer about target user"}},
    {{"q": "How does {name} compare to alternatives?", "a": "1-2 sentence neutral answer"}},
    {{"q": "Where can I try {name}?", "a": "1 sentence with call to action"}}
  ]
}}"""

def call_llm(prompt):
    for attempt, timeout in enumerate(ATTEMPT_TIMEOUTS, start=1):
        try:
            r = requests.post(
                MANIFEST_URL,
                headers={"Authorization": f"Bearer {MANIFEST_KEY}", "Content-Type": "application/json"},
                json={"model": "auto", "input": prompt, "store": False},
                timeout=timeout,
            )
            if r.status_code in FATAL_STATUS:
                print(f"  ! Fatal {r.status_code}, skipping")
                return None
            if r.status_code != 200:
                print(f"  ! HTTP {r.status_code}, retry {attempt}")
                time.sleep(5)
                continue
            data = r.json()
            # Extract text from response
            text = ""
            if "output" in data:
                out = data["output"]
                if isinstance(out, list):
                    for item in out:
                        if isinstance(item, dict) and item.get("type") == "message":
                            for c in item.get("content", []):
                                if isinstance(c, dict) and c.get("type") == "output_text":
                                    text += c.get("text", "")
                elif isinstance(out, str):
                    text = out
            elif "choices" in data:
                text = data["choices"][0].get("message", {}).get("content", "")
            # Clean and parse JSON
            text = text.strip()
            if text.startswith("```"):
                text = re.sub(r'^```\w*\n?', '', text)
                text = re.sub(r'\n?```$', '', text)
            return json.loads(text)
        except json.JSONDecodeError as e:
            print(f"  ! JSON parse fail (attempt {attempt}): {e}")
            time.sleep(3)
        except Exception as e:
            print(f"  ! Error (attempt {attempt}): {e}")
            time.sleep(5)
    return None

import re

def main():
    if not MANIFEST_KEY:
        print("MANIFEST_API_KEY not set, skipping")
        sys.exit(0)
    ensure_columns()
    # Get tools missing SEO content
    where = "(faq IS NULL OR faq = '') OR (seo_title IS NULL OR seo_title = '') OR (description_full IS NULL OR description_full = '')"
    tools = run_sql(f"SELECT id, name, slug, url, category, pricing FROM tools WHERE status='published' AND ({where}) ORDER BY id LIMIT {MAX_TOOLS or 100000}")
    print(f"Found {len(tools)} tools needing SEO enrichment")
    done = 0
    for i, tool in enumerate(tools):
        if MAX_TOOLS and done >= MAX_TOOLS:
            break
        print(f"[{i+1}/{len(tools)}] {tool.get('name')}...")
        result = call_llm(seo_prompt(tool))
        if not result:
            print(f"  ! LLM failed for {tool.get('name')}")
            continue
        # Sanitize
        seo_title = str(result.get("seo_title", ""))[:70].replace("'", "''")
        meta_desc = str(result.get("meta_description", ""))[:160].replace("'", "''")
        desc_full = str(result.get("description_full", ""))[:2000].replace("'", "''")
        faq_json = json.dumps(result.get("faq", []))[:8000].replace("'", "''")
        # Update D1
        sql = f"UPDATE tools SET seo_title='{seo_title}', description='{meta_desc}', description_full='{desc_full}', faq='{faq_json}', llm_filled=1 WHERE id={tool['id']}"
        run_sql(sql)
        done += 1
        if done % 10 == 0:
            print(f"  ... {done} done")
        time.sleep(1)  # Rate limit kindness
    print(f"Done: {done} tools enriched")

if __name__ == "__main__":
    main()
