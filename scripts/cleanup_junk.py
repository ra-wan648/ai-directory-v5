#!/usr/bin/env python3
"""Hide published rows that should never have been published.

validate.py stops bad rows getting in from now on, but the table already holds
rows scraped before those rules existed - '";> API', 'cloudflare.com' and the
like - and they are visible on the live site right now.

Soft-hide rather than delete: setting status='rejected' drops a row out of every
query worker/worker.js makes (they all filter on status='published'), and it is
completely reversible. A DELETE is not, and these rows still carry the scraped
payload that a later, better rule might be able to salvage.

  python cleanup_junk.py --dry-run   # report only, writes nothing (default)
  python cleanup_junk.py --apply     # set status='rejected' on the failures

Every decision is logged with its reason and a few examples, so a run can be
audited after the fact. To undo a batch, flip those ids back to 'published'.
"""
import os
import shutil
import subprocess
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import validate  # noqa: E402

DB = "ai-directory-db"
BATCH = 200
APPLY = "--apply" in sys.argv


def d1_env():
    env = os.environ.copy()
    env["CLOUDFLARE_API_TOKEN"] = (
        os.environ.get("CF_API_TOKEN") or os.environ.get("CLOUDFLARE_API_TOKEN", "")
    )
    env["CLOUDFLARE_ACCOUNT_ID"] = os.environ.get("CLOUDFLARE_ACCOUNT_ID", "")
    return env


def _database_id():
    """Read database_id from wrangler.toml so the HTTP path needs no extra secret."""
    here = os.path.dirname(os.path.abspath(__file__))
    try:
        with open(os.path.join(here, "..", "wrangler.toml")) as fh:
            for line in fh:
                line = line.strip()
                if line.startswith("database_id"):
                    return line.split("=", 1)[1].strip().strip('"').strip("'")
    except Exception:
        pass
    return ""


def run_sql_http(sql, timeout=300):
    """Same job as run_sql, but over D1's HTTP API - no wrangler install needed.

    Used when the wrangler CLI is not on PATH, so the same script can be run
    from a laptop or an agent shell that only holds CF_API_TOKEN.
    """
    import json
    import urllib.request
    token = (os.environ.get("CF_API_TOKEN")
             or os.environ.get("CLOUDFLARE_API_TOKEN", ""))
    account = (os.environ.get("CF_ACCOUNT_ID")
               or os.environ.get("CLOUDFLARE_ACCOUNT_ID", ""))
    db_id = _database_id()
    if not (token and account and db_id):
        print("  ! wrangler is not installed, and CF_API_TOKEN / CF_ACCOUNT_ID / "
              "database_id are not all available - cannot run SQL.")
        return []
    req = urllib.request.Request(
        f"https://api.cloudflare.com/client/v4/accounts/{account}"
        f"/d1/database/{db_id}/query",
        data=json.dumps({"sql": sql}).encode(),
        headers={"Authorization": f"Bearer {token}",
                 "Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            data = json.loads(resp.read())
    except Exception as e:
        print(f"  ! D1 HTTP request failed: {str(e)[:200]}")
        return []
    if not data.get("success"):
        print(f"  ! D1 error: {str(data.get('errors'))[:200]}")
        return []
    return (data["result"][0].get("results") or [])


def run_sql(sql, timeout=300):
    if shutil.which("wrangler") is None:
        return run_sql_http(sql, timeout)
    r = subprocess.run(
        ["wrangler", "d1", "execute", DB, "--remote", "--json", "--command", sql],
        capture_output=True, text=True, timeout=timeout, env=d1_env(),
    )
    import json
    raw = (r.stdout or "").strip()
    if raw and raw[0] not in "[{":
        starts = [p for p in (raw.find("["), raw.find("{")) if p >= 0]
        if not starts:
            print("  ! no JSON from wrangler:", (raw or (r.stderr or ""))[:300])
            return []
        raw = raw[min(starts):]
    try:
        data = json.loads(raw)
    except Exception as e:
        print(f"  ! unparseable wrangler output ({e}): {(r.stderr or '')[:300]}")
        return []
    if isinstance(data, list) and data and isinstance(data[0], dict):
        return data[0].get("results") or []
    if isinstance(data, dict):
        return data.get("results") or []
    return []


def main():
    print(f"cleanup_junk: {'DRY RUN (nothing will be written)' if not APPLY else 'APPLYING'}")

    # url is selected too: a name-only check let news articles through, because a
    # headline can look like a plausible product name (see validate.is_valid_row).
    rows = run_sql("SELECT id,name,url FROM tools WHERE status='published'")
    if not rows:
        # A blocked read (D1's free tier resets at midnight UTC) reaches here.
        # Deliberately exit 0: nothing was changed, and failing the step would
        # take the description fill and the Telegram summary down with it. The
        # next run, on a fresh quota, will do the work.
        print("  no rows returned - D1 read blocked (or the table is empty). "
              "Nothing changed; this step is safe to re-run.")
        return 0

    bad, reasons, samples = [], {}, []
    for row in rows:
        name = validate.clean_name(row.get("name"))
        ok, why = validate.is_valid_row(name, row.get("url"))
        if ok:
            continue
        bad.append(row["id"])
        reasons[why] = reasons.get(why, 0) + 1
        if len(samples) < 15:
            host = validate.host_of(row.get("url")) or "-"
            samples.append(f"{name[:52]!r} [{host}] ({why})")

    print(f"  scanned {len(rows)} published row(s); {len(bad)} fail validation")
    for why, n in sorted(reasons.items(), key=lambda kv: -kv[1]):
        print(f"    {why}: {n}")
    if samples:
        print("  examples of what would be hidden:")
        for s in samples:
            print(f"    {s}")

    if not bad:
        print("  nothing to do.")
        return 0
    if not APPLY:
        print("\n  dry run only. Re-run with --apply to hide these rows.")
        return 0

    done = 0
    for i in range(0, len(bad), BATCH):
        chunk = bad[i:i + BATCH]
        ids = ",".join(str(x) for x in chunk)
        run_sql(f"UPDATE tools SET status='rejected' WHERE id IN ({ids});")
        done += len(chunk)
        print(f"  hidden {done}/{len(bad)}")
    print(f"  done - {done} row(s) set to status='rejected' (reversible).")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
