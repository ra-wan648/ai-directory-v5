import re
import json
import os
import requests
from flask import (
    Flask, Response, jsonify, request, send_from_directory
)
from werkzeug.middleware.proxy_fix import ProxyFix
from db import (
    add_blog, add_prompt, add_submitted_tool, add_subscriber, add_tool,
    bulk_insert_tools, compare_tools, get_alternatives, get_blog, get_blogs,
    get_categories, get_featured_tools, get_new_tools, get_prompt, get_prompts,
    get_stats, get_tool, get_tools, get_trending_tools,
    increment_prompt_copy, init_db
)

app = Flask(__name__)
app.wsgi_app = ProxyFix(app.wsgi_app)
init_db()

CORS_HEADERS = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Content-Type": "application/json",
}

TRANS = ((chr(38) + chr(34) + "amp;" + chr(34), chr(38) + chr(34) + "amp;" + chr(34)),
          (chr(60) + chr(34) + "lt;" + chr(34), chr(60) + chr(34) + "lt;" + chr(34)),
          (chr(62) + chr(34) + "gt;" + chr(34), chr(62) + chr(34) + "gt;" + chr(34)),
          (chr(34),   chr(38) + chr(34) + "quot;" + chr(34)))


def esc(s):
    if s is None:
        return ""
    s = str(s)
    for old, new in TRANS:
        s = s.replace(old, new)
    return s


def make_json(data, status=200, ttl=None):
    body = json.dumps(data, ensure_ascii=False)
    h = dict(CORS_HEADERS)
    if ttl:
        h["Cache-Control"] = f"public, max-age={ttl}"
    return Response(body, status=status, headers=h)


def make_xml(xml_str, ttl=3600):
    return Response(xml_str, status=200, headers={
        **CORS_HEADERS,
        "Cache-Control": f"public, max-age={ttl}",
        "Content-Type": "application/xml",
    })


def body_json():
    return request.get_json(force=True, silent=True) or {}


# ─── pages ─────────────────────────────────────────────────────────
@app.route("/")
def page_index(): return send_from_directory(".", "index.html")

@app.route("/index.html")
def page_index_alias(): return send_from_directory(".", "index.html")

@app.route("/tool.html")
def page_tool(): return send_from_directory(".", "tool.html")

@app.route("/blog.html")
def page_blog(): return send_from_directory(".", "blog.html")

@app.route("/post.html")
def page_post(): return send_from_directory(".", "post.html")

@app.route("/prompts.html")
def page_prompts(): return send_from_directory(".", "prompts.html")

@app.route("/submit.html")
def page_submit(): return send_from_directory(".", "submit.html")

@app.route("/compare.html")
def page_compare(): return send_from_directory(".", "compare.html")


# ─── static files ──────────────────────────────────────────────────
@app.route("/styles.css")
def css(): return send_from_directory(".", "styles.css", mimetype="text/css")

@app.route("/js/<path:filename>")
def js(filename): return send_from_directory("js", filename, mimetype="application/javascript")

@app.route("/public/<path:filename>")
def public(filename): return send_from_directory("public", filename)

@app.route("/favicon.ico")
def favicon():
    return send_from_directory(".", "favicon.ico") if os.path.exists("favicon.ico") else Response("", 204)

@app.route("/sitemap.xml")
def sitemap():
    tools = get_tools({}, page=1, limit=100000)[0]
    blogs = get_blogs(None, page=1, limit=100000)[0]
    base = os.environ.get("SITE_URL", "") or request.host_url.rstrip("/")
    lines = [f"<url><loc>{base}/</loc></url>"]
    for t in tools:
        loc = f"{base}/tool/{esc(t.get('slug', ''))}"
        mod = ""
        update = t.get("last_updated") or t.get("created_at", "")
        if update:
            mod = f"<lastmod>{esc(str(update).split(' ')[0])}</lastmod>"
        lines.append(f"<url><loc>{loc}</loc>{mod}</url>")
    for b in blogs:
        loc = f"{base}/post/{esc(b.get('slug', ''))}"
        mod = ""
        if b.get("published_at"):
            mod = f"<lastmod>{esc(str(b['published_at']).split(' ')[0])}</lastmod>"
        lines.append(f"<url><loc>{loc}</loc>{mod}</url>")
    xml = '<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n' + "\n".join(lines) + "\n</urlset>"
    return make_xml(xml, ttl=3600)


