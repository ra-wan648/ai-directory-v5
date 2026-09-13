const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json'
};

const json = (data, status = 200) => {
  return new Response(JSON.stringify(data), {
    status,
    headers: CORS_HEADERS
  });
};

const jsonError = (message, status = 500) => {
  return json({ error: message }, status);
};

const okResponse = (data) => {
  return new Response(JSON.stringify(data), {
    status: 200,
    headers: CORS_HEADERS
  });
};

const withCors = (response) => {
  if (!response) return response;
  const next = new Response(response.body, response);
  next.headers.set('Access-Control-Allow-Origin', '*');
  next.headers.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  next.headers.set('Access-Control-Allow-Headers', 'Content-Type');
  return next;
};

async function getJsonBody(request) {
  try {
    return await request.json();
  } catch (e) {
    return null;
  }
}

function isInternal(request, env) {
  const key = request.headers.get('X-Internal-Key') || '';
  return key === env.INTERNAL_API_KEY;
}

// A second copy of every cached response, kept for a week. It is only ever read
// when the handler throws, so a D1 read-limit or an outage serves yesterday's
// data instead of a 500. Before this, an exhausted quota took the whole site
// down and every visitor re-hit D1, which made the outage worse.
const STALE_TTL = 604800;
const STALE_PARAM = '__stale';

function staleRequestFor(cacheUrl) {
  const u = new URL(cacheUrl.toString());
  u.searchParams.set(STALE_PARAM, '1');
  return new Request(u.toString(), { method: 'GET' });
}

// Stable short key. Query strings and SQL fragments contain spaces and quotes,
// which do not survive being pasted into a URL, so hash them.
function hashKey(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(36);
}

async function cacheFetch(request, env, cacheKey, ttl, handler) {
  const cache = typeof caches !== 'undefined' ? caches.default : null;
  const url = new URL(request ? request.url : `https://worker.local/${cacheKey}`);
  const cacheUrl = new URL(url.toString());
  const cacheRequest = new Request(cacheUrl.toString(), request || { method: 'GET' });
  let response = cache ? await cache.match(cacheRequest) : null;
  if (response) return response;

  try {
    response = await handler();
  } catch (e) {
    const stale = cache ? await cache.match(staleRequestFor(cacheUrl)) : null;
    if (stale) {
      console.error('handler failed, serving the last good copy:', e && e.message);
      return stale;
    }
    throw e;
  }

  if (response.status === 200 && cache) {
    const body = await response.text();
    try {
      const freshHeaders = new Headers(response.headers);
      freshHeaders.set('Cache-Control', `public, max-age=${ttl}`);
      const fresh = new Response(body, { status: 200, headers: freshHeaders });
      await cache.put(cacheRequest, fresh.clone());

      const staleHeaders = new Headers(response.headers);
      staleHeaders.set('Cache-Control', `public, max-age=${STALE_TTL}`);
      await cache.put(staleRequestFor(cacheUrl),
                      new Response(body, { status: 200, headers: staleHeaders }));
      return fresh;
    } catch (e) {
      // A cache write must never break the response.
      console.error('cache put failed:', e && e.message);
      return new Response(body, { status: 200, headers: response.headers });
    }
  }
  return response;
}

function slugify(name) {
  return String(name || '')
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

async function sendTelegramMessage(token, chatId, text, replyMarkup) {
  const body = {
    chat_id: chatId,
    text: text,
    parse_mode: 'HTML'
  };
  if (replyMarkup) body.reply_markup = replyMarkup;
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    return await res.json();
  } catch (e) {
    console.error('Telegram send failed:', e);
    return null;
  }
}

async function telegramCallback(token, callbackId) {
  try {
    await fetch(`https://api.telegram.org/bot${token}/answerCallbackQuery`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ callback_query_id: callbackId })
    });
  } catch (e) {
    console.error('answerCallbackQuery failed:', e);
  }
}

async function telegramEditMessage(token, chatId, messageId, text) {
  try {
    await fetch(`https://api.telegram.org/bot${token}/editMessageText`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        message_id: messageId,
        text: text,
        parse_mode: 'HTML'
      })
    });
  } catch (e) {
    console.error('editMessageText failed:', e);
  }
}

// Derived at query time from the stored URL so it also covers newly scraped rows.
const SOURCE_SQL = `CASE
  WHEN url LIKE '%huggingface.co%'   THEN 'huggingface'
  WHEN url LIKE '%producthunt%'      THEN 'producthunt'
  WHEN url LIKE '%github.com%'       THEN 'github'
  WHEN url LIKE '%news.ycombinator%' THEN 'hackernews'
  ELSE 'web' END`;

function buildToolsWhere(params) {
  const category = params.get('category') || '';
  const pricing = params.get('pricing') || '';
  const q = params.get('q') || '';
  const sort = params.get('sort') || 'newest';
  const tag = params.get('tag') || '';
  const source = params.get('source') || '';
  const featured = params.get('featured') || '';
  const days = parseInt(params.get('days') || '0', 10);
  const page = Math.max(1, parseInt(params.get('page') || '1', 10));
  const limit = Math.min(100, Math.max(1, parseInt(params.get('limit') || '40', 10)));

  let where = ["status = 'published'"];
  let binds = [];

  if (category) {
    where.push('LOWER(category) = ?');
    binds.push(category.toLowerCase());
  }
  if (pricing) {
    where.push('LOWER(pricing) = ?');
    binds.push(pricing.toLowerCase());
  }
  if (q) {
    where.push('(LOWER(name) LIKE ? OR LOWER(description) LIKE ? OR LOWER(tags) LIKE ?)');
    const like = `%${q.toLowerCase()}%`;
    binds.push(like, like, like);
  }
  if (tag) {
    where.push('tag = ?');
    binds.push(tag);
  }
  if (source) {
    where.push(`(${SOURCE_SQL}) = ?`);
    binds.push(source.toLowerCase());
  }
  if (featured === '1' || featured === 'true') {
    where.push('featured = 1');
  }
  if (days > 0) {
    where.push(`created_at > datetime('now', '-${days} days')`);
  }

  let orderBy = 'created_at DESC';
  if (sort === 'views') orderBy = 'views DESC, created_at DESC';
  if (sort === 'votes') orderBy = 'votes DESC, created_at DESC';
  if (sort === 'alphabetical' || sort === 'name') orderBy = 'name ASC';

  return { where: where.join(' AND '), binds, orderBy,
           page, limit, offset: (page - 1) * limit };
}

