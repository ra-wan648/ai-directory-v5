import os, requests, json, time, subprocess
from concurrent.futures import ThreadPoolExecutor

# The API key must come from the environment. It was previously hardcoded here and
# therefore committed to a public repository — rotate it if that copy was ever live.
MANIFEST_URL = os.environ.get("MANIFEST_BASE_URL", "https://app.manifest.build/v1/responses")
MANIFEST_KEY = os.environ.get("MANIFEST_API_KEY", "")
DB = "ai-directory-db"

# Retry policy. Each entry is the socket timeout for one attempt, and the length
# of the list is the default attempt budget. The router sometimes answers "no
# provider available" while it hunts for a model, so a few more asks turn a
# failure into a result instead of a hole in the directory.
ATTEMPT_TIMEOUTS = (60, 120, 240, 240, 300)    # seconds, one attempt each
MAX_ATTEMPTS = int(os.environ.get("LLM_MAX_ATTEMPTS", str(len(ATTEMPT_TIMEOUTS))))
# Wall-clock ceiling for a single tool, so a dead router cannot run the job out
# to its 350-minute limit while every worker sits in a timeout.
TOOL_BUDGET = int(os.environ.get("LLM_TOOL_BUDGET", "480"))
# 401/403 mean the key is wrong or revoked and 4xx means the request itself is
# malformed - neither will succeed on a retry, and each one costs a request.
FATAL_STATUS = {400, 401, 403, 404, 422}

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


def retry_after(resp):
    """Seconds the router asked us to wait, capped at a minute. 0 if it did not say."""
    try:
        v = resp.headers.get("Retry-After")
        return min(60, int(float(v))) if v else 0
    except Exception:
        return 0


def fill(tool):
    prompt = f"""Fill AI tools directory data. Return ONLY valid JSON, no markdown.
Tool: {tool['name']}, URL: {tool['url']}, Category: {tool['category']}
{{
  "description_full": "2-3 sentence description",
  "features": ["feature1","feature2","feature3","feature4"],
  "pricing_detail": "Free / Freemium from $X/mo / Paid from $X/mo"
}}"""
    # The router is slow: it may sit on a request while it tries several
    # providers, so a short socket timeout is the wrong tool here.
    #
    # The retry used to fire only on a socket exception. Any HTTP error status
    # broke out of the loop and returned None, which is why the dashboard showed
    # failed requests with attempts=1: the router answered "no provider yet" with
    # a 5xx and we gave up instead of asking again.
    started = time.time()
    last = "no attempt made"
    for attempt, timeout in enumerate(ATTEMPT_TIMEOUTS[:MAX_ATTEMPTS], start=1):
        wait = 0
        try:
            r = requests.post(
                MANIFEST_URL,
                headers={"Authorization": f"Bearer {MANIFEST_KEY}",
                         "Content-Type": "application/json"},
                json={"model": "auto", "input": prompt, "store": False},
                timeout=timeout,
            )
        except Exception as e:
            last = f"{type(e).__name__}: {e}"
            print(f"    ! attempt {attempt}/{MAX_ATTEMPTS} raised "
                  f"{type(e).__name__} after {timeout}s; retrying")
        else:
            if r.status_code in FATAL_STATUS:
                # A rejected or revoked key will never succeed here, and every
                # retry costs a request against the monthly allowance.
                print(f"    ! attempt {attempt}/{MAX_ATTEMPTS} -> HTTP "
                      f"{r.status_code} (not retryable): {r.text[:160]}")
                return None

            if r.status_code == 200:
                # The router sometimes answers 200 with a JSON array, or with a
                # body that is not JSON at all. Calling .get() on a list raised
                # AttributeError straight out of the loop and killed the whole
                # step with exit code 1, so check the shape first and treat
                # anything unexpected as a retryable bad response.
                body = None
                try:
                    body = r.json()
                except Exception as e:
                    last = f"HTTP 200 with unreadable body ({type(e).__name__})"
                    print(f"    ! attempt {attempt}/{MAX_ATTEMPTS} -> HTTP 200 "
                          f"but the body is not JSON; retrying")
                if body is not None:
                    if not isinstance(body, dict):
                        last = f"HTTP 200 body is {type(body).__name__}, not an object"
                        print(f"    ! attempt {attempt}/{MAX_ATTEMPTS} -> HTTP 200 "
                              f"body is {type(body).__name__}; retrying")
                    else:
                        out = extract_text(body.get("output", "")).strip()
                        if "```" in out:
                            out = out.split("```")[1].lstrip("json").strip()
                        try:
                            return json.loads(out)
                        except Exception:
                            last = f"HTTP 200 but unusable body: {out[:120]!r}"
                            print(f"    ! attempt {attempt}/{MAX_ATTEMPTS} -> HTTP 200 "
                                  f"with no usable JSON; retrying")
            elif r.status_code == 429:
                # Manifest M203 - too many concurrent requests. Retrying at once
                # at the same concurrency just trips the limit again, so back off
                # harder and honour Retry-After when the router sends one.
                last = f"HTTP 429: {r.text[:120]}"
                wait = retry_after(r) or min(45, 3 * (2 ** attempt))
                print(f"    ! attempt {attempt}/{MAX_ATTEMPTS} -> HTTP 429 "
                      f"(too many concurrent); waiting {wait}s")
            else:
                last = f"HTTP {r.status_code}: {r.text[:160]}"
                wait = min(20, 2 ** attempt)
                print(f"    ! attempt {attempt}/{MAX_ATTEMPTS} -> HTTP "
                      f"{r.status_code}; retrying")

        if time.time() - started > TOOL_BUDGET:
            break
        if attempt < MAX_ATTEMPTS:
            time.sleep(wait or min(20, 2 ** attempt))

    print(f"    ! gave up on {tool['name'][:40]} after "
          f"{int(time.time() - started)}s: {last[:140]}")
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
# Manifest answers 429 "too many concurrent requests" (M203) well below ten
# workers, and a 429 storm wastes the monthly allowance, so stay low.
WORKERS = int(os.environ.get("LLM_FILL_WORKERS", "4"))
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
        # Nothing written after this many failures means the router is down.
        # Stop rather than grind through the whole backlog for hours.
        if written == 0 and failed >= 60:
            print(f"  ! {failed} failures and nothing written - the router looks "
                  f"down. Stopping early; re-run this workflow later.")
            break
if buf:
    write_batch(buf)
    written += len(buf)

print(f"Done. processed={processed} written={written} failed={failed}")
