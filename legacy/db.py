import sqlite3
import os
import json
import requests
from datetime import datetime

# ─── Remote D1 support ──────────────────────────────────────────────
CF_API_TOKEN = os.environ.get('CF_API_TOKEN', '') or os.environ.get('CLOUDFLARE_API_TOKEN', '')
CF_ACCOUNT_ID = os.environ.get('CLOUDFLARE_ACCOUNT_ID', '') or os.environ.get('CF_ACCOUNT_ID', '')
CF_D1_ID = os.environ.get('CF_D1_ID', '')

def use_remote():
    return bool(CF_API_TOKEN and CF_ACCOUNT_ID and CF_D1_ID)

def d1_query(sql, params=None):
    if not use_remote():
        return None
    try:
        url = f"https://api.cloudflare.com/client/v4/accounts/{CF_ACCOUNT_ID}/d1/database/{CF_D1_ID}/query"
        r = requests.post(url, headers={
            "Authorization": f"Bearer {CF_API_TOKEN}",
            "Content-Type": "application/json"
        }, json={"sql": sql, "params": params or []}, timeout=15)
        data = r.json()
        if data.get('success') and data.get('result'):
            return data['result'][0].get('results', [])
        return None
    except Exception as e:
        print(f"[D1 ERROR] {e}")
        return None

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
DB_PATH = os.path.join(BASE_DIR, 'directory.db')
SCHEMA_PATH = os.path.join(BASE_DIR, 'schema.sql')


def get_conn():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.execute('PRAGMA journal_mode=WAL')
    conn.execute('PRAGMA foreign_keys=ON')
    return conn


def init_db():
    if os.path.exists(DB_PATH):
        return
    conn = get_conn()
    try:
        with open(SCHEMA_PATH, 'r') as f:
            conn.executescript(f.read())
        conn.commit()
    finally:
        conn.close()


def query(sql, params=(), one=False):
    if use_remote():
        rows = d1_query(sql, list(params) if params else None)
        if rows is not None:
            return rows[0] if (one and rows) else rows
    conn = get_conn()
    try:
        cur = conn.execute(sql, params)
        if one:
            row = cur.fetchone()
            return dict(row) if row else None
        return [dict(r) for r in cur.fetchall()]
    finally:
        conn.close()


def execute(sql, params=()):
    if use_remote():
        result = d1_query(sql, list(params) if params else None)
        return 1 if result is not None else 0
    conn = get_conn()
    try:
        conn.execute(sql, params)
        conn.commit()
        return conn.execute('SELECT last_insert_rowid()').fetchone()[0]
    finally:
        conn.close()


# ─────────────────────────────
# TOOLS
# ─────────────────────────────

def get_tools(filters=None, page=1, limit=40):
    where = ["status = 'published'"]
    args = []
    if filters:
        cat = filters.get('category')
        if cat and cat != 'all':
            where.append('LOWER(category) = ?')
            args.append(cat.lower())
        pricing = filters.get('pricing')
        if pricing:
            where.append('pricing = ?')
            args.append(pricing)
        q = (filters.get('q') or '').strip()
        if q:
            where.append('(LOWER(name) LIKE ? OR LOWER(description) LIKE ?)')
            args.extend([f'%{q.lower()}%', f'%{q.lower()}%'])
        tag = filters.get('tag')
        if tag:
            where.append('tag = ?')
            args.append(tag)
    order = 'created_at DESC'
    sort = (filters or {}).get('sort')
    if sort == 'views':
        order = 'views DESC'
    elif sort == 'alphabetical':
        order = 'name ASC'
    total = query(f'SELECT COUNT(*) as c FROM tools WHERE {" AND ".join(where)}', args, one=True)
    offset = max(0, (page - 1) * limit)
    tools = query(f'SELECT * FROM tools WHERE {" AND ".join(where)} ORDER BY {order} LIMIT ? OFFSET ?', args + [limit, offset])
    return tools, total['c'] if total else 0


def get_tool(slug):
    tool = query('SELECT * FROM tools WHERE slug = ? AND status = \'published\'', [slug], one=True)
    if not tool:
        return None
    execute('UPDATE tools SET views = views + 1 WHERE slug = ?', [slug])
    related = query('SELECT * FROM tools WHERE category = ? AND slug != ? AND status = \'published\' ORDER BY views DESC LIMIT 6', [tool['category'], slug])
    reviews = query('SELECT id, title, slug, category, meta_description, published_at FROM blogs WHERE tool_slug = ? AND status = \'published\' ORDER BY published_at DESC', [slug])
    return {'tool': tool, 'related': related, 'reviews': reviews}


def get_new_tools(limit=6):
    return query('SELECT * FROM tools WHERE tag = \'new\' OR created_at > datetime(\'now\', \'-48 hours\') ORDER BY created_at DESC LIMIT ?', [limit])


