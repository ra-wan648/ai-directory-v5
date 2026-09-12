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


def run_sql(sql, timeout=300):
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

    rows = run_sql("SELECT id,name FROM tools WHERE status='published'")
    if not rows:
        print("  no rows returned - D1 read blocked, or the table is empty. "
              "Nothing changed.")
        return 1

    bad, reasons, samples = [], {}, []
    for row in rows:
        name = validate.clean_name(row.get("name"))
        ok, why = validate.is_valid_name(name)
        if ok:
            continue
        bad.append(row["id"])
        reasons[why] = reasons.get(why, 0) + 1
        if len(samples) < 15:
            samples.append(f"{row.get('name')!r} ({why})")

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