@app.route("/robots.txt")
def robots():
    base = os.environ.get("SITE_URL", "") or request.host_url.rstrip("/")
    text = f"User-agent: *\nAllow: /\nDisallow: /api/internal/\n\nSitemap: {base}/sitemap.xml"
    return Response(text, headers={**CORS_HEADERS, "Content-Type": "text/plain"})


# ─── tool API ──────────────────────────────────────────────────────
@app.route("/api/tools")
def api_tools():
    p = request.args
    page = max(1, int(p.get("page", 1)))
    limit = min(100, max(1, int(p.get("limit", 40))))
    filters = {
        "category": p.get("category", ""),
        "pricing": p.get("pricing", ""),
        "q": p.get("q", ""),
        "sort": p.get("sort", "newest"),
        "tag": p.get("tag", ""),
    }
    tools, total = get_tools(filters, page, limit)
    return make_json({"tools": tools, "total": total, "page": page, "limit": limit}, ttl=600)


@app.route("/api/tools/new")
def api_tools_new():
    return make_json({"tools": get_new_tools(6)})


@app.route("/api/tools/trending")
def api_tools_trending():
    return make_json({"tools": get_trending_tools(6)})


@app.route("/api/tools/featured")
def api_tools_featured():
    return make_json({"tools": get_featured_tools(3)})


@app.route("/api/tools/tag/<tag>")
def api_tools_tag(tag):
    page = max(1, int(request.args.get("page", 1)))
    limit = min(100, max(1, int(request.args.get("limit", 40))))
    tools, total = get_tools_by_tag(tag, page, limit)
    return make_json({"tools": tools, "total": total, "page": page, "limit": limit}, ttl=600)


@app.route("/api/tools/<slug>")
def api_tool_slug(slug):
    data = get_tool(slug)
    if not data:
        return make_json({"error": "Tool not found"}, 404)
    return make_json(data)


@app.route("/api/alternatives/<slug>")
def api_alternatives(slug):
    data = get_alternatives(slug)
    if not data:
        return make_json({"error": "Tool not found"}, 404)
    return make_json(data)


@app.route("/api/compare/<slug1>/<slug2>")
def api_compare(slug1, slug2):
    data = compare_tools(slug1, slug2)
    if not data:
        return make_json({"error": "One or both tools not found"}, 404)
    return make_json(data)


# ─── blog API ──────────────────────────────────────────────────────
@app.route("/api/blogs")
def api_blogs():
    p = request.args
    page = max(1, int(p.get("page", 1)))
    limit = min(50, max(1, int(p.get("limit", 12))))
    cat = p.get("category", "")
    blogs, total = get_blogs(cat if cat != "all" else None, page, limit)
    return make_json({"blogs": blogs, "total": total, "page": page, "limit": limit}, ttl=600)


@app.route("/api/blogs/<slug>")
def api_blog_slug(slug):
    blog = get_blog(slug)
    if not blog:
        return make_json({"error": "Blog not found"}, 404)
    return make_json({"blog": blog})


# ─── prompt API ────────────────────────────────────────────────────
@app.route("/api/prompts")
def api_prompts():
    p = request.args
    page = max(1, int(p.get("page", 1)))
    limit = min(50, max(1, int(p.get("limit", 24))))
    cat = p.get("category", "")
    comp = p.get("compatible_tools", "")
    prompts, total = get_prompts(cat or None, comp or None, page, limit)
    return make_json({"prompts": prompts, "total": total, "page": page, "limit": limit}, ttl=600)


@app.route("/api/prompts/<slug>")
def api_prompt_slug(slug):
    prompt = get_prompt(slug)
    if not prompt:
        return make_json({"error": "Prompt not found"}, 404)
    return make_json({"prompt": prompt})