// Counting a filtered set is the most expensive read on the site: COUNT over
// tools scans every matching index entry (12,345 rows before the junk cleanup),
// and it used to run on every cache miss of every filter combination. The number
// only feeds a label in the UI, so it is cached for six hours under its own key
// and a failure reports 0 instead of taking the page down with a 500.
async function getToolsTotal(env, params) {
  const { where, binds } = buildToolsWhere(params);
  const key = 'api-tools-count-v1?' + hashKey(where + '|' + JSON.stringify(binds));
  const res = await cacheFetch(null, env, key, 86400, async () => {
    const row = await env.DB.prepare(
      `SELECT COUNT(*) as total FROM tools WHERE ${where}`
    ).bind(...binds).first();
    return okResponse({ total: row ? row.total : 0 });
  });
  try {
    return (await res.json()).total || 0;
  } catch (e) {
    return 0;
  }
}

async function getToolsList(env, params) {
  const { where, binds, orderBy, page, limit, offset } = buildToolsWhere(params);

  const result = await env.DB.prepare(
    `SELECT * FROM tools WHERE ${where} ORDER BY ${orderBy} LIMIT ? OFFSET ?`
  ).bind(...binds, limit, offset).all();

  return {
    tools: result.results,
    total: await getToolsTotal(env, params),
    page: page,
    limit: limit
  };
}

