import requests, json, time, subprocess

MANIFEST_URL = "https://app.manifest.build/v1/responses"
MANIFEST_KEY = "mnfst_dCs24ciL5gMHegg7b1qr-Mn5TgBspc7O-h3KhAwFDcU"
DB = "ai-directory-db"

def get_unfilled():
    r = subprocess.run(["wrangler", "d1", "execute", DB, "--remote", "--command",
        "SELECT id,name,url,category,description FROM tools WHERE llm_filled=0 AND status='published' LIMIT 100",
        "--json"], capture_output=True, text=True)
    return json.loads(r.stdout)[0]["results"]

def extract_text(node):
    """Recursively extract readable text from the OpenAI/Manifest response output."""
    if node is None:
        return ""
    if isinstance(node, str):
        return node
    if isinstance(node, dict):
        # output_text / text block, or a nested structure
        if "text" in node and isinstance(node["text"], str):
            return node["text"]
        parts = []
        for key in ("content", "parts", "output"):
            if key in node:
                parts.append(extract_text(node[key]))
        if parts:
            return " ".join(parts)
        return ""
    if isinstance(node, list):
        return " ".join(extract_text(x) for x in node if extract_text(x))
    return str(node)


def fill(tool):
    prompt = f"""Fill AI tools directory data. Return ONLY valid JSON, no markdown.
Tool: {tool['name']}, URL: {tool['url']}, Category: {tool['category']}
{{
  "description_full": "2-3 sentence description",
  "features": ["feature1","feature2","feature3","feature4"],
  "pricing_detail": "Free / Freemium from $X/mo / Paid from $X/mo"
}}"""
    r = requests.post(MANIFEST_URL,
        headers={"Authorization": f"Bearer {MANIFEST_KEY}", "Content-Type": "application/json"},
        json={"model": "auto", "input": prompt, "store": False}, timeout=30)
    if r.status_code != 200:
        return None
    out = r.json().get("output", "")
    out = extract_text(out)
    out = out.strip()
    if "```" in out:
        out = out.split("```")[1].lstrip("json").strip()
    try:
        return json.loads(out)
    except Exception:
        return None

def update(tid, data):
    d = data.get("description_full", "").replace("'", "''")
    f = json.dumps(data.get("features", [])).replace("'", "''")
    p = data.get("pricing_detail", "").replace("'", "''")
    subprocess.run(["wrangler", "d1", "execute", DB, "--remote", "--command",
        f"UPDATE tools SET description_full='{d}',features='{f}',pricing_detail='{p}',llm_filled=1 WHERE id={tid}"],
        capture_output=True)

tools = get_unfilled()
print(f"Filling {len(tools)} tools...")
for i, t in enumerate(tools):
    print(f"[{i+1}/{len(tools)}] {t['name']}")
    data = fill(t)
    if data:
        update(t['id'], data)
        print("  \u2713")
    time.sleep(1)
print("Done.")
