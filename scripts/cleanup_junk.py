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

# How many held rows to print for review. They go to stdout, which lands in
# the workflow log, so the review can be done without another D1 read.
REPORT_HELD = int(os.environ.get("CLEANUP_REPORT_HELD", "150"))

# Reasons held back for a manual look, as a comma-separated list. This lets a
# first pass hide only the unambiguous junk and leaves the judgement calls
# published until someone has read them. Clear the variable to apply everything.
SKIP_REASONS = {
    r.strip().lower()
    for r in os.environ.get("CLEANUP_SKIP_REASONS", "").split(",")
    if r.strip()
}


def d1_env():
    env = os.environ.copy()
    env["CLOUDFLARE_API_TOKEN"] = (
        os.environ.get("CF_API_TOKEN") or os.environ.get("CLOUDFLARE_API_TOKEN", "")
    )
    env["CLOUDFLARE_ACCOUNT_ID"] = os.environ.get("CLOUDFLARE_ACCOUNT_ID", "")
    return env


class D1Error(RuntimeError):
    """A D1 call that did not return success. Never swallowed: a write that did
    not happen must not be reported as one that did."""


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
        raise D1Error(f"D1 HTTP request failed: {str(e)[:200]}")
    if not data.get("success"):
        raise D1Error(f"D1 error: {str(data.get('errors'))[:200]}")
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
            raise D1Error(f"no JSON from wrangler: {(raw or (r.stderr or ''))[:300]}")
        raw = raw[min(starts):]
    try:
        data = json.loads(raw)
    except Exception as e:
        raise D1Error(f"unparseable wrangler output ({e}): {(r.stderr or '')[:300]}")
    if isinstance(data, list) and data and isinstance(data[0], dict):
        return data[0].get("results") or []
    if isinstance(data, dict):
        return data.get("results") or []
    return []


def main():
    print(f"cleanup_junk: {'DRY RUN (nothing will be written)' if not APPLY else 'APPLYING'}")

    # url is selected too: a name-only check let news articles through, because a
    # headline can look like a plausible product name (see validate.is_valid_row).
    try:
        rows = run_sql("SELECT id,name,url FROM tools WHERE status='published'")
    except D1Error as e:
        print(f"  ! {e}")
        rows = []
    if not rows:
        # A blocked read (D1's free tier resets at midnight UTC) reaches here.
        # Deliberately exit 0: nothing was changed, and failing the step would
        # take the description fill and the Telegram summary down with it. The
        # next run, on a fresh quota, will do the work.
        print("  no rows returned - D1 read blocked (or the table is empty). "
              "Nothing changed; this step is safe to re-run.")
        return 0

    bad, reasons, samples, held = [], {}, [], {}
    held_rows = []
    for row in rows:
        name = validate.clean_name(row.get("name"))
        ok, why = validate.is_valid_row(name, row.get("url"))
        if ok:
            continue
        if why.lower() in SKIP_REASONS:
            held[why] = held.get(why, 0) + 1
            if len(held_rows) < REPORT_HELD:
                host = validate.host_of(row.get("url")) or "-"
                held_rows.append(f"{row['id']} [{why}] {name[:60]!r} <{host}>")
            continue
        bad.append(row["id"])
        reasons[why] = reasons.get(why, 0) + 1
        if len(samples) < 15:
            host = validate.host_of(row.get("url")) or "-"
            samples.append(f"{name[:52]!r} [{host}] ({why})")

    print(f"  scanned {len(rows)} published row(s); {len(bad)} fail validation")
    for why, n in sorted(reasons.items(), key=lambda kv: -kv[1]):
        print(f"    {why}: {n}")
    if held:
        print(f"  held back for review ({sum(held.values())} row(s), still published):")
        for why, n in sorted(held.items(), key=lambda kv: -kv[1]):
            print(f"    {why}: {n}")
        # Printed so the held rows can be reviewed from the run log, without
        # needing a D1 read of the whole table on a machine that has a quota.
        if held_rows:
            print(f"  held rows (first {len(held_rows)} of {sum(held.values())}):")
            for s in held_rows:
                print(f"    {s}")
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
    failed = 0
    for i in range(0, len(bad), BATCH):
        chunk = bad[i:i + BATCH]
        ids = ",".join(str(x) for x in chunk)
        try:
            run_sql(f"UPDATE tools SET status='rejected' WHERE id IN ({ids});")
        except D1Error as e:
            # Do not count it. The previous version added len(chunk) here no
            # matter what, so a fully blocked run still printed
            # "done - 1214 row(s) set to status='rejected'" and looked like it
            # had cleaned the table.
            failed += len(chunk)
            print(f"  ! batch failed, {len(chunk)} row(s) NOT hidden: {e}")
            continue
        done += len(chunk)
        print(f"  hidden {done}/{len(bad)}")
    if failed:
        print(f"  {done} row(s) set to status='rejected'; {failed} row(s) were NOT "
              f"hidden because D1 refused the write. Re-run on a fresh quota.")
        return 1
    print(f"  done - {done} row(s) set to status='rejected' (reversible).")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
