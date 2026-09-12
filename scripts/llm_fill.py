import os, requests, json, time, subprocess

# The API key must come from the environment. It was previously hardcoded here and
# therefore committed to a public repository — rotate it if that copy was ever live.
MANIFEST_URL = os.environ.get("MANIFEST_BASE_URL", "https://app.manifest.build/v1/responses")
MANIFEST_KEY = os.environ.get("MANIFEST_API_KEY", "")
DB = "ai-directory-db"

def d1_env():
    """wrangler authenticates with CLOUDFLARE_API_TOKEN, but the workflow only
    exports CF_API_TOKEN — without this the CLI is unauthenticated."""
    env = os.environ.copy()
    env["CLOUDFLARE_API_TOKEN"] = (
        os.environ.get("CF_API_TOKEN") or os.environ.get("CLOUDFLARE_API_TOKEN", "")
    )
    env["CLOUDFLARE_ACCOUNT_ID"] = os.environ.get("CLOUDFLARE_ACCOUNT_ID", "")
    return env


def run_sql(sql, timeout=180):
    """Run a D1 statement via wrangler and return the row list.

    wrangler's --json output has moved between a bare array and a wrapped
    object, and it can print stray non-JSON lines before the payload. Parse
    defensively instead of assuming ``[0]["results"]`` — that assumption used
    to raise KeyError: 0 and kill the whole pipeline job.
    """
    r = subprocess.run(
        ["wrangler", "d1", "execute", DB, "--remote", "--json", "--command", sql],
        capture_output=True, text=True, timeout=timeout, env=d1_env(),
    )
    raw = (r.stdout or "").strip()
    if raw and raw[0] not in "[{":
        starts = [p for p in (raw.find("["), raw.find("{")) if p >= 0]
        if not starts:
            print("  ! wrangler returned no JSON:",
                  (raw or (r.stderr or ""))[:300])
            return []
        raw = raw[min(starts):]
    try:
        data = json.loads(raw)
    except Exception as e:
        print(f"  ! unparseable wrangler output ({e}); stderr: {(r.stderr or '')[:300]}")
        return []
    if isinstance(data, dict):
        if "error" in data:
            print("  ! D1 error:", str(data["error"])[:300])
            return []
        for key in ("result", "results"):
            if isinstance(data.get(key), list):
                return data[key]
        return [data]
    if isinstance(data, list):
        if data and isinstance(data[0], dict) and "results" in data[0]:
            return data[0].get("results") or []
        return data
    return []


def get_unfilled():
    return run_sql("SELECT id,name,url,category,description FROM tools "
                   "WHERE llm_filled=0 AND status='published' LIMIT 100")

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
    # A single slow response used to raise straight through and fail the whole
    # step (TimeoutError after ~5 tools). Retry once with a longer timeout and
    # give up on just this tool instead of the batch.
    r = None
    for attempt, timeout in enumerate((60, 90), start=1):
        try:
            r = requests.post(
                MANIFEST_URL,
                headers={"Authorization": f"Bearer {MANIFEST_KEY}",
                         "Content-Type": "application/json"},
                json={"model": "auto", "input": prompt, "store": False},
                timeout=timeout,
            )
            break
        except Exception as e:
            print(f"    ! request failed ({type(e).__name__}), attempt {attempt}")
            r = None
            time.sleep(3)
    if r is None or r.status_code != 200:
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
    run_sql(f"UPDATE tools SET description_full='{d}',features='{f}',"
            f"pricing_detail='{p}',llm_filled=1 WHERE id={tid}")

if not MANIFEST_KEY:
    print("MANIFEST_API_KEY is not set - skipping LLM enrichment (this is optional).")
    raise SystemExit(0)

tools = get_unfilled()
print(f"Filling {len(tools)} tools...")
for i, t in enumerate(tools):
    print(f"[{i+1}/{len(tools)}] {t['name']}")
    try:
        data = fill(t)
        if data:
            update(t['id'], data)
            print("  \u2713")
    except Exception as e:
        # Never let one bad tool abort the batch — the step must still exit 0.
        print(f"  ! skipped ({type(e).__name__}: {e})")
    time.sleep(1)
print("Done.")