def get_trending_tools(limit=6):
    return query('SELECT * FROM tools WHERE status = \'published\' ORDER BY views DESC, votes DESC LIMIT ?', [limit])


def get_featured_tools(limit=3):
    return query('SELECT * FROM tools WHERE featured = 1 AND status = \'published\' LIMIT ?', [limit])


def get_tools_by_tag(tag, page=1, limit=40):
    like = f'%{tag.lower()}%'
    total = query('SELECT COUNT(*) as c FROM tools WHERE (LOWER(tags) LIKE ? OR LOWER(category) = ?) AND status = \'published\'', [like, tag.lower()], one=True)
    offset = max(0, (page - 1) * limit)
    tools = query('SELECT * FROM tools WHERE (LOWER(tags) LIKE ? OR LOWER(category) = ?) AND status = \'published\' ORDER BY views DESC LIMIT ? OFFSET ?', [like, tag.lower(), limit, offset])
    return tools, total['c'] if total else 0


def add_tool(tool):
    existing = query('SELECT id, pricing, description FROM tools WHERE slug = ? OR url = ?', [tool.get('slug', ''), tool.get('url', '')], one=True)
    if existing:
        if (existing.get('pricing') or '') != (tool.get('pricing') or '') or (existing.get('description') or '') != (tool.get('description') or ''):
            execute('UPDATE tools SET pricing=?, description=?, short_desc=?, category=?, url=?, tags=?, compatible_tools=?, name=?, last_updated=datetime(\'now\') WHERE id=?',
                [tool.get('pricing') or existing['pricing'], tool.get('description') or existing['description'],
                 tool.get('short_desc') or existing['short_desc'], tool.get('category') or existing['category'],
                 tool.get('url') or existing['url'], tool.get('tags') or existing['tags'],
                 tool.get('compatible_tools') or existing['compatible_tools'], tool.get('name') or existing['name'],
                 existing['id']])
        return {'status': 'updated', 'id': existing['id']}
    tag = 'regular'
    if (tool.get('votes') or 0) > 50:
        tag = 'trending'
    tid = execute('INSERT INTO tools (name, slug, description, short_desc, category, pricing, url, logo_url, logo_type, tags, compatible_tools, views, votes, featured, tag, status, last_updated) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, \'published\', datetime(\'now\'))',
        [tool.get('name'), tool.get('slug'), tool.get('description', ''), tool.get('short_desc', ''),
         tool.get('category', ''), tool.get('pricing', 'free'), tool.get('url', ''),
         tool.get('logo_url', ''), tool.get('logo_type', 'favicon'), tool.get('tags', ''),
         tool.get('compatible_tools', ''), tool.get('views', 0), tool.get('votes', 0),
         tool.get('featured', 0), tag])
    created = query('SELECT created_at FROM tools WHERE id = ?', [tid], one=True)
    if created and tag == 'regular':
        now = datetime.utcnow()
        try:
            created_dt = datetime.fromisoformat(created['created_at'].replace('Z', '+00:00').replace(' ', 'T'))
            if (now - created_dt).total_seconds() < 86400:
                execute('UPDATE tools SET tag = \'new\' WHERE id = ?', [tid])
                tag = 'new'
        except Exception:
            pass
    return {'status': 'inserted', 'id': tid}


def get_alternatives(slug):
    tool = query('SELECT * FROM tools WHERE slug = ? AND status = \'published\'', [slug], one=True)
    if not tool:
        return None
    alternatives = query('SELECT * FROM tools WHERE category = ? AND slug != ? AND status = \'published\' ORDER BY views DESC LIMIT 12', [tool['category'], slug])
    return {'tool': tool, 'alternatives': alternatives}


def compare_tools(slug1, slug2):
    t1 = query('SELECT * FROM tools WHERE slug = ? AND status = \'published\'', [slug1], one=True)
    t2 = query('SELECT * FROM tools WHERE slug = ? AND status = \'published\'', [slug2], one=True)
    if not t1 or not t2:
        return None
    return {'tool1': t1, 'tool2': t2}


# ─────────────────────────────
# BLOGS
# ─────────────────────────────

def get_blogs(category=None, page=1, limit=12):
    where = ["status = 'published'"]
    args = []
    if category and category != 'all':
        where.append('category = ?')
        args.append(category)
    total = query(f'SELECT COUNT(*) as c FROM blogs WHERE {" AND ".join(where)}', args, one=True)
    offset = max(0, (page - 1) * limit)
    blogs = query(f'SELECT * FROM blogs WHERE {" AND ".join(where)} ORDER BY published_at DESC LIMIT ? OFFSET ?', args + [limit, offset])
    return blogs, total['c'] if total else 0


def get_blog(slug):
    blog = query('SELECT * FROM blogs WHERE slug = ? AND status = \'published\'', [slug], one=True)
    if not blog:
        return None
    if blog.get('faq_schema'):
        try:
            blog['faq_schema'] = json.loads(blog['faq_schema'])
        except Exception:
            blog['faq_schema'] = None
    return blog


