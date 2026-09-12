import os, requests, json, time, subprocess
from concurrent.futures import ThreadPoolExecutor

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


def get_unfilled(limit):
    return run_sql("SELECT id,name,url,category,description FROM tools "
                   f"WHERE llm_filled=0 AND status='published' LIMIT {int(limit)}")

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
    # The router is slow: it may sit on a request while it tries several
    # providers, so a short socket timeout is the wrong tool here. Wait long,
    # and keep retrying while it is still thinking. A single slow response used
    # to raise straight through and kill the whole step after ~5 tools.
    ATTEMPT_TIMEOUTS = (90, 180, 300)      # seconds, one attempt each
    r = None
    for attempt, timeout in enumerate(ATTEMPT_TIMEOUTS, start=1):
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
            print(f"    ! still waiting ({type(e).__name__}), attempt "
                  f"{attempt}/{len(ATTEMPT_TIMEOUTS)}, waited {timeout}s")
            r = None
            time.sleep(5)
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

def escape(text):
    return str(text or "").replace("'", "''")


def write_batch(pairs):
    """Write a batch of enriched rows in ONE wrangler call.

    This used to spawn a wrangler process per tool. wrangler is a Node CLI, so
    that is a few seconds of process start-up per row - on a 6,000-tool backlog
    it is hours of overhead before the database does any real work. The CLI
    accepts several statements in one --command, so a whole batch goes in one.
    """
    stmts = []
    for tid, data in pairs:
        d = escape(data.get("description_full", ""))[:2000]
        f = escape(json.dumps(data.get("features", [])))[:2000]
        p = escape(data.get("pricing_detail", ""))[:200]
        stmts.append(
            f"UPDATE tools SET description_full='{d}',features='{f}',"
            f"pricing_detail='{p}',llm_filled=1 WHERE id={tid};"
        )
    if stmts:
        run_sql(" ".join(stmts))


MAX_TOOLS = int(os.environ.get("LLM_FILL_MAX", "600"))
WORKERS = int(os.environ.get("LLM_FILL_WORKERS", "8"))
WRITE_BATCH = int(os.environ.get("LLM_FILL_WRITE_BATCH", "40"))

if not MANIFEST_KEY:
    print("MANIFEST_API_KEY is not set - skipping LLM enrichment (this is optional).")
    raise SystemExit(0)

tools = get_unfilled(MAX_TOOLS)
print(f"Filling up to {MAX_TOOLS} tool(s), {WORKERS} concurrent; "
      f"{len(tools)} outstanding.")


def job(tool):
    try:
        return tool, fill(tool)
    except Exception as e:
        # Never let one bad tool abort the batch — the step must still exit 0.
        print(f"  ! {tool['name'][:40]}: skipped ({type(e).__name__})")
        return tool, None


processed = written = failed = 0
buf = []
with ThreadPoolExecutor(max_workers=WORKERS) as pool:
    for tool, data in pool.map(job, tools):
        processed += 1
        if data:
            buf.append((tool["id"], data))
        else:
            failed += 1
        if len(buf) >= WRITE_BATCH:
            write_batch(buf)
            written += len(buf)
            buf = []
            print(f"  [{processed}/{len(tools)}] processed, {written} written")
if buf:
    write_batch(buf)
    written += len(buf)

print(f"Done. processed={processed} written={written} failed={failed}")
