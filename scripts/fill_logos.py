"""Populate missing logo_url from Google favicon based on tool URL domain."""
import os, json, subprocess
from urllib.parse import urlparse

DB = "ai-directory-db"

def d1_env():
    env = os.environ.copy()
    env["CLOUDFLARE_API_TOKEN"] = os.environ.get("CF_API_TOKEN") or ""
    env["CLOUDFLARE_ACCOUNT_ID"] = os.environ.get("CLOUDFLARE_ACCOUNT_ID", "")
    return env

def run_sql(sql, timeout=120):
    r = subprocess.run(
        ["wrangler", "d1", "execute", DB, "--remote", "--json", "--command", sql],
        capture_output=True, text=True, timeout=timeout, env=d1_env(),
    )
    if r.returncode != 0:
        return []
    try:
        data = json.loads(r.stdout)
        return data[0].get("results", []) if isinstance(data, list) else []
    except:
        return []

def main():
    # Get tools without logo_url
    tools = run_sql(
        "SELECT id, url FROM tools WHERE status='published' "
        "AND (logo_url IS NULL OR logo_url='') AND url IS NOT NULL AND url != '' "
        "LIMIT 2000"
    )
    print(f"Found {len(tools)} tools without logos")
    
    done = 0
    batch = []
    for t in tools:
        try:
            domain = urlparse(t["url"]).netloc
            if not domain:
                continue
            logo = f"https://www.google.com/s2/favicons?domain={domain}&sz=64"
            batch.append(f"UPDATE tools SET logo_url='{logo}', logo_type='favicon' WHERE id={t['id']};")
        except:
            continue
        if len(batch) >= 100:
            run_sql(" ".join(batch))
            done += len(batch)
            batch = []
            print(f"  {done} done")
    
    if batch:
        run_sql(" ".join(batch))
        done += len(batch)
    
    print(f"COMPLETE: {done} logos filled")

if __name__ == "__main__":
    main()
