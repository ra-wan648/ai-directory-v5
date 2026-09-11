import requests
import os
from config import load_env

load_env()

CF_ACCOUNT = os.environ['CF_ACCOUNT_ID']
CF_TOKEN = os.environ['CF_API_TOKEN']
CF_D1_ID = os.environ['CF_D1_ID']
WORKER_URL = os.environ['WORKER_URL'].rstrip('/')
INTERNAL_KEY = os.environ['INTERNAL_API_KEY']

D1_URL = f"https://api.cloudflare.com/client/v4/accounts/{CF_ACCOUNT}/d1/database/{CF_D1_ID}/query"
CF_HEADERS = {"Authorization": f"Bearer {CF_TOKEN}", "Content-Type": "application/json"}
WORKER_HEADERS = {"X-Internal-Key": INTERNAL_KEY, "Content-Type": "application/json"}


def d1_query(sql, params=None):
    try:
        r = requests.post(D1_URL, headers=CF_HEADERS,
                          json={"sql": sql, "params": params or []}, timeout=30)
        return r.json()
    except Exception as e:
        print(f"[ERROR] D1: {e}")
        return None


def tool_exists(slug, url):
    """Check if tool exists by slug OR url (deduplication)"""
    r = d1_query("SELECT id, description, pricing FROM tools WHERE slug=? OR url=?", [slug, url or ''])
    try:
        return bool(r['result'][0]['results'])
    except Exception:
        return False


def get_existing_tool(slug, url):
    """Get existing tool data for update comparison"""
    r = d1_query("SELECT description, pricing FROM tools WHERE slug=? OR url=?", [slug, url or ''])
    try:
        results = r['result'][0]['results']
        if results:
            return results[0]
    except Exception:
        pass
    return None


def save_tool(tool):
    """Save tool via Worker internal API. Worker handles insert/update logic."""
    try:
        r = requests.post(f"{WORKER_URL}/api/internal/add-tool",
                          headers=WORKER_HEADERS, json=tool, timeout=30)
        return r.json()
    except Exception as e:
        print(f"[ERROR] save_tool: {e}")
        return None


def save_blog(blog):
    try:
        r = requests.post(f"{WORKER_URL}/api/internal/add-blog",
                          headers=WORKER_HEADERS, json=blog, timeout=30)
        data = r.json()
        return data.get('id')
    except Exception as e:
        print(f"[ERROR] save_blog: {e}")
        return None


def save_prompt(prompt):
    try:
        r = requests.post(f"{WORKER_URL}/api/internal/add-prompt",
                          headers=WORKER_HEADERS, json=prompt, timeout=30)
        data = r.json()
        return data.get('id')
    except Exception as e:
        print(f"[ERROR] save_prompt: {e}")
        return None


def bulk_insert(tools):
    try:
        r = requests.post(f"{WORKER_URL}/api/internal/bulk-insert",
                          headers=WORKER_HEADERS,
                          json={"tools": tools}, timeout=60)
        return r.json()
    except Exception as e:
        print(f"[ERROR] bulk_insert: {e}")
        return None