const handler = {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const pathname = url.pathname;
    const method = request.method;

    if (method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    try {
      return withCors(await this.route(request, env, ctx, url, pathname, method));
    } catch (e) {
      console.error('Route error:', e);
      return withCors(jsonError(e.message || 'Internal server error', 500));
    }
  },

  async route(request, env, ctx, url, pathname, method) {
    // ─── XML/TEXT routes ───
    if (pathname === '/sitemap.xml') {
      return this.sitemap(env);
    }
    if (pathname === '/rss.xml') {
      return this.rss(env);
    }
    if (pathname === '/robots.txt') {
      return this.robots(env);
    }

    // ─── OG image route ───
    let match = pathname.match(/^\/og\/tool\/(.+)$/);
    if (match) {
      return this.ogImage(env, decodeURIComponent(match[1]));
    }

    // ─── Tag route ───
    match = pathname.match(/^\/tag\/(.+)$/);
    if (match) {
      return this.byTag(env, url, decodeURIComponent(match[1]));
    }

    // ─── Alternatives route ───
    match = pathname.match(/^\/alternatives\/(.+)$/);
    if (match) {
      return this.alternatives(env, decodeURIComponent(match[1]));
    }

    // ─── Compare route ───
    match = pathname.match(/^\/compare\/([^/]+)\/([^/]+)$/);
    if (match) {
      return this.compare(env, decodeURIComponent(match[1]), decodeURIComponent(match[2]));
    }

    // ─── Internal routes ───
    if (pathname.startsWith('/api/internal/')) {
      if (!isInternal(request, env)) {
        return jsonError('Unauthorized', 401);
      }
      switch (pathname) {
        case '/api/internal/add-tool':
          return this.addTool(env, await getJsonBody(request));
        case '/api/internal/add-blog':
          return this.addBlog(env, await getJsonBody(request));
        case '/api/internal/add-prompt':
          return this.addPrompt(env, await getJsonBody(request));
        case '/api/internal/bulk-insert':
          return this.bulkInsert(env, await getJsonBody(request));
        default:
          return jsonError('Not found', 404);
      }
    }

    // ─── Telegram webhook ───
    if (pathname === '/telegram-webhook' && method === 'POST') {
      return this.telegramWebhook(env, await getJsonBody(request));
    }

    // ─── API routes ───
    if (pathname === '/api/tools' && method === 'GET') {
      const params = url.searchParams;
      return this.apiToolsList(env, params);
    }

    if (pathname === '/api/tools/new' && method === 'GET') {
      return this.apiToolsNew(env, url);
    }

    if (pathname === '/api/tools/trending' && method === 'GET') {
      return this.apiToolsTrending(env, url);
    }

    if (pathname === '/api/tools/featured' && method === 'GET') {
      return this.apiToolsFeatured(env, url);
    }

    if (pathname === '/api/news' && method === 'GET') {
      return this.apiNews(env, url);
    }

    if (pathname === '/api/search' && method === 'GET') {
      return this.apiSearch(env, url.searchParams);
    }

    if (pathname === '/api/free-tools' && method === 'GET') {
      return this.apiFreeTools(env);
    }

    if (pathname === '/api/compare' && method === 'GET') {
      return this.apiCompare(env, url.searchParams);
    }

    match = pathname.match(/^\/api\/tools\/([^/]+)$/);
    if (match && method === 'GET') {
      return this.apiToolsSlug(env, decodeURIComponent(match[1]));
    }

    if (pathname === '/api/blogs' && method === 'GET') {
      return this.apiBlogs(env, url.searchParams);
    }

    match = pathname.match(/^\/api\/blogs\/([^/]+)$/);
    if (match && method === 'GET') {
      return this.apiBlogsSlug(env, decodeURIComponent(match[1]));
    }

    if (pathname === '/api/prompts' && method === 'GET') {
      return this.apiPrompts(env, url.searchParams);
    }

    match = pathname.match(/^\/api\/prompts\/copy\/(\d+)$/);
    if (match && method === 'POST') {
      return this.apiPromptsCopy(env, match[1]);
    }

    match = pathname.match(/^\/api\/prompts\/([^/]+)$/);
    if (match && method === 'GET') {
      return this.apiPromptsSlug(env, decodeURIComponent(match[1]));
    }

    if (pathname === '/api/categories' && method === 'GET') {
      return this.apiCategories(env);
    }

    if (pathname === '/api/stats' && method === 'GET') {
      return this.apiStats(env);
    }

    if (pathname === '/api/subscribe' && method === 'POST') {
      return this.apiSubscribe(env, await getJsonBody(request));
    }

    if (pathname === '/api/submit-tool' && method === 'POST') {
      return this.apiSubmitTool(env, await getJsonBody(request));
    }

    return jsonError('Not found', 404);
  },

  // ─────────────────────────────
  // ROUTE 1: GET /api/tools
  // ─────────────────────────────
  async apiToolsList(env, params) {
    // The cache key MUST include the query string, otherwise every filter/sort/page
    // combination shares one cached response.
    const qs = new URLSearchParams([...params.entries()].sort()).toString();
    // An hour, not ten minutes: the directory changes once a day, so the short
    // TTL bought nothing and re-read the whole table six times more often.
    return cacheFetch(null, env, 'api-tools-v3?' + qs, 3600, async () => {
      const data = await getToolsList(env, params);
      return okResponse(data);
    });
  },

  // ─────────────────────────────
  // ROUTE 2: GET /api/tools/new
  // ─────────────────────────────
  async apiToolsNew(env, url) {
    const limit = Math.min(48, Math.max(1, parseInt(url.searchParams.get('limit') || '8', 10)));
    // This route had no cache at all, so every homepage view ran both queries.
    return cacheFetch(null, env, 'api-tools-new-v1?limit=' + limit, 1800, async () => {
      const result = await env.DB.prepare(
        `SELECT * FROM tools
         WHERE status = 'published'
           AND (tag = 'new' OR created_at > datetime('now', '-48 hours'))
         ORDER BY created_at DESC LIMIT ?`
      ).bind(limit).all();
      const today = await env.DB.prepare(
        `SELECT COUNT(*) AS c FROM tools
         WHERE status = 'published' AND created_at > datetime('now', '-24 hours')`
      ).first();
      return okResponse({ tools: result.results, total: result.results.length, today: today ? today.c : 0 });
    });
  },

  // ─────────────────────────────
  // ROUTE 3: GET /api/tools/trending
  // NOTE: the stored views/votes columns are all zero, so "trending" cannot yet be
  // ranked by real engagement. Until the pipeline collects a real signal (GitHub
  // stars, Product Hunt upvotes), this returns the freshest tools from the last
  // 7 days. Swap the ORDER BY once real signals exist.
  // ─────────────────────────────
  async apiToolsTrending(env, url) {
    const limit = Math.min(48, Math.max(1, parseInt(url.searchParams.get('limit') || '6', 10)));
    return cacheFetch(null, env, 'api-tools-trending-v1?limit=' + limit, 1800, async () => {
      const result = await env.DB.prepare(
        `SELECT * FROM tools
         WHERE status = 'published' AND created_at > datetime('now', '-7 days')
         ORDER BY votes DESC, views DESC, created_at DESC LIMIT ?`
      ).bind(limit).all();
      return okResponse({ tools: result.results });
    });
  },

  // ─────────────────────────────
  // ROUTE 4: GET /api/tools/featured
  // ─────────────────────────────
  async apiToolsFeatured(env, url) {
    const limit = Math.min(48, Math.max(1, parseInt(url.searchParams.get('limit') || '3', 10)));
    return cacheFetch(null, env, 'api-tools-featured-v1?limit=' + limit, 1800, async () => {
      const result = await env.DB.prepare(
        `SELECT * FROM tools
         WHERE featured = 1 AND status = 'published'
         ORDER BY created_at DESC LIMIT ?`
      ).bind(limit).all();
      return okResponse({ tools: result.results });
    });
  },

  // ─────────────────────────────
  // ROUTE 4b: GET /api/search?q=
  // ─────────────────────────────
  async apiSearch(env, params) {
    const q = (params.get('q') || '').trim();
    if (!q) return okResponse({ results: [] });
    const like = `%${q.toLowerCase().replace(/[%_]/g, m => '\\' + m)}%`;
    // Five LIKE scans over the whole table per keystroke; cache the popular terms.
    return cacheFetch(null, env, 'api-search-v1?' + hashKey(q.toLowerCase()), 900, async () => {
      const result = await env.DB.prepare(
        `SELECT name, slug, description, short_desc, category, pricing, url, tags
         FROM tools
         WHERE status = 'published'
           AND (LOWER(name) LIKE ? ESCAPE '\\' OR LOWER(description) LIKE ? ESCAPE '\\'
                OR LOWER(short_desc) LIKE ? ESCAPE '\\' OR LOWER(category) LIKE ? ESCAPE '\\'
                OR LOWER(tags) LIKE ? ESCAPE '\\')
         ORDER BY views DESC
         LIMIT 20`
      ).bind(like, like, like, like, like).all();
      return okResponse({ results: result.results });
    });
  },

  // ─────────────────────────────
  // ROUTE 4c: GET /api/free-tools
  // ─────────────────────────────
  async apiFreeTools(env) {
    return cacheFetch(null, env, 'api-free-tools-v1', 1800, async () => {
      const result = await env.DB.prepare(
        `SELECT name, slug, url, category, pricing
         FROM tools
         WHERE status = 'published' AND pricing = 'free'
         ORDER BY views DESC
         LIMIT 30`
      ).all();
      return okResponse({ tools: result.results });
    });
  },

  // ─────────────────────────────
  // ROUTE 4d: GET /api/compare?slugs=a,b,c,d   (2 to 4 tools)
  //           legacy ?a=&b= still supported
  // ─────────────────────────────
  async apiCompare(env, params) {
    let slugs = (params.get('slugs') || '').split(',').map(s => s.trim()).filter(Boolean);
    if (!slugs.length) {
      slugs = [params.get('a') || '', params.get('b') || ''].filter(Boolean);
    }
    if (slugs.length < 2) {
      return jsonError('At least two tool slugs are required (?slugs=slug1,slug2)', 400);
    }
    slugs = slugs.slice(0, 4);

    return cacheFetch(null, env, 'api-compare-v1?' + hashKey(slugs.join('|')), 1800, async () => {
      const placeholders = slugs.map(() => '?').join(',');
      const result = await env.DB.prepare(
        `SELECT * FROM tools WHERE slug IN (${placeholders}) AND status = 'published'`
      ).bind(...slugs).all();

      const bySlug = Object.fromEntries(result.results.map(t => [t.slug, t]));
      const tools = slugs.map(s => bySlug[s]).filter(Boolean);
      if (tools.length < 2) {
        return jsonError('Fewer than two of those tools were found', 404);
      }
      // tool1/tool2 kept for callers written against the old two-tool shape
      return okResponse({ tools: tools, tool1: tools[0], tool2: tools[1] });
    });
  },

  // ─────────────────────────────
  // ROUTE 4e: GET /api/news?limit=
  // News items live in the blogs table under category 'news'.
  // ─────────────────────────────
  async apiNews(env, url) {
    const limit = Math.min(24, Math.max(1, parseInt(url.searchParams.get('limit') || '8', 10)));
    return cacheFetch(null, env, 'api-news-v1?limit=' + limit, 1800, async () => {
      const result = await env.DB.prepare(
        `SELECT id, title, slug, meta_description, category, published_at, created_at
         FROM blogs
         WHERE status = 'published' AND LOWER(category) = 'news'
         ORDER BY COALESCE(published_at, created_at) DESC LIMIT ?`
      ).bind(limit).all();
      return okResponse({ news: result.results });
    });
  },

  // ─────────────────────────────
  // ROUTE 5: GET /api/tools/:slug
  // ─────────────────────────────
  async apiToolsSlug(env, slug) {
    // Every one of the 8,674 tool pages is in the sitemap, so crawlers walk all
    // of them. Un-cached, that was four D1 calls - including a write - per view.
    // Caching costs a frozen view counter for the hour, and views are not used
    // for ranking yet, so the trade is worth it.
    return cacheFetch(null, env, 'api-tool-v1?' + hashKey(slug), 3600, async () => {
      const tool = await env.DB.prepare(
        `SELECT * FROM tools WHERE slug = ? AND status = 'published'`
      ).bind(slug).first();

      if (!tool) {
        return jsonError('Tool not found', 404);
      }

      await env.DB.prepare(
        `UPDATE tools SET views = views + 1 WHERE slug = ?`
      ).bind(slug).run();
      tool.views = (tool.views || 0) + 1;

      const related = await env.DB.prepare(
        `SELECT * FROM tools
         WHERE category = ? AND slug != ? AND status = 'published'
         ORDER BY views DESC LIMIT 6`
      ).bind(tool.category, slug).all();

      const reviews = await env.DB.prepare(
        `SELECT id, title, slug, category, meta_description, published_at
         FROM blogs WHERE tool_slug = ? AND status = 'published'
         ORDER BY published_at DESC`
      ).bind(slug).all();

      return okResponse({
        tool: tool,
        related: related.results,
        reviews: reviews.results
      });
    });
  },

  // ─────────────────────────────
  // ROUTE 6: GET /api/blogs
  // ─────────────────────────────
  async apiBlogs(env, params) {
    const category = params.get('category') || '';
    const page = Math.max(1, parseInt(params.get('page') || '1', 10));
    const limit = Math.min(50, Math.max(1, parseInt(params.get('limit') || '12', 10)));
    return cacheFetch(null, env, 'api-blogs-v1?' +
                      hashKey(`${category}|${page}|${limit}`), 1800, async () => {
      let where = ["status = 'published'"];
      let binds = [];
      if (category && category !== 'all') {
        where.push('category = ?');
        binds.push(category);
      }

      const countResult = await env.DB.prepare(
        `SELECT COUNT(*) as total FROM blogs WHERE ${where.join(' AND ')}`
      ).bind(...binds).first();

      const offset = (page - 1) * limit;
      const result = await env.DB.prepare(
        `SELECT * FROM blogs WHERE ${where.join(' AND ')}
         ORDER BY published_at DESC LIMIT ? OFFSET ?`
      ).bind(...binds, limit, offset).all();

      return okResponse({
        blogs: result.results,
        total: countResult ? countResult.total : 0,
        page: page,
        limit: limit
      });
    });
  },

  // ─────────────────────────────
  // ROUTE 7: GET /api/blogs/:slug
  // ─────────────────────────────
  async apiBlogsSlug(env, slug) {
    return cacheFetch(null, env, 'api-blog-v1?' + hashKey(slug), 3600, async () => {
      const blog = await env.DB.prepare(
        `SELECT * FROM blogs WHERE slug = ? AND status = 'published'`
      ).bind(slug).first();

      if (!blog) {
        return jsonError('Blog not found', 404);
      }

      if (blog.faq_schema) {
        try {
          blog.faq_schema = JSON.parse(blog.faq_schema);
        } catch (e) {
          blog.faq_schema = null;
        }
      }

      return okResponse({ blog: blog });
    });
  },

  // ─────────────────────────────
  // ROUTE 8: GET /api/prompts
  // ─────────────────────────────
  async apiPrompts(env, params) {
    const category = params.get('category') || '';
    const compatibleTools = params.get('compatible_tools') || '';
    const page = Math.max(1, parseInt(params.get('page') || '1', 10));
    const limit = Math.min(50, Math.max(1, parseInt(params.get('limit') || '24', 10)));
    return cacheFetch(null, env, 'api-prompts-v1?' +
                      hashKey(`${category}|${compatibleTools}|${page}|${limit}`), 1800, async () => {
      let where = ["status = 'published'"];
      let binds = [];

      if (category) {
        where.push('category = ?');
        binds.push(category);
      }
      if (compatibleTools) {
        where.push('compatible_tools LIKE ?');
        binds.push(`%${compatibleTools}%`);
      }

      const countResult = await env.DB.prepare(
        `SELECT COUNT(*) as total FROM prompts WHERE ${where.join(' AND ')}`
      ).bind(...binds).first();

      const offset = (page - 1) * limit;
      const result = await env.DB.prepare(
        `SELECT * FROM prompts WHERE ${where.join(' AND ')}
         ORDER BY created_at DESC LIMIT ? OFFSET ?`
      ).bind(...binds, limit, offset).all();

      return okResponse({
        prompts: result.results,
        total: countResult ? countResult.total : 0,
        page: page,
        limit: limit
      });
    });
  },

  // ─────────────────────────────
  // ROUTE 9: GET /api/prompts/:slug
  // ─────────────────────────────
  async apiPromptsSlug(env, slug) {
    return cacheFetch(null, env, 'api-prompt-v1?' + hashKey(slug), 3600, async () => {
      const prompt = await env.DB.prepare(
        `SELECT * FROM prompts WHERE slug = ? AND status = 'published'`
      ).bind(slug).first();

      if (!prompt) {
        return jsonError('Prompt not found', 404);
      }

      await env.DB.prepare(
        `UPDATE prompts SET copy_count = copy_count + 1 WHERE id = ?`
      ).bind(prompt.id).run();
      prompt.copy_count = (prompt.copy_count || 0) + 1;

      return okResponse({ prompt: prompt });
    });
  },

  // ─────────────────────────────
  // ROUTE 10: POST /api/prompts/copy/:id
  // ─────────────────────────────
  async apiPromptsCopy(env, id) {
    await env.DB.prepare(
      `UPDATE prompts SET copy_count = copy_count + 1 WHERE id = ?`
    ).bind(id).run();
    return okResponse({ success: true });
  },

  // ─────────────────────────────
  // ROUTE 11: GET /api/categories
  // ─────────────────────────────
  async apiCategories(env) {
    return cacheFetch(null, env, 'api-categories-v2', 3600, async () => {
      const result = await env.DB.prepare(
        `SELECT category, COUNT(*) as tool_count
         FROM tools
         WHERE status = 'published' AND category IS NOT NULL AND category != ''
         GROUP BY category
         ORDER BY tool_count DESC`
      ).all();
      return okResponse({ categories: result.results });
    });
  },

  // ─────────────────────────────
  // ROUTE 12: GET /api/stats
  // ─────────────────────────────
  async apiStats(env) {
    return cacheFetch(null, env, 'api-stats', 300, async () => {
      const [totalTools, totalBlogs, totalPrompts, totalCategories, todayAdded] =
        await Promise.all([
          env.DB.prepare(
            `SELECT COUNT(*) as c FROM tools WHERE status = 'published'`
          ).first(),
          env.DB.prepare(
            `SELECT COUNT(*) as c FROM blogs WHERE status = 'published'`
          ).first(),
          env.DB.prepare(
            `SELECT COUNT(*) as c FROM prompts WHERE status = 'published'`
          ).first(),
          env.DB.prepare(
            `SELECT COUNT(*) as c FROM categories`
          ).first(),
          env.DB.prepare(
            `SELECT COUNT(*) as c FROM tools WHERE created_at > date('now')`
          ).first()
        ]);

      return okResponse({
        total_tools: totalTools ? totalTools.c : 0,
        total_blogs: totalBlogs ? totalBlogs.c : 0,
        total_prompts: totalPrompts ? totalPrompts.c : 0,
        total_categories: totalCategories ? totalCategories.c : 0,
        today_added: todayAdded ? todayAdded.c : 0
      });
    });
  },

  // ─────────────────────────────
  // ROUTE 13: POST /api/subscribe
  // ─────────────────────────────
  async apiSubscribe(env, body) {
    if (!body || !body.email) {
      return jsonError('Email is required', 400);
    }
    const email = String(body.email).trim().toLowerCase();
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) {
      return jsonError('Invalid email format', 400);
    }
    await env.DB.prepare(
      `INSERT OR IGNORE INTO subscribers (email) VALUES (?)`
    ).bind(email).run();
    return okResponse({ success: true });
  },

  // ─────────────────────────────
  // ROUTE 14: POST /api/submit-tool
  // ─────────────────────────────
  async apiSubmitTool(env, body) {
    if (!body || !body.name || !body.url) {
      return jsonError('Name and URL are required', 400);
    }
    const result = await env.DB.prepare(
      `INSERT INTO submitted_tools (name, url, category, short_desc, pricing, submitter_email)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).bind(
      body.name,
      body.url,
      body.category || '',
      body.short_desc || '',
      body.pricing || '',
      body.email || ''
    ).run();

    const id = result.meta.last_row_id;

    if (env.TELEGRAM_BOT_TOKEN && env.ADMIN_TELEGRAM_ID) {
      const text =
        `🔧 New Tool Submitted!\n` +
        `Name: ${body.name}\n` +
        `URL: ${body.url}\n` +
        `Category: ${body.category || 'N/A'}`;
      const replyMarkup = {
        inline_keyboard: [[
          { text: '✅ Approve', callback_data: `approve_tool_${id}` },
          { text: '❌ Reject', callback_data: `reject_tool_${id}` }
        ]]
      };
      await sendTelegramMessage(env.TELEGRAM_BOT_TOKEN, env.ADMIN_TELEGRAM_ID, text, replyMarkup);
    }

    return okResponse({ success: true, id: id });
  },

  // ─────────────────────────────
  // ROUTE 15: GET /sitemap.xml
  // ─────────────────────────────
  async sitemap(env) {
    // Every published slug is read to build this, so a long TTL is worth more
    // than truncating the list: dropping URLs would cost search coverage.
    return cacheFetch(null, env, 'sitemap-v5', 21600, async () => {
      const [tools, blogs] = await Promise.all([
        env.DB.prepare(
          `SELECT slug, last_updated, created_at FROM tools WHERE status = 'published'`
        ).all(),
        env.DB.prepare(
          `SELECT slug, published_at FROM blogs WHERE status = 'published'`
        ).all()
      ]);

      const baseUrl = env.SITE_URL || 'https://YOUR_DOMAIN.pages.dev';
      let urls = `<url><loc>${baseUrl}/</loc></url>\n`;
      urls += `<url><loc>${baseUrl}/tools</loc></url>\n`;
      urls += `<url><loc>${baseUrl}/prompts</loc></url>\n`;
      urls += `<url><loc>${baseUrl}/blog</loc></url>\n`;

      // The browse page is the site's main listing, and each category is a
      // landing page in its own right, so both belong in the sitemap.
      try {
        const cats = await env.DB.prepare(
          `SELECT name FROM categories ORDER BY tool_count DESC`
        ).all();
        for (const c of (cats.results || [])) {
          if (!c.name) continue;
          urls += `<url><loc>${baseUrl}/tools?category=${encodeURIComponent(c.name)}</loc></url>\n`;
        }
      } catch (e) { /* the sitemap is still valid without them */ }

      for (const t of tools.results) {
        const lastmod = t.last_updated || t.created_at || '';
        const stamp = lastmod ? `<lastmod>${String(lastmod).split(' ')[0]}</lastmod>` : '';
        urls += `<url><loc>${baseUrl}/tool/${t.slug}</loc>${stamp}</url>\n`;
        // "Alternatives to X" is the page that matches a real search intent, and
        // functions/alternatives/[slug].js renders it with real content. Without
        // an entry here and no inbound links, nothing would ever crawl it.
        urls += `<url><loc>${baseUrl}/alternatives/${t.slug}</loc>${stamp}</url>\n`;
      }
      for (const b of blogs.results) {
        const lastmod = b.published_at || '';
        urls += `<url><loc>${baseUrl}/post/${b.slug}</loc>${lastmod ? `<lastmod>${String(lastmod).split(' ')[0]}</lastmod>` : ''}</url>\n`;
      }

      const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}</urlset>`;
      return new Response(xml, {
        status: 200,
        headers: { 'Content-Type': 'application/xml' }
      });
    });
  },

  // ─────────────────────────────
  // ROUTE 16: GET /rss.xml
  // ─────────────────────────────
  async rss(env) {
    return cacheFetch(null, env, 'rss-v3', 21600, async () => {
      const [tools, blogs] = await Promise.all([
        env.DB.prepare(
          `SELECT name, slug, short_desc, url, created_at FROM tools
           WHERE status = 'published' ORDER BY created_at DESC LIMIT 20`
        ).all(),
        env.DB.prepare(
          `SELECT title, slug, content, meta_description, published_at FROM blogs
           WHERE status = 'published' ORDER BY published_at DESC LIMIT 10`
        ).all()
      ]);

      const baseUrl = env.SITE_URL || 'https://YOUR_DOMAIN.pages.dev';
      const escapeXml = (s) => String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

      let items = '';
      for (const t of tools.results) {
        items += `<item>\n<title>${escapeXml(t.name)}</title>\n<link>${baseUrl}/tool/${t.slug}</link>\n<description>${escapeXml(t.short_desc || t.name)}</description>\n<guid>${baseUrl}/tool/${t.slug}</guid>\n<pubDate>${new Date(t.created_at + 'Z').toUTCString()}</pubDate>\n</item>\n`;
      }
      for (const b of blogs.results) {
        const desc = b.meta_description || String(b.content || '').replace(/<[^>]+>/g, '').slice(0, 200);
        items += `<item>\n<title>${escapeXml(b.title)}</title>\n<link>${baseUrl}/post/${b.slug}</link>\n<description>${escapeXml(desc)}</description>\n<guid>${baseUrl}/post/${b.slug}</guid>\n<pubDate>${new Date(b.published_at + 'Z').toUTCString()}</pubDate>\n</item>\n`;
      }

      const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<rss version="2.0">\n<channel>\n<title>AI Tools Directory</title>\n<link>${baseUrl}</link>\n<description>Latest AI tools, reviews and news</description>\n${items}</channel>\n</rss>`;
      return new Response(xml, {
        status: 200,
        headers: { 'Content-Type': 'application/rss+xml' }
      });
    });
  },

  // ─────────────────────────────
  // ROUTE 17: GET /robots.txt
  // ─────────────────────────────
  robots(env) {
    const baseUrl = env.SITE_URL || 'https://YOUR_DOMAIN.pages.dev';
    const text = `User-agent: *
Allow: /
Disallow: /api/internal/

Sitemap: ${baseUrl}/sitemap.xml`;
    return new Response(text, {
      status: 200,
      headers: { 'Content-Type': 'text/plain' }
    });
  },

  // ─────────────────────────────
  // ROUTE 18: GET /og/tool/:slug
  // ─────────────────────────────
  async ogImage(env, slug) {
    // One cache entry per slug, not one for every tool.
    return cacheFetch(null, env, 'og-image-v2/' + encodeURIComponent(slug), 86400, async () => {
      const tool = await env.DB.prepare(
        `SELECT name, category FROM tools WHERE slug = ?`
      ).bind(slug).first();

      const name = tool ? tool.name : slug;
      const category = tool ? tool.category || 'AI Tool' : 'AI Tool';

      const escapeXml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
      const svg = `<svg width="1200" height="630" xmlns="http://www.w3.org/2000/svg">
  <rect width="1200" height="630" fill="#0d0d0d"/>
  <rect x="60" y="60" width="360" height="56" rx="28" fill="#22c55e" opacity="0.15"/>
  <rect x="72" y="78" width="16" height="16" rx="8" fill="#22c55e"/>
  <text x="100" y="94" font-family="Arial, sans-serif" font-size="28" fill="#22c55e" font-weight="bold">AI Tools Directory</text>
  <text x="60" y="330" font-family="Arial, sans-serif" font-size="72" fill="#f2f2f2" font-weight="bold">${escapeXml(name)}</text>
  <rect x="60" y="380" width="220" height="44" rx="8" fill="#1e3a5f"/>
  <text x="80" y="409" font-family="Arial, sans-serif" font-size="24" fill="#dbeafe">${escapeXml(category)}</text>
  <text x="60" y="560" font-family="Arial, sans-serif" font-size="24" fill="#888888">Find the best AI tools at AI Tools Directory</text>
</svg>`;
      return new Response(svg, {
        status: 200,
        headers: { 'Content-Type': 'image/svg+xml' }
      });
    });
  },

  // ─────────────────────────────
  // ROUTE 19: GET /tag/:tag
  // ─────────────────────────────
  async byTag(env, url, tag) {
    const page = Math.max(1, parseInt(url.searchParams.get('page') || '1', 10));
    const limit = Math.min(100, Math.max(1, parseInt(url.searchParams.get('limit') || '40', 10)));
    // Crawlers walk tag pages hard, and each one ran a LIKE-based COUNT over the
    // whole tools table plus the listing. Cache the pair together.
    return cacheFetch(null, env, 'tag-v1?' + hashKey(`${tag.toLowerCase()}|${page}|${limit}`),
                      1800, async () => {
      const t = tag.toLowerCase().trim();
      // tags is a comma-separated list - "ai tools,free", "ai-tools,insidr",
      // "ai,futurepedia" - so match a whole token. The old LIKE '%ai%' also
      // matched any tag that merely contains those letters ("email" matched
      // /tag/ai), which is why the page advertised almost the whole directory
      // as carrying the tag.
      const token = `%,${t},%`;

      const countResult = await env.DB.prepare(
        `SELECT COUNT(*) as total FROM tools
         WHERE ((',' || LOWER(COALESCE(tags, '')) || ',') LIKE ? OR LOWER(category) = ?)
           AND status = 'published'`
      ).bind(token, t).first();

      const offset = (page - 1) * limit;
      const result = await env.DB.prepare(
        `SELECT * FROM tools
         WHERE ((',' || LOWER(COALESCE(tags, '')) || ',') LIKE ? OR LOWER(category) = ?)
           AND status = 'published'
         ORDER BY views DESC LIMIT ? OFFSET ?`
      ).bind(token, t, limit, offset).all();

      return okResponse({
        tools: result.results,
        total: countResult ? countResult.total : 0,
        page: page,
        limit: limit
      });
    });
  },

  // ─────────────────────────────
  // ROUTE 20: GET /alternatives/:slug
  // ─────────────────────────────
  async alternatives(env, slug) {
    return cacheFetch(null, env, 'alternatives-v1?' + hashKey(slug), 3600, async () => {
      const tool = await env.DB.prepare(
        `SELECT * FROM tools WHERE slug = ? AND status = 'published'`
      ).bind(slug).first();

      if (!tool) {
        return jsonError('Tool not found', 404);
      }

      const alternatives = await env.DB.prepare(
        `SELECT * FROM tools
         WHERE category = ? AND slug != ? AND status = 'published'
         ORDER BY views DESC LIMIT 12`
      ).bind(tool.category, slug).all();

      return okResponse({ tool: tool, alternatives: alternatives.results });
    });
  },

  // ─────────────────────────────
  // ROUTE 21: GET /compare/:slug1/:slug2
  // ─────────────────────────────
  async compare(env, slug1, slug2) {
    return cacheFetch(null, env, 'compare-v1?' + hashKey(slug1 + '|' + slug2), 3600, async () => {
      const [tool1, tool2] = await Promise.all([
        env.DB.prepare(`SELECT * FROM tools WHERE slug = ? AND status = 'published'`).bind(slug1).first(),
        env.DB.prepare(`SELECT * FROM tools WHERE slug = ? AND status = 'published'`).bind(slug2).first()
      ]);

      if (!tool1 || !tool2) {
        return jsonError('One or both tools not found', 404);
      }

      return okResponse({ tool1: tool1, tool2: tool2 });
    });
  },

  // ─────────────────────────────
  // ROUTE 22: POST /api/internal/add-tool
  // ─────────────────────────────
  async addTool(env, body) {
    if (!body || !body.name || !body.slug) {
      return jsonError('Name and slug are required', 400);
    }
    const tool = body;
    if (!tool.slug) tool.slug = slugify(tool.name);

    const existing = await env.DB.prepare(
      `SELECT id, pricing, description FROM tools WHERE slug = ? OR url = ?`
    ).bind(tool.slug, tool.url || '').first();

    if (existing) {
      if (
        (existing.pricing || '') !== (tool.pricing || '') ||
        (existing.description || '') !== (tool.description || '')
      ) {
        await env.DB.prepare(
          `UPDATE tools SET
             pricing = ?, description = ?, short_desc = ?, category = ?,
             url = ?, tags = ?, compatible_tools = ?, name = ?,
             last_updated = datetime('now')
           WHERE id = ?`
        ).bind(
          tool.pricing || existing.pricing,
          tool.description || existing.description,
          tool.short_desc || existing.short_desc,
          tool.category || existing.category,
          tool.url || existing.url,
          tool.tags || existing.tags,
          tool.compatible_tools || existing.compatible_tools,
          tool.name || existing.name,
          existing.id
        ).run();
      }
      return okResponse({ status: 'updated', id: existing.id });
    }

    let tag = 'regular';
    if (tool.votes && tool.votes > 50) tag = 'trending';

    const inserted = await env.DB.prepare(
      `INSERT OR IGNORE INTO tools (name, slug, description, short_desc, category, pricing, url,
         logo_url, logo_type, tags, compatible_tools, views, votes, featured, tag, status, last_updated)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'published', datetime('now'))`
    ).bind(
      tool.name,
      tool.slug,
      tool.description || '',
      tool.short_desc || '',
      tool.category || '',
      tool.pricing || 'free',
      tool.url || '',
      tool.logo_url || '',
      tool.logo_type || 'favicon',
      tool.tags || '',
      tool.compatible_tools || '',
      tool.views || 0,
      tool.votes || 0,
      tool.featured || 0,
      tag
    ).run();

    if (tag === 'regular') {
      const createdRow = await env.DB.prepare(
        `SELECT created_at FROM tools WHERE id = ?`
      ).bind(inserted.meta.last_row_id).first();
      const now = new Date();
      const created = new Date(createdRow.created_at + 'Z');
      if ((now - created) < 24 * 3600 * 1000) {
        tag = 'new';
        await env.DB.prepare(`UPDATE tools SET tag = ? WHERE id = ?`).bind('new', inserted.meta.last_row_id).run();
      }
    }

    return okResponse({ status: 'inserted', id: inserted.meta.last_row_id });
  },

  // ─────────────────────────────
  // ROUTE 23: POST /api/internal/add-blog
  // ─────────────────────────────
  async addBlog(env, body) {
    if (!body || !body.title || !body.slug) {
      return jsonError('Title and slug are required', 400);
    }
    const existing = await env.DB.prepare(
      `SELECT id FROM blogs WHERE slug = ?`
    ).bind(body.slug).first();

    if (existing) {
      return okResponse({ status: 'duplicate', id: existing.id });
    }

    const inserted = await env.DB.prepare(
      `INSERT INTO blogs (title, slug, content, meta_description, focus_keyword, faq_schema, category, tool_slug, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending')`
    ).bind(
      body.title,
      body.slug,
      body.content || '',
      body.meta_description || '',
      body.focus_keyword || '',
      JSON.stringify(body.faq_schema || []),
      body.category || 'review',
      body.tool_slug || null
    ).run();

    return okResponse({ status: 'inserted', id: inserted.meta.last_row_id });
  },

  // ─────────────────────────────
  // ROUTE 24: POST /api/internal/add-prompt
  // ─────────────────────────────
  async addPrompt(env, body) {
    if (!body || !body.title || !body.slug) {
      return jsonError('Title and slug are required', 400);
    }
    const inserted = await env.DB.prepare(
      `INSERT INTO prompts (title, slug, prompt_text, description, category, compatible_tools, preview_image_url, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'pending')`
    ).bind(
      body.title,
      body.slug,
      body.prompt_text || '',
      body.description || '',
      body.category || '',
      body.compatible_tools || '',
      body.preview_image_url || ''
    ).run();

    return okResponse({ status: 'inserted', id: inserted.meta.last_row_id });
  },

  // ─────────────────────────────
  // ROUTE 25: POST /api/internal/bulk-insert
  // ─────────────────────────────
  async bulkInsert(env, body) {
    if (!body || !Array.isArray(body.tools)) {
      return jsonError('tools array is required', 400);
    }
    let inserted = 0, updated = 0, skipped = 0;

    for (const tool of body.tools) {
      if (!tool || !tool.name) { skipped++; continue; }
      try {
        const result = await this.addTool(env, tool);
        const data = await result.json();
        if (data.status === 'inserted') inserted++;
        else if (data.status === 'updated') updated++;
        else skipped++;
      } catch (e) {
        skipped++;
      }
    }

    return okResponse({ inserted: inserted, updated: updated, skipped: skipped });
  },

  // ─────────────────────────────
  // ROUTE 26: POST /telegram-webhook
  // ─────────────────────────────
  async telegramWebhook(env, body) {
    if (!body) {
      return okResponse({ success: false });
    }

    const adminId = env.ADMIN_TELEGRAM_ID ? String(env.ADMIN_TELEGRAM_ID) : '';

    const message = body.message;
    if (message && String(message.chat.id) === adminId) {
      const text = message.text || '';

      if (text === '/stats') {
        const [tools, blogs, prompts, today] = await Promise.all([
          env.DB.prepare(`SELECT COUNT(*) as c FROM tools WHERE status = 'published'`).first(),
          env.DB.prepare(`SELECT COUNT(*) as c FROM blogs WHERE status = 'published'`).first(),
          env.DB.prepare(`SELECT COUNT(*) as c FROM prompts WHERE status = 'published'`).first(),
          env.DB.prepare(`SELECT COUNT(*) as c FROM tools WHERE created_at > date('now')`).first()
        ]);
        const statsText = `📊 <b>Directory Stats</b>\n\n🔧 Tools: ${tools ? tools.c : 0}\n📝 Blogs: ${blogs ? blogs.c : 0}\n🎨 Prompts: ${prompts ? prompts.c : 0}\n🆕 Today: ${today ? today.c : 0}`;
        await sendTelegramMessage(env.TELEGRAM_BOT_TOKEN, adminId, statsText);
      }

      if (text === '/pending') {
        const [blogs, prompts, tools] = await Promise.all([
          env.DB.prepare(`SELECT COUNT(*) as c FROM blogs WHERE status = 'pending'`).first(),
          env.DB.prepare(`SELECT COUNT(*) as c FROM prompts WHERE status = 'pending'`).first(),
          env.DB.prepare(`SELECT COUNT(*) as c FROM submitted_tools WHERE status = 'pending'`).first()
        ]);
        const pendingText = `⏳ <b>Pending Items</b>\n\n📝 Blogs: ${blogs ? blogs.c : 0}\n🎨 Prompts: ${prompts ? prompts.c : 0}\n🔧 Submitted tools: ${tools ? tools.c : 0}`;
        await sendTelegramMessage(env.TELEGRAM_BOT_TOKEN, adminId, pendingText);
      }

      return okResponse({ success: true });
    }

    const callbackQuery = body.callback_query;
    if (callbackQuery) {
      const from = callbackQuery.from || {};
      if (String(from.id) !== adminId) {
        return okResponse({ success: false });
      }

      const callbackId = callbackQuery.id;
      const data = callbackQuery.data || '';
      const chatId = callbackQuery.message && callbackQuery.message.chat ? String(callbackQuery.message.chat.id) : adminId;
      const messageId = callbackQuery.message && callbackQuery.message.message_id;

      await telegramCallback(env.TELEGRAM_BOT_TOKEN, callbackId);

      let resultText = '';

      // Blog callbacks
      let m = data.match(/^approve_blog_(\d+)$/);
      if (m) {
        await env.DB.prepare(
          `UPDATE blogs SET status = 'published', published_at = datetime('now') WHERE id = ?`
        ).bind(parseInt(m[1], 10)).run();
        resultText = '✅ Blog approved & published!';
      }
      m = data.match(/^reject_blog_(\d+)$/);
      if (m) {
        await env.DB.prepare(`DELETE FROM blogs WHERE id = ?`).bind(parseInt(m[1], 10)).run();
        resultText = '❌ Blog rejected & deleted.';
      }

      // Prompt callbacks
      m = data.match(/^approve_prompt_(\d+)$/);
      if (m) {
        await env.DB.prepare(
          `UPDATE prompts SET status = 'published' WHERE id = ?`
        ).bind(parseInt(m[1], 10)).run();
        resultText = '✅ Prompt approved & published!';
      }
      m = data.match(/^reject_prompt_(\d+)$/);
      if (m) {
        await env.DB.prepare(`DELETE FROM prompts WHERE id = ?`).bind(parseInt(m[1], 10)).run();
        resultText = '❌ Prompt rejected & deleted.';
      }

      // Tool submit callbacks
      m = data.match(/^approve_tool_(\d+)$/);
      if (m) {
        const submitted = await env.DB.prepare(
          `SELECT * FROM submitted_tools WHERE id = ?`
        ).bind(parseInt(m[1], 10)).first();
        if (submitted) {
          const tool = {
            name: submitted.name,
            slug: slugify(submitted.name),
            short_desc: submitted.short_desc || '',
            description: submitted.short_desc || '',
            category: submitted.category || '',
            pricing: submitted.pricing || 'free',
            url: submitted.url || ''
          };
          const addResult = await this.addTool(env, tool);
          const addData = await addResult.json();
          await env.DB.prepare(`DELETE FROM submitted_tools WHERE id = ?`).bind(submitted.id).run();
          resultText = `✅ Tool "${submitted.name}" approved (${addData.status})!`;
        } else {
          resultText = 'Tool not found.';
        }
      }
      m = data.match(/^reject_tool_(\d+)$/);
      if (m) {
        await env.DB.prepare(`DELETE FROM submitted_tools WHERE id = ?`).bind(parseInt(m[1], 10)).run();
        resultText = '❌ Tool submission rejected.';
      }

      if (messageId && resultText) {
        await telegramEditMessage(env.TELEGRAM_BOT_TOKEN, chatId, messageId, resultText);
      }

      return okResponse({ success: true });
    }

    return okResponse({ success: false });
  }
};

export default {
  async fetch(request, env, ctx) {
    return handler.fetch(request, env, ctx);
  }
};