@app.route("/api/prompts/copy/<int:pid>", methods=["POST"])
def api_prompt_copy(pid):
    increment_prompt_copy(pid)
    return make_json({"success": True})


# ─── categories & stats ────────────────────────────────────────────
@app.route("/api/categories")
def api_categories():
    cats = get_categories()
    return make_json({"categories": cats}, ttl=3600)


@app.route("/api/stats")
def api_stats():
    return make_json(get_stats(), ttl=300)


@app.route("/api/search-all")
def api_search_all():
    tools, _ = get_tools({}, page=1, limit=500)
    return make_json({"tools": tools}, ttl=600)


# ─── public forms ──────────────────────────────────────────────────
@app.route("/api/subscribe", methods=["POST"])
def api_subscribe():
    data = body_json()
    email = (data.get("email") or "").strip().lower()
    if not email or not re.match(r'^[^\s@]+@[^\s@]+\.[^\s@]+$', email):
        return make_json({"error": "Invalid email"}, 400)
    add_subscriber(email)
    return make_json({"success": True})


@app.route("/api/submit-tool", methods=["POST"])
def api_submit_tool():
    data = body_json()
    name = (data.get("name") or "").strip()
    url = (data.get("url") or "").strip()
    if not name or not url:
        return make_json({"error": "Name and URL required"}, 400)
    sid = add_submitted_tool({
        "name": name, "url": url,
        "category": data.get("category", ""),
        "short_desc": data.get("short_desc", ""),
        "pricing": data.get("pricing", ""),
        "email": data.get("email", ""),
    })
    token = os.environ.get("TELEGRAM_BOT_TOKEN", "")
    chat = os.environ.get("ADMIN_TELEGRAM_ID", "")
    if token and chat:
        try:
            text = "\U0001f527 New Tool Submitted!\nName: %s\nURL: %s\nCategory: %s" % (name, url, data.get("category", "N/A"))
            markup = {"inline_keyboard": [[
                {"text": "\u2705 Approve", "callback_data": "approve_tool_%d" % sid},
                {"text": "\u274c Reject", "callback_data": "reject_tool_%d" % sid},
            ]]}
            requests.post(
                "https://api.telegram.org/bot%s/sendMessage" % token,
                json={"chat_id": chat, "text": text, "parse_mode": "HTML", "reply_markup": markup},
                timeout=10,
            )
        except Exception as e:
            print("[WARN] Telegram failed:", e)
    return make_json({"success": True, "id": sid})


# ─── internal API (for pipeline / bulk_import) ─────────────────────
@app.route("/api/internal/add-tool", methods=["POST"])
def internal_add_tool():
    data = body_json()
    result = add_tool(data)
    return make_json(result)


@app.route("/api/internal/add-blog", methods=["POST"])
def internal_add_blog():
    data = body_json()
    result = add_blog(data)
    return make_json(result)


@app.route("/api/internal/add-prompt", methods=["POST"])
def internal_add_prompt():
    data = body_json()
    result = add_prompt(data)
    return make_json(result)


@app.route("/api/internal/bulk-insert", methods=["POST"])
def internal_bulk_insert():
    data = body_json()
    tools = data.get("tools") or []
    if not isinstance(tools, list):
        return make_json({"error": "tools array required"}, 400)
    result = bulk_insert_tools(tools)
    return make_json(result)


# ─── CORS preflight ────────────────────────────────────────────────
@app.route("/api/internal/<path:path>", methods=["OPTIONS"])
@app.route("/<path:path>", methods=["OPTIONS"])
@app.route("/", methods=["OPTIONS"])
def cors_any(path=""):
    return Response("", 204, headers=CORS_HEADERS)


if __name__ == "__main__":
    port = int(os.environ.get("PORT", 5173))
    print(f"Starting Flask on port {port}")
    print(f"DB: {os.path.join(os.path.dirname(os.path.abspath(__file__)), 'directory.db')}")
    app.run(host="0.0.0.0", port=port, threaded=True, debug=False)