def add_blog(blog):
    existing = query('SELECT id FROM blogs WHERE slug = ?', [blog.get('slug')], one=True)
    if existing:
        return {'status': 'duplicate', 'id': existing['id']}
    bid = execute('INSERT INTO blogs (title, slug, content, meta_description, focus_keyword, faq_schema, category, tool_slug, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, \'pending\')',
        [blog.get('title'), blog.get('slug'), blog.get('content', ''), blog.get('meta_description', ''),
         blog.get('focus_keyword', ''), json.dumps(blog.get('faq_schema') or []),
         blog.get('category', 'review'), blog.get('tool_slug')])
    return {'status': 'inserted', 'id': bid}


# ─────────────────────────────
# PROMPTS
# ─────────────────────────────

def get_prompts(category=None, compatible_tools=None, page=1, limit=24):
    where = ["status = 'published'"]
    args = []
    if category:
        where.append('category = ?')
        args.append(category)
    if compatible_tools:
        where.append('compatible_tools LIKE ?')
        args.append(f'%{compatible_tools}%')
    total = query(f'SELECT COUNT(*) as c FROM prompts WHERE {" AND ".join(where)}', args, one=True)
    offset = max(0, (page - 1) * limit)
    prompts = query(f'SELECT * FROM prompts WHERE {" AND ".join(where)} ORDER BY created_at DESC LIMIT ? OFFSET ?', args + [limit, offset])
    return prompts, total['c'] if total else 0


def get_prompt(slug):
    prompt = query('SELECT * FROM prompts WHERE slug = ? AND status = \'published\'', [slug], one=True)
    if not prompt:
        return None
    execute('UPDATE prompts SET copy_count = copy_count + 1 WHERE id = ?', [prompt['id']])
    prompt['copy_count'] = (prompt.get('copy_count', 0) or 0) + 1
    return prompt


def add_prompt(prompt):
    pid = execute('INSERT INTO prompts (title, slug, prompt_text, description, category, compatible_tools, preview_image_url, status) VALUES (?, ?, ?, ?, ?, ?, ?, \'pending\')',
        [prompt.get('title'), prompt.get('slug'), prompt.get('prompt_text', ''), prompt.get('description', ''),
         prompt.get('category', ''), prompt.get('compatible_tools', ''), prompt.get('preview_image_url', '')])
    return {'status': 'inserted', 'id': pid}


def increment_prompt_copy(pid):
    execute('UPDATE prompts SET copy_count = copy_count + 1 WHERE id = ?', [pid])
    return True


def bulk_insert_tools(tools):
    inserted = 0
    updated = 0
    skipped = 0
    for tool in tools:
        if not tool or not tool.get('name'):
            skipped += 1
            continue
        try:
            result = add_tool(tool)
            if result['status'] == 'inserted':
                inserted += 1
            elif result['status'] == 'updated':
                updated += 1
            else:
                skipped += 1
        except Exception:
            skipped += 1
    return {'inserted': inserted, 'updated': updated, 'skipped': skipped}


# ─────────────────────────────
# CATEGORIES
# ─────────────────────────────

def get_categories():
    execute('UPDATE categories SET tool_count = (SELECT COUNT(*) FROM tools WHERE category = categories.name AND status = \'published\')')
    return query('SELECT * FROM categories ORDER BY tool_count DESC')


# ─────────────────────────────
# STATS
# ─────────────────────────────

def get_stats():
    tools = query('SELECT COUNT(*) as c FROM tools WHERE status = \'published\'', one=True)
    blogs = query('SELECT COUNT(*) as c FROM blogs WHERE status = \'published\'', one=True)
    prompts = query('SELECT COUNT(*) as c FROM prompts WHERE status = \'published\'', one=True)
    categories = query('SELECT COUNT(*) as c FROM categories', one=True)
    today = query('SELECT COUNT(*) as c FROM tools WHERE created_at > date(\'now\')', one=True)
    return {
        'total_tools': tools['c'] if tools else 0,
        'total_blogs': blogs['c'] if blogs else 0,
        'total_prompts': prompts['c'] if prompts else 0,
        'total_categories': categories['c'] if categories else 0,
        'today_added': today['c'] if today else 0
    }


# ─────────────────────────────
# SUBSCRIBERS
# ─────────────────────────────

def add_subscriber(email):
    execute('INSERT OR IGNORE INTO subscribers (email) VALUES (?)', [email])
    return True


# ─────────────────────────────
# SUBMITTED TOOLS
# ─────────────────────────────

def add_submitted_tool(data):
    return execute('INSERT INTO submitted_tools (name, url, category, short_desc, pricing, submitter_email) VALUES (?, ?, ?, ?, ?, ?)',
        [data.get('name'), data.get('url'), data.get('category', ''), data.get('short_desc', ''), data.get('pricing', ''), data.get('email', '')])