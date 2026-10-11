const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, X-Internal-Key',
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
  next.headers.set('Access-Control-Allow-Headers', 'Content-Type, X-Internal-Key');
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
  return Boolean(env.INTERNAL_API_KEY) && key === env.INTERNAL_API_KEY;
}

const CANONICAL_CATEGORIES = new Set([
  'Assistants & Agents', 'Coding & Dev', 'Design & Art', 'Video & Animation',
  'Voice & Sound', 'Writing & Content', 'Business & Productivity',
  'Data & Automation', 'Education & Research', 'Finance', 'Health', 'Other'
]);
const CATEGORY_ALIASES = {
  'ai assistant': 'Assistants & Agents', assistants: 'Assistants & Agents', chat: 'Assistants & Agents',
  'ai tools': 'Other', coding: 'Coding & Dev', 'open source': 'Coding & Dev',
  image: 'Design & Art', design: 'Design & Art', video: 'Video & Animation', audio: 'Voice & Sound',
  writing: 'Writing & Content', content: 'Writing & Content', business: 'Business & Productivity',
  productivity: 'Business & Productivity', marketing: 'Business & Productivity', analytics: 'Data & Automation',
  automation: 'Data & Automation', data: 'Data & Automation', education: 'Education & Research',
  research: 'Education & Research', finance: 'Finance', health: 'Health'
};
function canonicalCategory(value) {
  const raw = String(value || '').trim();
  return CANONICAL_CATEGORIES.has(raw) ? raw : (CATEGORY_ALIASES[raw.toLowerCase()] || 'Other');
}
function validToolUrl(value) {
  try {
    const u = new URL(String(value || ''));
    return u.protocol === 'https:' || u.protocol === 'http:';
  } catch (e) { return false; }
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
  const key = 'api-tools-count-v3?' + hashKey(where + '|' + JSON.stringify(binds));
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
    tools: (result.results || []).map((tool) => ({ ...tool, category: canonicalCategory(tool.category) })),
    total: await getToolsTotal(env, params),
    page: page,
    limit: limit
  };
}

// ══════════════════════════════════════════════════════════════
// ADMIN API + CRON DISPATCH (hidden dashboard backend)
// All /z9-admin/api/* routes require a valid Cloudflare Access session
// (edge-validated) or the bootstrap key (temporary, deleted after setup).
// ══════════════════════════════════════════════════════════════

// --- Cloudflare Access JWT validation ---
// The edge (Cloudflare Access) cryptographically validates the JWT before the
// request reaches the worker and sets CF-Access-Authenticated-User-Email from
// the validated session. That header cannot be forged through the edge while
// the Access application is enabled on this route (verified: unauthenticated
// requests 302 to the Access login). We check the JWT is well-formed, fresh,
// issued by a cloudflareaccess.com team, and that the edge-authenticated
// email matches the configured admin.
function validateAccessJWT(request, env) {
  const jwt = request.headers.get('Cf-Access-Jwt-Assertion');
  if (!jwt) return { ok: false, reason: 'no-jwt' };
  const parts = jwt.split('.');
  if (parts.length !== 3) return { ok: false, reason: 'malformed' };
  const b64 = (x) => atob(x.replace(/-/g, '+').replace(/_/g, '/'));
  let payload;
  try { payload = JSON.parse(b64(parts[1])); }
  catch (e) { return { ok: false, reason: 'bad-payload' }; }
  if (payload.exp && payload.exp * 1000 < Date.now())
    return { ok: false, reason: 'expired' };
  const iss = String(payload.iss || '');
  if (!/^https:\/\/[^/]+\.cloudflareaccess\.com\/?$/.test(iss))
    return { ok: false, reason: 'bad-iss' };
  const edgeEmail = request.headers.get('CF-Access-Authenticated-User-Email') || '';
  const adminEmail = env.ADMIN_EMAIL || 'radwanislam648@gmail.com';
  if (edgeEmail.toLowerCase() !== adminEmail.toLowerCase())
    return { ok: false, reason: 'email-mismatch' };
  return { ok: true, email: payload.email || edgeEmail };
}

async function requireAdmin(request, env) {
  const boot = request.headers.get('X-Bootstrap-Key');
  if (env.ADMIN_BOOTSTRAP_KEY && boot && boot === env.ADMIN_BOOTSTRAP_KEY) {
    return { ok: true, via: 'bootstrap' };
  }
  const jwt = validateAccessJWT(request, env);
  if (jwt.ok) return { ok: true, via: 'access', email: jwt.email };
  return { ok: false, reason: jwt.reason };
}

// --- GitHub workflow dispatch ---
async function dispatchGitHubWorkflow(env, ref) {
  const r = await fetch(
    'https://api.github.com/repos/ra-wan648/ai-directory-v5/actions/workflows/pipeline.yml/dispatches',
    {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + env.GH_DISPATCH_TOKEN,
        'Accept': 'application/vnd.github+json',
        'User-Agent': 'ai-directory-worker-cron',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ ref: ref || 'main' })
    });
  return { ok: r.status === 204, status: r.status };
}

async function githubRecentRuns(env, perPage) {
  const r = await fetch(
    'https://api.github.com/repos/ra-wan648/ai-directory-v5/actions/workflows/pipeline.yml/runs?per_page=' + (perPage || 5),
    { headers: { 'Authorization': 'Bearer ' + env.GH_DISPATCH_TOKEN, 'Accept': 'application/vnd.github+json', 'User-Agent': 'ai-directory-worker-cron' } });
  if (!r.ok) return [];
  const d = await r.json();
  return (d.workflow_runs || []).map((x) => ({ id: x.id, status: x.status, conclusion: x.conclusion, created_at: x.created_at, head_sha: (x.head_sha || '').slice(0, 8) }));
}

async function telegramSend(env, text) {
  if (!env.TELEGRAM_BOT_TOKEN || !env.ADMIN_TELEGRAM_ID) return false;
  const r = await fetch('https://api.telegram.org/bot' + env.TELEGRAM_BOT_TOKEN + '/sendMessage', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: env.ADMIN_TELEGRAM_ID, text: text, parse_mode: 'HTML' })
  });
  return r.ok;
}

// --- Cron handler: dispatch pipeline + watchdog ---
async function seoEnrichCron(env) {
  // Auto SEO enrichment: 15 tools per 5-min cron run until all done
  try {
    const ep = await env.DB.prepare(
      `SELECT api_key, base_url FROM manifest_endpoints WHERE enabled=1 AND (used_this_month IS NULL OR used_this_month < monthly_limit) ORDER BY id LIMIT 1`
    ).first().catch(() => null);
    if (!ep || !ep.api_key) return;
    const baseUrl = (ep.base_url || 'https://app.manifest.build/v1').replace(/\/$/, '') + '/responses';
    const tools = await env.DB.prepare(
      `SELECT id, name, url, category, pricing FROM tools WHERE status='published' AND ((faq IS NULL OR faq='') OR (seo_title IS NULL OR seo_title='')) ORDER BY id LIMIT 15`
    ).all().then(r => r.results || []).catch(() => []);
    for (const t of tools) {
      try {
        const prompt = `You are an SEO copywriter for an AI tools directory. Write SEO-friendly content.\n\nTool: ${t.name}\nURL: ${t.url || ''}\nCategory: ${t.category || 'AI tool'}\nPricing: ${t.pricing || 'unknown'}\n\nReturn ONLY valid JSON, no markdown:\n{"seo_title": "SEO title under 60 chars", "meta_description": "Compelling meta description, 150-155 chars", "description_full": "2-3 sentences", "faq": [{"q": "What is ${t.name}?", "a": "answer"}, {"q": "Is ${t.name} free?", "a": "answer"}, {"q": "Who should use ${t.name}?", "a": "answer"}, {"q": "How to get started?", "a": "answer"}]}`;
        const lr = await fetch(baseUrl, {
          method: 'POST',
          headers: { 'Authorization': 'Bearer ' + ep.api_key, 'Content-Type': 'application/json' },
          body: JSON.stringify({ model: 'auto', input: prompt, store: false }),
        });
        if (!lr.ok) continue;
        const ld = await lr.json();
        let text = '';
        const out = ld.output;
        if (Array.isArray(out)) {
          for (const item of out) {
            if (item && item.type === 'message') {
              for (const c of (item.content || [])) {
                if (c && c.type === 'output_text') text += c.text || '';
              }
            }
          }
        }
        text = text.trim().replace(/^```\w*\n?/, '').replace(/\n?```$/, '');
        const rj = JSON.parse(text);
        await env.DB.prepare(
          `UPDATE tools SET seo_title=?, description=?, description_full=?, faq=?, llm_filled=1 WHERE id=?`
        ).bind(
          String(rj.seo_title || '').slice(0, 70),
          String(rj.meta_description || '').slice(0, 160),
          String(rj.description_full || '').slice(0, 2000),
          JSON.stringify(rj.faq || []).slice(0, 8000),
          t.id
        ).run();
        // Update quota
        await env.DB.prepare(`UPDATE manifest_endpoints SET used_this_month = used_this_month + 1 WHERE api_key = ?`).bind(ep.api_key).run().catch(() => {});
      } catch (e) { /* skip */ }
    }

    // If no tools left, enrich blogs (5 per run)
    if (tools.length === 0) {
      const blogs = await env.DB.prepare(
        `SELECT id, title, excerpt FROM blogs WHERE (seo_title IS NULL OR seo_title='') ORDER BY id LIMIT 5`
      ).all().then(r => r.results || []).catch(() => []);
      for (const b of blogs) {
        try {
          const prompt = `You are an SEO copywriter. Write SEO content for this blog post.\n\nTitle: ${b.title}\nExcerpt: ${(b.excerpt || '').slice(0, 300)}\n\nReturn ONLY valid JSON: {"seo_title": "SEO title under 60 chars", "meta_description": "150-155 chars", "excerpt": "2-sentence engaging excerpt"}`;
          const lr = await fetch(baseUrl, {
            method: 'POST',
            headers: { 'Authorization': 'Bearer ' + ep.api_key, 'Content-Type': 'application/json' },
            body: JSON.stringify({ model: 'auto', input: prompt, store: false }),
          });
          if (!lr.ok) continue;
          const ld = await lr.json();
          let text = '';
          const out = ld.output;
          if (Array.isArray(out)) {
            for (const item of out) {
              if (item && item.type === 'message') {
                for (const c of (item.content || [])) {
                  if (c && c.type === 'output_text') text += c.text || '';
                }
              }
            }
          }
          text = text.trim().replace(/^```\w*\n?/, '').replace(/\n?```$/, '');
          const rj = JSON.parse(text);
          await env.DB.prepare(`UPDATE blogs SET seo_title=?, meta_description=?, excerpt=? WHERE id=?`).bind(
            String(rj.seo_title || '').slice(0, 70),
            String(rj.meta_description || '').slice(0, 160),
            String(rj.excerpt || '').slice(0, 500),
            b.id
          ).run();
          await env.DB.prepare(`UPDATE manifest_endpoints SET used_this_month = used_this_month + 1 WHERE api_key = ?`).bind(ep.api_key).run().catch(() => {});
        } catch (e) { /* skip */ }
      }
    }
  } catch (e) { /* silent */ }
}

async function handleCronTrigger(env) {
  const started = new Date().toISOString();
  try {
    await env.DB.prepare(
      `INSERT INTO pipeline_runs (started_at, status, trigger) VALUES (?, 'dispatching', 'worker-cron')`
    ).bind(started).run();
  } catch (e) {}
  const disp = await dispatchGitHubWorkflow(env, 'main');
  if (!disp.ok) {
    await telegramSend(env, '🚨 <b>Pipeline dispatch FAILED</b>\nGitHub API returned ' + disp.status + '. Check GH_DISPATCH_TOKEN permissions (needs Actions: write).');
    try {
      await env.DB.prepare(`UPDATE pipeline_runs SET status='dispatch-failed', finished_at=datetime('now') WHERE started_at=?`).bind(started).run();
    } catch (e) {}
    return;
  }
  await new Promise((r) => setTimeout(r, 120000));
  let runs = [];
  try { runs = await githubRecentRuns(env, 3); } catch (e) {}
  const fresh = runs.find((x) => Date.now() - new Date(x.created_at).getTime() < 10 * 60e3);
  if (!fresh) {
    await telegramSend(env, '⚠️ <b>Pipeline dispatched but no run started</b> within 10 min. Check: https://github.com/ra-wan648/ai-directory-v5/actions');
    try {
      await env.DB.prepare(`UPDATE pipeline_runs SET status='no-run', finished_at=datetime('now') WHERE started_at=?`).bind(started).run();
    } catch (e) {}
  } else {
    await telegramSend(env, '▶️ <b>Pipeline started</b> (run #' + fresh.id + '). Watch: https://github.com/ra-wan648/ai-directory-v5/actions');
    try {
      await env.DB.prepare(`UPDATE pipeline_runs SET status='running', finished_at=datetime('now') WHERE started_at=?`).bind(started).run();
    } catch (e) {}
  }
}

// --- Apify helpers ---
async function apifyTestToken(token) {
  const r = await fetch('https://api.apify.com/v2/users/me', {
    headers: { 'Authorization': 'Bearer ' + token }
  });
  if (!r.ok) return { ok: false, status: r.status };
  const d = await r.json();
  const u = d.data || {};
  // Also fetch credit/balance info
  let credit = null;
  try {
    const ur = await fetch('https://api.apify.com/v2/users/me/usage/monthly', {
      headers: { 'Authorization': 'Bearer ' + token }
    });
    if (ur.ok) {
      const ud = (await ur.json()).data || {};
      credit = {
        used_usd: Math.round((parseFloat(ud.totalUsageCreditsUsdAfterVolumeDiscount) || 0) * 100) / 100,
        cycle_start: ((ud.usageCycle || {}).startAt || '').slice(0, 10),
        cycle_end: ((ud.usageCycle || {}).endAt || '').slice(0, 10),
      };
    }
  } catch (e) {}
  return { ok: true, username: u.username || '', plan: (u.plan || {}).id || '', credit };
}

const APIFY_SVC_NAMES = {
  ACTOR_COMPUTE_UNITS: ['Compute units', 'CU'],
  DATA_TRANSFER_EXTERNAL_GBYTES: ['Data transfer', 'GB'],
  DATA_TRANSFER_INTERNAL_GBYTES: ['Data transfer', 'GB'],
  DATASET_READS: ['Dataset ops', ''],
  DATASET_WRITES: ['Dataset ops', ''],
  KEY_VALUE_STORE_READS: ['KV ops', ''],
  KEY_VALUE_STORE_WRITES: ['KV ops', ''],
  REQUEST_QUEUE_READS: ['Queue ops', ''],
  REQUEST_QUEUE_WRITES: ['Queue ops', ''],
};
async function apifyUsage(token) {
  try {
    const [uRes, mRes] = await Promise.all([
      fetch('https://api.apify.com/v2/users/me', { headers: { 'Authorization': 'Bearer ' + token } }),
      fetch('https://api.apify.com/v2/users/me/usage/monthly', { headers: { 'Authorization': 'Bearer ' + token } }),
    ]);
    if (!uRes.ok) return { available: false, reason: 'token-invalid' };
    const u = (await uRes.json()).data || {};
    if (!mRes.ok) return { available: false, reason: 'usage-unavailable',
      username: u.username || '', plan: (u.plan || {}).id || '' };
    const d = (await mRes.json()).data || {};
    const svc = d.monthlyServiceUsage || {};
    const byName = {};
    for (const [k, v] of Object.entries(svc)) {
      const [label, unit] = APIFY_SVC_NAMES[k] || [k, ''];
      const q = parseFloat(v.quantity) || 0;
      const usd = parseFloat(v.baseAmountUsd) || 0;
      if (!byName[label]) byName[label] = { label, unit, quantity: 0, usd: 0 };
      byName[label].quantity += q;
      byName[label].usd += usd;
    }
    const services = Object.values(byName)
      .sort((a, b) => b.usd - a.usd).slice(0, 5)
      .map((x) => ({ ...x, quantity: Math.round(x.quantity * 10) / 10, usd: Math.round(x.usd * 100) / 100 }));
    const cyc = d.usageCycle || {};
    return {
      available: true,
      username: u.username || '',
      plan: (u.plan || {}).id || '',
      cycle_start: (cyc.startAt || '').slice(0, 10),
      cycle_end: (cyc.endAt || '').slice(0, 10),
      total_usd: Math.round((parseFloat(d.totalUsageCreditsUsdAfterVolumeDiscount) || 0) * 100) / 100,
      services,
    };
  } catch (e) { return { available: false, reason: 'error' }; }
}

// --- Manifest (OpenAI-compatible LLM router) helpers ---
async function manifestTest(baseUrl, apiKey) {
  const url = String(baseUrl || '').replace(/\/$/, '') + '/responses';
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + apiKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'auto', input: 'ping', store: false, max_output_tokens: 4 })
  });
  const text = await r.text();
  return { ok: r.ok, status: r.status, sample: text.slice(0, 120) };
}

// --- Admin API router ---
async function adminApi(request, env, url, pathname, method) {
  const auth = await requireAdmin(request, env);
  if (!auth.ok) {
    return new Response(JSON.stringify({ error: 'unauthorized', reason: auth.reason }),
      { status: 401, headers: { 'Content-Type': 'application/json' } });
  }
  const sub = pathname.replace(/^\/z9-admin\/api\//, '');
  const json = (obj, status) => new Response(JSON.stringify(obj),
    { status: status || 200, headers: { 'Content-Type': 'application/json' } });
  const body = (method === 'POST' || method === 'PUT')
    ? await request.json().catch(() => ({})) : {};

  if (sub === 'apify-keys' && method === 'GET') {
    const rows = await env.DB.prepare(
      `SELECT id, slot, label, assigned_job, monthly_cap_usd, enabled, created_at, substr(token, -4) AS last4 FROM apify_keys ORDER BY slot`).all();
    return json({ keys: (rows.results || []).map((k) => ({ ...k, token: '••••••••' + (k.last4 || '') })) });
  }
  if (sub === 'apify-keys' && method === 'POST') {
    const { id, slot, label, token, assigned_job, monthly_cap_usd, enabled } = body;
    if (id) {
      // Partial update by id — token optional (keeps existing when omitted)
      const sets = [], vals = [];
      if (slot !== undefined) { sets.push('slot=?'); vals.push(parseInt(slot) || 1); }
      if (label !== undefined) { sets.push('label=?'); vals.push(String(label)); }
      if (token) { sets.push('token=?'); vals.push(String(token)); }
      if (assigned_job !== undefined) { sets.push('assigned_job=?'); vals.push(String(assigned_job)); }
      if (monthly_cap_usd !== undefined) { sets.push('monthly_cap_usd=?'); vals.push(parseFloat(monthly_cap_usd) || 0); }
      if (enabled !== undefined) { sets.push('enabled=?'); vals.push(enabled ? 1 : 0); }
      if (!sets.length) return json({ error: 'nothing to update' }, 400);
      vals.push(parseInt(id));
      await env.DB.prepare(`UPDATE apify_keys SET ${sets.join(', ')} WHERE id=?`).bind(...vals).run();
      return json({ ok: true });
    }
    if (!token) return json({ error: 'token required' }, 400);
    await env.DB.prepare(
      `INSERT INTO apify_keys (slot, label, token, assigned_job, monthly_cap_usd) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(slot) DO UPDATE SET label=excluded.label, token=excluded.token, assigned_job=excluded.assigned_job, monthly_cap_usd=excluded.monthly_cap_usd`
    ).bind(parseInt(slot) || 1, String(label || ''), String(token), String(assigned_job || 'toolify-daily'), parseFloat(monthly_cap_usd) || 5).run();
    return json({ ok: true });
  }
  // Job -> competitor mapping for the dashboard (also hardcoded in dashboard JS as fallback)
  // 3-slot plan: Slot 1 = toolify daily, Slot 2 = taaft daily, Slot 3 = long-tail weekly
  if (sub === 'competitors' && method === 'GET') {
    return json({
      'toolify-daily': ['toolify.ai'],
      'taaft-daily': ['theresanaiforthat.com'],
      'longtail-weekly': ['futurepedia.io', 'futuretools.io', 'topai.tools', 'beyondtools.io', 'toolfk.com'],
      'other': []
    });
  }
  let m = sub.match(/^apify-keys\/(\d+)\/test$/);
  if (m && method === 'POST') {
    const row = await env.DB.prepare(`SELECT token FROM apify_keys WHERE id=?`).bind(m[1]).first();
    if (!row) return json({ error: 'not found' }, 404);
    return json(await apifyTestToken(row.token));
  }
  m = sub.match(/^apify-keys\/(\d+)\/usage$/);
  if (m && method === 'GET') {
    const row = await env.DB.prepare(`SELECT token, monthly_cap_usd FROM apify_keys WHERE id=?`).bind(m[1]).first();
    if (!row) return json({ error: 'not found' }, 404);
    return json({ ...(await apifyUsage(row.token)), monthly_cap_usd: row.monthly_cap_usd });
  }
  m = sub.match(/^apify-keys\/(\d+)\/toggle$/);
  if (m && method === 'POST') {
    await env.DB.prepare(`UPDATE apify_keys SET enabled=? WHERE id=?`).bind(body.enabled ? 1 : 0, m[1]).run();
    return json({ ok: true });
  }
  m = sub.match(/^apify-keys\/(\d+)$/);
  if (m && method === 'DELETE') {
    await env.DB.prepare(`DELETE FROM apify_keys WHERE id=?`).bind(m[1]).run();
    return json({ ok: true });
  }

  if (sub === 'manifest' && method === 'GET') {
    const rows = await env.DB.prepare(
      `SELECT id, label, base_url, monthly_limit, used_this_month, reset_day, enabled, created_at, substr(api_key, -4) AS last4 FROM manifest_endpoints ORDER BY id`).all();
    return json({ endpoints: (rows.results || []).map((k) => ({ ...k, api_key: '••••••••' + (k.last4 || '') })) });
  }
  if (sub === 'manifest' && method === 'POST') {
    const { label, base_url, api_key, monthly_limit } = body;
    if (!api_key) return json({ error: 'api_key required' }, 400);
    await env.DB.prepare(
      `INSERT INTO manifest_endpoints (label, base_url, api_key, monthly_limit) VALUES (?, ?, ?, ?)`
    ).bind(String(label || ''), String(base_url || 'https://app.manifest.build/v1'), String(api_key), parseInt(monthly_limit) || 10000).run();
    return json({ ok: true });
  }
  m = sub.match(/^manifest\/(\d+)\/test$/);
  if (m && method === 'POST') {
    const row = await env.DB.prepare(`SELECT base_url, api_key FROM manifest_endpoints WHERE id=?`).bind(m[1]).first();
    if (!row) return json({ error: 'not found' }, 404);
    return json(await manifestTest(row.base_url, row.api_key));
  }
  m = sub.match(/^manifest\/(\d+)\/toggle$/);
  if (m && method === 'POST') {
    await env.DB.prepare(`UPDATE manifest_endpoints SET enabled=? WHERE id=?`).bind(body.enabled ? 1 : 0, m[1]).run();
    return json({ ok: true });
  }
  m = sub.match(/^manifest\/(\d+)$/);
  if (m && method === 'DELETE') {
    await env.DB.prepare(`DELETE FROM manifest_endpoints WHERE id=?`).bind(m[1]).run();
    return json({ ok: true });
  }

  if (sub === 'pipeline/dispatch' && method === 'POST') {
    const disp = await dispatchGitHubWorkflow(env, 'main');
    await telegramSend(env, disp.ok ? '▶️ <b>Pipeline manually dispatched</b> from admin dashboard.' : '🚨 Manual dispatch failed: ' + disp.status);
    return json(disp);
  }
  if (sub === 'pipeline/runs' && method === 'GET') {
    let dbRuns = [];
    try { dbRuns = (await env.DB.prepare(`SELECT * FROM pipeline_runs ORDER BY started_at DESC LIMIT 20`).all()).results || []; } catch (e) {}
    let ghRuns = [];
    try { ghRuns = await githubRecentRuns(env, 5); } catch (e) {}
    return json({ db_runs: dbRuns, github_runs: ghRuns });
  }

  if (sub === 'telegram/test' && method === 'POST') {
    const ok = await telegramSend(env, '✅ <b>Admin dashboard test</b> — Telegram alerts are working.');
    return json({ ok });
  }

  if (sub === 'stats' && method === 'GET') {
    // Single query instead of 3 (saves D1 reads)
    let r = { total: 0, today: 0, nofaq: 0 };
    try {
      r = await env.DB.prepare(`SELECT COUNT(*) AS total,
        SUM(CASE WHEN created_at > datetime('now', '-1 day') THEN 1 ELSE 0 END) AS today,
        SUM(CASE WHEN faq IS NULL OR faq='' THEN 1 ELSE 0 END) AS nofaq
        FROM tools WHERE status='published'`).first() || r;
    } catch (e) {}
    return json({ total_tools: r.total || 0, added_24h: r.today || 0, missing_faq: r.nofaq || 0, time: new Date().toISOString() });
  }

  if (sub === 'd1-usage' && method === 'GET') {
    // D1 usage overview: table sizes + optimization tips
    const tables = ['tools', 'blogs', 'prompts', 'apify_keys', 'manifest_endpoints', 'pipeline_runs'];
    const sizes = {};
    for (const t of tables) {
      try {
        const r = await env.DB.prepare(`SELECT COUNT(*) AS c FROM ${t}`).first();
        sizes[t] = r ? r.c : 0;
      } catch (e) { sizes[t] = -1; }
    }
  if (sub === 'seo-enrich' && method === 'POST') {
    // SEO enrichment using dashboard-managed Manifest key from D1
    const limit = Math.min(10, Math.max(1, parseInt((body.limit || 5))));
    // Get Manifest key from D1
    const ep = await env.DB.prepare(
      `SELECT api_key, base_url FROM manifest_endpoints WHERE enabled=1 AND (used_this_month IS NULL OR used_this_month < monthly_limit) ORDER BY id LIMIT 1`
    ).first().catch(() => null);
    if (!ep || !ep.api_key) return json({ ok: false, error: 'No active Manifest key in dashboard' }, 400);
    const baseUrl = (ep.base_url || 'https://app.manifest.build/v1').replace(/\/$/, '') + '/responses';
    // Get tools needing enrichment
    const tools = await env.DB.prepare(
      `SELECT id, name, slug, url, category, pricing FROM tools WHERE status='published' AND ((faq IS NULL OR faq='') OR (seo_title IS NULL OR seo_title='') OR (description_full IS NULL OR description_full='')) ORDER BY id LIMIT ?`
    ).bind(limit).all().then(r => r.results || []).catch(() => []);
    if (!tools.length) return json({ ok: true, done: 0, remaining: 0 });
    let enriched = 0;
    for (const t of tools) {
      try {
        const prompt = `You are an SEO copywriter for an AI tools directory. Write SEO-friendly content for this AI tool.\n\nTool: ${t.name}\nURL: ${t.url || ''}\nCategory: ${t.category || 'AI tool'}\nPricing: ${t.pricing || 'unknown'}\n\nReturn ONLY valid JSON, no markdown:\n{\n  "seo_title": "SEO title under 60 chars",\n  "meta_description": "Compelling meta description, 150-155 chars",\n  "description_full": "2-3 sentences describing the tool",\n  "faq": [{"q": "What is ${t.name}?", "a": "answer"}, {"q": "Is ${t.name} free?", "a": "answer"}, {"q": "Who should use ${t.name}?", "a": "answer"}, {"q": "How to get started?", "a": "answer"}]\n}`;
        const lr = await fetch(baseUrl, {
          method: 'POST',
          headers: { 'Authorization': 'Bearer ' + ep.api_key, 'Content-Type': 'application/json' },
          body: JSON.stringify({ model: 'auto', input: prompt, store: false }),
        });
        if (!lr.ok) continue;
        const ld = await lr.json();
        let text = '';
        const out = ld.output;
        if (Array.isArray(out)) {
          for (const item of out) {
            if (item && item.type === 'message') {
              for (const c of (item.content || [])) {
                if (c && c.type === 'output_text') text += c.text || '';
              }
            }
          }
        }
        text = text.trim().replace(/^```\w*\n?/, '').replace(/\n?```$/, '');
        const rj = JSON.parse(text);
        const esc1 = (x) => String(x || '').replace(/'/g, "''");
        await env.DB.prepare(
          `UPDATE tools SET seo_title=?, description=?, description_full=?, faq=?, llm_filled=1 WHERE id=?`
        ).bind(
          esc1(rj.seo_title).slice(0, 70),
          esc1(rj.meta_description).slice(0, 160),
          esc1(rj.description_full).slice(0, 2000),
          esc1(JSON.stringify(rj.faq || [])).slice(0, 8000),
          t.id
        ).run();
        enriched++;
      } catch (e) { /* skip failed */ }
    }
    // Count remaining
    const rem = await env.DB.prepare(
      `SELECT COUNT(*) AS c FROM tools WHERE status='published' AND ((faq IS NULL OR faq='') OR (seo_title IS NULL OR seo_title=''))`
    ).first().then(r => r.c || 0).catch(() => 0);
    return json({ ok: true, done: enriched, remaining: rem });
  }

    // Free tier limits: 100K reads/day, 100K writes/day, 5GB storage
    return json({
      tables: sizes,
      limits: { reads_per_day: 100000, writes_per_day: 100000, storage_gb: 5 },
      tips: [
        'Homepage uses baked sections.json (no D1 reads)',
        'Stats API uses 1 query instead of 3',
        'Pipeline batches inserts (50 per batch)',
        'Dashboard auto-refresh is 60s (not realtime)',
      ],
      time: new Date().toISOString(),
    });
  }

  if (sub === 'traffic' && method === 'GET') {
    const days = Math.min(30, Math.max(1, parseInt(url.searchParams.get('days') || '7')));
    const since = new Date(Date.now() - days * 864e5).toISOString().slice(0, 10);
    const gql = async (q) => {
      const r = await fetch('https://api.cloudflare.com/client/v4/graphql', {
        method: 'POST',
        headers: { 'Authorization': 'Bearer ' + env.CF_ANALYTICS_TOKEN, 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: q }),
      });
      return r.json();
    };
    if (!env.CF_ANALYTICS_TOKEN) return json({ enabled: false, hint: 'CF_ANALYTICS_TOKEN not set' });
    try {
      const base = `filter: {date_gt: "${since}"}`;
      const [v, p] = await Promise.all([
        gql(`{ viewer { accounts(filter: {accountTag: "${env.CF_ACCOUNT_ID || ''}"}) { rumPageloadEventsAdaptiveGroups(${base}, limit: 10000) { sum { visits } count } } } }`),
        gql(`{ viewer { accounts(filter: {accountTag: "${env.CF_ACCOUNT_ID || ''}"}) { rumPageloadEventsAdaptiveGroups(${base}, limit: 10, orderBy: [count_DESC]) { dimensions { page } count } } } }`),
      ]);
        const grp = (((v.data || {}).viewer || {}).accounts || [])[0];
        const rows = (grp || {}).rumPageloadEventsAdaptiveGroups || [];
        const pages = ((((p.data || {}).viewer || {}).accounts || [])[0] || {}).rumPageloadEventsAdaptiveGroups || [];
      let visits = 0, views = 0;
      rows.forEach((r) => { visits += (((r || {}).sum || {}).visits || 0); views += (r.count || 0); });
      return json({ enabled: true, days, visits, pageviews: views,
        top_pages: pages.map((x) => ({ page: ((x || {}).dimensions || {}).page || '', views: x.count || 0 })) });
    } catch (e) { return json({ enabled: false, hint: 'query failed' }); }
  }

  return json({ error: 'unknown admin route' }, 404);
}

// --- Dashboard HTML (Light Clean redesign; served by the worker, same origin as the API) ---
function dashboardHTML() {
  // Dashboard HTML is base64-encoded to avoid template-literal escaping issues.
  const B64 = "PCFkb2N0eXBlIGh0bWw+CjxodG1sIGxhbmc9ImVuIj4KPGhlYWQ+CjxtZXRhIGNoYXJzZXQ9InV0Zi04Ij4KPG1ldGEgbmFtZT0idmlld3BvcnQiIGNvbnRlbnQ9IndpZHRoPWRldmljZS13aWR0aCxpbml0aWFsLXNjYWxlPTEiPgo8dGl0bGU+QWRtaW4g4oCUIEFJIERpcmVjdG9yeTwvdGl0bGU+CjxzdHlsZT4KOnJvb3R7LS1iZzojZjZmN2ZiOy0tY2FyZDojZmZmOy0tbGluZTojZThlYWYxOy0taW5rOiMxYTFkMjk7LS1tdXQ6IzZiNzI4MDstLWFtOiNFODk0MEM7LS1vazojMTBiOTgxOy0tYmFkOiNlZjQ0NDQ7LS1ibDojM2I4MmY2Oy0tcHU6IzhiNWNmNn0KKntib3gtc2l6aW5nOmJvcmRlci1ib3g7bWFyZ2luOjA7cGFkZGluZzowfQpib2R5e2JhY2tncm91bmQ6dmFyKC0tYmcpO2NvbG9yOnZhcigtLWluayk7Zm9udDoxNHB4LzEuNSBzeXN0ZW0tdWksLWFwcGxlLXN5c3RlbSxzYW5zLXNlcmlmO21pbi1oZWlnaHQ6MTAwdmh9CmhlYWRlcntiYWNrZ3JvdW5kOmxpbmVhci1ncmFkaWVudCgxMzVkZWcsIzFhMWQyOSwjMmQzMTQyKTtjb2xvcjojZmZmO3BhZGRpbmc6MTRweCAyNHB4O2Rpc3BsYXk6ZmxleDtqdXN0aWZ5LWNvbnRlbnQ6c3BhY2UtYmV0d2VlbjthbGlnbi1pdGVtczpjZW50ZXI7cG9zaXRpb246c3RpY2t5O3RvcDowO3otaW5kZXg6MTB9CmhlYWRlciBoMXtmb250LXNpemU6MTdweDtmb250LXdlaWdodDo3MDB9CmhlYWRlciAucmlnaHR7ZGlzcGxheTpmbGV4O2dhcDoxMHB4O2FsaWduLWl0ZW1zOmNlbnRlcn0KLmRvdHt3aWR0aDo5cHg7aGVpZ2h0OjlweDtib3JkZXItcmFkaXVzOjUwJTtiYWNrZ3JvdW5kOnZhcigtLW9rKTtkaXNwbGF5OmlubGluZS1ibG9jazthbmltYXRpb246cHVsc2UgMnMgaW5maW5pdGV9CkBrZXlmcmFtZXMgcHVsc2V7MCUsMTAwJXtvcGFjaXR5OjF9NTAle29wYWNpdHk6LjR9fQojYmt7YmFja2dyb3VuZDojZmZmZmZmMjI7Ym9yZGVyOjFweCBzb2xpZCAjZmZmZmZmMzM7Y29sb3I6I2ZmZjtib3JkZXItcmFkaXVzOjhweDtwYWRkaW5nOjdweCAxMHB4O2ZvbnQtc2l6ZToxMnB4O3dpZHRoOjEzMHB4fQojYms6OnBsYWNlaG9sZGVye2NvbG9yOiNmZmZmZmY4OH0KI2Nsb2Nre2ZvbnQtc2l6ZToxMnB4O2NvbG9yOiNmZmZmZmZhYX0KbWFpbnttYXgtd2lkdGg6MTE1MHB4O21hcmdpbjowIGF1dG87cGFkZGluZzoyMnB4fQoudGFic3tkaXNwbGF5OmZsZXg7Z2FwOjhweDttYXJnaW4tYm90dG9tOjE4cHg7ZmxleC13cmFwOndyYXB9Ci50YWJzIGJ1dHRvbntiYWNrZ3JvdW5kOnZhcigtLWNhcmQpO2JvcmRlcjoxcHggc29saWQgdmFyKC0tbGluZSk7Ym9yZGVyLXJhZGl1czoxMHB4O3BhZGRpbmc6OXB4IDE1cHg7Zm9udC1zaXplOjEzcHg7Zm9udC13ZWlnaHQ6NjAwO2NvbG9yOnZhcigtLW11dCk7Y3Vyc29yOnBvaW50ZXI7dHJhbnNpdGlvbjphbGwgLjE1c30KLnRhYnMgYnV0dG9uOmhvdmVye2JvcmRlci1jb2xvcjp2YXIoLS1hbSk7Y29sb3I6dmFyKC0taW5rKX0KLnRhYnMgYnV0dG9uLm9ue2JhY2tncm91bmQ6dmFyKC0taW5rKTtjb2xvcjojZmZmO2JvcmRlci1jb2xvcjp2YXIoLS1pbmspfQouY2FyZHtiYWNrZ3JvdW5kOnZhcigtLWNhcmQpO2JvcmRlcjoxcHggc29saWQgdmFyKC0tbGluZSk7Ym9yZGVyLXJhZGl1czoxNHB4O3BhZGRpbmc6MjBweDttYXJnaW4tYm90dG9tOjE0cHg7YW5pbWF0aW9uOnJpc2UgLjNzIGVhc2V9CkBrZXlmcmFtZXMgcmlzZXtmcm9te29wYWNpdHk6MDt0cmFuc2Zvcm06dHJhbnNsYXRlWSg4cHgpfXRve29wYWNpdHk6MTt0cmFuc2Zvcm06bm9uZX19Ci5jYXJkIGgye2ZvbnQtc2l6ZToxNXB4O21hcmdpbi1ib3R0b206MnB4fQouc3Vie2ZvbnQtc2l6ZToxMnB4O2NvbG9yOnZhcigtLW11dCk7bWFyZ2luLWJvdHRvbToxNHB4fQoua3Bpc3tkaXNwbGF5OmdyaWQ7Z3JpZC10ZW1wbGF0ZS1jb2x1bW5zOnJlcGVhdCg0LDFmcik7Z2FwOjEycHh9CkBtZWRpYShtYXgtd2lkdGg6ODAwcHgpey5rcGlze2dyaWQtdGVtcGxhdGUtY29sdW1uczpyZXBlYXQoMiwxZnIpfX0KLmtwaXtib3JkZXItcmFkaXVzOjEycHg7cGFkZGluZzoxNnB4O2NvbG9yOiNmZmY7cG9zaXRpb246cmVsYXRpdmU7b3ZlcmZsb3c6aGlkZGVufQoua3BpIC5sYntmb250LXNpemU6MTFweDtmb250LXdlaWdodDo3MDA7bGV0dGVyLXNwYWNpbmc6LjA1ZW07dGV4dC10cmFuc2Zvcm06dXBwZXJjYXNlO29wYWNpdHk6Ljg1fQoua3BpIC52bHtmb250LXNpemU6MzBweDtmb250LXdlaWdodDo4MDA7bWFyZ2luOjRweCAwfQoua3BpIC50cntmb250LXNpemU6MTFweDtvcGFjaXR5Oi44fQouazF7YmFja2dyb3VuZDpsaW5lYXItZ3JhZGllbnQoMTM1ZGVnLCNmNTllMGIsI2Q5NzcwNil9Ci5rMntiYWNrZ3JvdW5kOmxpbmVhci1ncmFkaWVudCgxMzVkZWcsIzNiODJmNiwjMWQ0ZWQ4KX0KLmsze2JhY2tncm91bmQ6bGluZWFyLWdyYWRpZW50KDEzNWRlZywjMTBiOTgxLCMwNDc4NTcpfQouazR7YmFja2dyb3VuZDpsaW5lYXItZ3JhZGllbnQoMTM1ZGVnLCM4YjVjZjYsIzZkMjhkOSl9Ci5zbG90e2JvcmRlcjoxcHggc29saWQgdmFyKC0tbGluZSk7Ym9yZGVyLXJhZGl1czoxMnB4O3BhZGRpbmc6MTZweDttYXJnaW4tYm90dG9tOjEycHg7YmFja2dyb3VuZDojZmZmfQouc2xvdC10b3B7ZGlzcGxheTpmbGV4O2dhcDo4cHg7YWxpZ24taXRlbXM6Y2VudGVyO21hcmdpbi1ib3R0b206MTBweDtmbGV4LXdyYXA6d3JhcH0KLmJhZGdle2ZvbnQtc2l6ZToxMHB4O2ZvbnQtd2VpZ2h0OjgwMDtib3JkZXItcmFkaXVzOjk5cHg7cGFkZGluZzozcHggMTBweDtsZXR0ZXItc3BhY2luZzouMDRlbX0KLmJhZGdlLm9ue2JhY2tncm91bmQ6I2QxZmFlNTtjb2xvcjojMDQ3ODU3fQouYmFkZ2Uub2Zme2JhY2tncm91bmQ6I2ZlZTJlMjtjb2xvcjojYjkxYzFjfQouYmFkZ2Uuam9ie2JhY2tncm91bmQ6I2ZlZjNjNztjb2xvcjojOTI0MDBlfQouYmFkZ2Uucm91dGVye2JhY2tncm91bmQ6I2RiZWFmZTtjb2xvcjojMWQ0ZWQ4fQoudG9re2ZvbnQtc2l6ZToxMXB4O2NvbG9yOnZhcigtLW11dCk7Zm9udC1mYW1pbHk6bW9ub3NwYWNlO2JhY2tncm91bmQ6I2YzZjRmNjtwYWRkaW5nOjNweCA4cHg7Ym9yZGVyLXJhZGl1czo2cHh9Ci5mMntkaXNwbGF5OmdyaWQ7Z3JpZC10ZW1wbGF0ZS1jb2x1bW5zOjFmciAxZnI7Z2FwOjEwcHg7bWFyZ2luLWJvdHRvbToxMHB4fQpAbWVkaWEobWF4LXdpZHRoOjYwMHB4KXsuZjJ7Z3JpZC10ZW1wbGF0ZS1jb2x1bW5zOjFmcn19CmxhYmVse2ZvbnQtc2l6ZToxMXB4O2ZvbnQtd2VpZ2h0OjYwMDtjb2xvcjp2YXIoLS1tdXQpO2Rpc3BsYXk6YmxvY2s7bWFyZ2luLWJvdHRvbTo0cHg7dGV4dC10cmFuc2Zvcm06dXBwZXJjYXNlO2xldHRlci1zcGFjaW5nOi4wNGVtfQppbnB1dCxzZWxlY3R7d2lkdGg6MTAwJTtiYWNrZ3JvdW5kOiNmZmY7Ym9yZGVyOjFweCBzb2xpZCB2YXIoLS1saW5lKTtib3JkZXItcmFkaXVzOjhweDtwYWRkaW5nOjlweCAxMHB4O2ZvbnQtc2l6ZToxM3B4O2NvbG9yOnZhcigtLWluayl9CmlucHV0OmZvY3VzLHNlbGVjdDpmb2N1c3tvdXRsaW5lOm5vbmU7Ym9yZGVyLWNvbG9yOnZhcigtLWFtKX0KLnByb2d7aGVpZ2h0OjlweDtiYWNrZ3JvdW5kOiNmM2Y0ZjY7Ym9yZGVyLXJhZGl1czo5OXB4O292ZXJmbG93OmhpZGRlbjttYXJnaW46MTBweCAwIDZweH0KLnByb2cgaXtkaXNwbGF5OmJsb2NrO2hlaWdodDoxMDAlO2JhY2tncm91bmQ6bGluZWFyLWdyYWRpZW50KDkwZGVnLHZhcigtLW9rKSwjMzRkMzk5KTtib3JkZXItcmFkaXVzOjk5cHg7dHJhbnNpdGlvbjp3aWR0aCAuNnMgZWFzZX0KLnByb2cub3ZlciBpe2JhY2tncm91bmQ6bGluZWFyLWdyYWRpZW50KDkwZGVnLHZhcigtLWJhZCksI2Y4NzE3MSl9Ci5tZXRhe2ZvbnQtc2l6ZToxMnB4O2NvbG9yOnZhcigtLW11dCl9Ci5idG5yb3d7ZGlzcGxheTpmbGV4O2dhcDo4cHg7bWFyZ2luLXRvcDoxMnB4O2ZsZXgtd3JhcDp3cmFwfQouYnRue2JhY2tncm91bmQ6I2ZmZjtib3JkZXI6MXB4IHNvbGlkIHZhcigtLWxpbmUpO2JvcmRlci1yYWRpdXM6OHB4O3BhZGRpbmc6OHB4IDE0cHg7Zm9udC1zaXplOjEzcHg7Zm9udC13ZWlnaHQ6NjAwO2N1cnNvcjpwb2ludGVyO2NvbG9yOnZhcigtLWluayl9Ci5idG46aG92ZXJ7Ym9yZGVyLWNvbG9yOnZhcigtLWFtKX0KLmJ0bi5kYXJre2JhY2tncm91bmQ6dmFyKC0taW5rKTtjb2xvcjojZmZmO2JvcmRlci1jb2xvcjp2YXIoLS1pbmspfQouYnRuLmRhbmdlcntjb2xvcjp2YXIoLS1iYWQpO2JvcmRlci1jb2xvcjojZmVjYWNhfQouYnRuLmRhbmdlcjpob3Zlcntib3JkZXItY29sb3I6dmFyKC0tYmFkKX0KLmhpbnR7YmFja2dyb3VuZDojZmZmYmViO2JvcmRlcjoxcHggc29saWQgI2ZkZTY4YTtib3JkZXItcmFkaXVzOjEwcHg7cGFkZGluZzoxMnB4IDE0cHg7Zm9udC1zaXplOjEzcHg7bWFyZ2luLWJvdHRvbToxMnB4fQoud2FybmJveHtiYWNrZ3JvdW5kOiNmZWYyZjI7Ym9yZGVyOjFweCBzb2xpZCAjZmVjYWNhO2JvcmRlci1yYWRpdXM6MTBweDtwYWRkaW5nOjEycHggMTRweDtmb250LXNpemU6MTNweDttYXJnaW46MTBweCAwO2Rpc3BsYXk6YmxvY2t9Ci50aW1lbGluZXtwb3NpdGlvbjpyZWxhdGl2ZTtwYWRkaW5nLWxlZnQ6MjJweH0KLnRpbWVsaW5lOjpiZWZvcmV7Y29udGVudDoiIjtwb3NpdGlvbjphYnNvbHV0ZTtsZWZ0OjdweDt0b3A6NnB4O2JvdHRvbTo2cHg7d2lkdGg6MnB4O2JhY2tncm91bmQ6dmFyKC0tbGluZSl9Ci50bC1pdGVte3Bvc2l0aW9uOnJlbGF0aXZlO3BhZGRpbmc6OHB4IDAgOHB4IDhweH0KLnRsLWl0ZW06OmJlZm9yZXtjb250ZW50OiIiO3Bvc2l0aW9uOmFic29sdXRlO2xlZnQ6LTE5cHg7dG9wOjEzcHg7d2lkdGg6MTBweDtoZWlnaHQ6MTBweDtib3JkZXItcmFkaXVzOjUwJTtiYWNrZ3JvdW5kOnZhcigtLW11dCl9Ci50bC1pdGVtLm9rOjpiZWZvcmV7YmFja2dyb3VuZDp2YXIoLS1vayl9Ci50bC1pdGVtLmJhZDo6YmVmb3Jle2JhY2tncm91bmQ6dmFyKC0tYmFkKX0KLnRsLWl0ZW0ucnVuOjpiZWZvcmV7YmFja2dyb3VuZDp2YXIoLS1hbSk7YW5pbWF0aW9uOnB1bHNlIDEuNXMgaW5maW5pdGV9Ci5zcGFya3tkaXNwbGF5OmZsZXg7YWxpZ24taXRlbXM6ZmxleC1lbmQ7Z2FwOjNweDtoZWlnaHQ6OTBweDttYXJnaW46MTRweCAwfQouc3BhcmsgaXtmbGV4OjE7YmFja2dyb3VuZDpsaW5lYXItZ3JhZGllbnQoMTgwZGVnLHZhcigtLWFtKSwjZmJiZjI0KTtib3JkZXItcmFkaXVzOjNweCAzcHggMCAwO21pbi1oZWlnaHQ6NnB4fQouYWN0c3tkaXNwbGF5OmdyaWQ7Z3JpZC10ZW1wbGF0ZS1jb2x1bW5zOnJlcGVhdCgyLDFmcik7Z2FwOjEycHh9CkBtZWRpYShtYXgtd2lkdGg6NjAwcHgpey5hY3Rze2dyaWQtdGVtcGxhdGUtY29sdW1uczoxZnJ9fQouYWN0e2JvcmRlcjoxcHggc29saWQgdmFyKC0tbGluZSk7Ym9yZGVyLXJhZGl1czoxMnB4O3BhZGRpbmc6MTZweDtjdXJzb3I6cG9pbnRlcjt0cmFuc2l0aW9uOmFsbCAuMTVzO2JhY2tncm91bmQ6I2ZmZn0KLmFjdDpob3Zlcntib3JkZXItY29sb3I6dmFyKC0tYW0pO3RyYW5zZm9ybTp0cmFuc2xhdGVZKC0ycHgpO2JveC1zaGFkb3c6MCA0cHggMTRweCAjMDAwMX0KLmFjdCAuZXtmb250LXNpemU6MjRweDttYXJnaW4tYm90dG9tOjZweH0KLmFjdCBie2Rpc3BsYXk6YmxvY2s7Zm9udC1zaXplOjE0cHg7bWFyZ2luLWJvdHRvbToycHh9Ci5hY3Qgc3Bhbntmb250LXNpemU6MTJweDtjb2xvcjp2YXIoLS1tdXQpfQojbG9ne2JhY2tncm91bmQ6IzFhMWQyOTtjb2xvcjojYTdmM2QwO2JvcmRlci1yYWRpdXM6MTJweDtwYWRkaW5nOjE0cHg7Zm9udC1mYW1pbHk6bW9ub3NwYWNlO2ZvbnQtc2l6ZToxMnB4O3doaXRlLXNwYWNlOnByZS13cmFwO21heC1oZWlnaHQ6MjIwcHg7b3ZlcmZsb3c6YXV0b30KPC9zdHlsZT4KPC9oZWFkPgo8Ym9keT4KPGhlYWRlcj4KPGgxPjxzcGFuIGNsYXNzPSJkb3QiPjwvc3Bhbj4gQUkgRGlyZWN0b3J5IOKAlCBBZG1pbjwvaDE+CjxkaXYgY2xhc3M9InJpZ2h0Ij4KPHNwYW4gaWQ9ImNsb2NrIj48L3NwYW4+CjwvZGl2Pgo8L2hlYWRlcj4KPG1haW4+CjxkaXYgY2xhc3M9InRhYnMiIGlkPSJ0YWJzIj48L2Rpdj4KPGRpdiBpZD0idmlldyI+PC9kaXY+CjxkaXYgY2xhc3M9ImNhcmQiPjxoMj7wn5OLIExvZzwvaDI+PGRpdiBjbGFzcz0ic3ViIj5SZWNlbnQgYWN0aW9uczwvZGl2PjxkaXYgaWQ9ImxvZyI+PC9kaXY+PC9kaXY+CjwvbWFpbj4KPHNjcmlwdD4KInVzZSBzdHJpY3QiOwpjb25zdCBWID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoInZpZXciKTsKY29uc3QgVEFCUyA9IFtbIm92ZXJ2aWV3Iiwi8J+TiiBPdmVydmlldyJdLFsiYXBpZnkiLCLwn5SRIEFwaWZ5IGtleXMiXSxbIm1hbmlmZXN0Iiwi8J+kliBNYW5pZmVzdCJdLFsicnVucyIsIvCflIQgUGlwZWxpbmUgcnVucyJdLFsidHJhZmZpYyIsIvCfk4ggVHJhZmZpYyJdLFsiYWN0aW9ucyIsIuKame+4jyBBY3Rpb25zIl1dOwpjb25zdCBKT0JfU0lURVMgPSB7InRvb2xpZnktZGFpbHkiOlsidG9vbGlmeS5haSJdLCJ0YWFmdC1kYWlseSI6WyJ0aGVyZXNhbmFpZm9ydGhhdC5jb20iXSwibG9uZ3RhaWwtd2Vla2x5IjpbImZ1dHVyZXBlZGlhLmlvIiwiZnV0dXJldG9vbHMuaW8iLCJ0b3BhaS50b29scyIsImJleW9uZHRvb2xzLmlvIiwidG9vbGZrLmNvbSJdLCJvdGhlciI6W119Owpjb25zdCBKT0JTID0gWyJ0b29saWZ5LWRhaWx5IiwidGFhZnQtZGFpbHkiLCJsb25ndGFpbC13ZWVrbHkiLCJvdGhlciJdOwpjb25zdCBTTE9UX0pPQlMgPSB7MToidG9vbGlmeS1kYWlseSIsMjoidGFhZnQtZGFpbHkiLDM6Imxvbmd0YWlsLXdlZWtseSJ9OwoKZnVuY3Rpb24gZXNjKHMpe3JldHVybiBTdHJpbmcocz09bnVsbD8iIjpzKS5yZXBsYWNlKC9bJjw+IiddL2csZnVuY3Rpb24oYyl7cmV0dXJuIHsiJiI6IiZhbXA7IiwiPCI6IiZsdDsiLCI+IjoiJmd0OyIsJyInOiImcXVvdDsiLCInIjoiJiMzOTsifVtjXTt9KTt9CmZ1bmN0aW9uIGxvZyhtKXt2YXIgZWw9ZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoImxvZyIpO3ZhciB0PW5ldyBEYXRlKCkudG9Mb2NhbGVUaW1lU3RyaW5nKCk7ZWwudGV4dENvbnRlbnQ9IlsiK3QrIl0gIittKyJcbiIrZWwudGV4dENvbnRlbnQ7fQpmdW5jdGlvbiBjb3VudFVwKGVsLHRvKXtpZighZWwpcmV0dXJuO3ZhciBmcm9tPTA7dmFyIHN0PW51bGw7ZnVuY3Rpb24gZih0cyl7aWYoIXN0KXN0PXRzO3ZhciBwPU1hdGgubWluKDEsKHRzLXN0KS85MDApO2VsLnRleHRDb250ZW50PU1hdGgucm91bmQoZnJvbSsodG8tZnJvbSkqcCkudG9Mb2NhbGVTdHJpbmcoKTtpZihwPDEpcmVxdWVzdEFuaW1hdGlvbkZyYW1lKGYpO31yZXF1ZXN0QW5pbWF0aW9uRnJhbWUoZik7fQpmdW5jdGlvbiB0aW1lQWdvKHMpe2lmKCFzKXJldHVybiLigJQiO3ZhciBkPShEYXRlLm5vdygpLW5ldyBEYXRlKHMpLmdldFRpbWUoKSkvMWUzO2lmKGQ8NjApcmV0dXJuImp1c3Qgbm93IjtpZihkPDM2MDApcmV0dXJuIE1hdGguZmxvb3IoZC82MCkrIm0gYWdvIjtpZihkPDg2NDAwKXJldHVybiBNYXRoLmZsb29yKGQvMzYwMCkrImggYWdvIjtyZXR1cm4gTWF0aC5mbG9vcihkLzg2NDAwKSsiZCBhZ28iO30KYXN5bmMgZnVuY3Rpb24gYXBpKHBhdGgsb3B0cyl7CiAgb3B0cz1vcHRzfHx7fTsKICB2YXIgaGVhZGVycz17IkNvbnRlbnQtVHlwZSI6ImFwcGxpY2F0aW9uL2pzb24ifTsKICB2YXIgYms9ZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoImJrIikudmFsdWV8fGxvY2FsU3RvcmFnZS5nZXRJdGVtKCJ6OV9ia2V5Iil8fCIiOwogIGlmKGJrKWhlYWRlcnNbIlgtU2V0dXAtS2V5Il09Yms7CiAgdmFyIHI9YXdhaXQgZmV0Y2goIi96OS1hZG1pbi9hcGkvIitwYXRoLE9iamVjdC5hc3NpZ24oe2hlYWRlcnM6aGVhZGVyc30sb3B0cykpOwogIGlmKCFyLm9rKXRocm93IG5ldyBFcnJvcigiQVBJICIrci5zdGF0dXMpOwogIHJldHVybiByLmpzb24oKTsKfQoKdmFyIHZpZXdzPXsKYXN5bmMgb3ZlcnZpZXcoKXsKICBWLmlubmVySFRNTD0nPGRpdiBjbGFzcz0iY2FyZCI+PGgyPkF0IGEgZ2xhbmNlPC9oMj48ZGl2IGNsYXNzPSJzdWIiPkxpdmUgZGF0YSDCtyBhdXRvLXJlZnJlc2hlcyBldmVyeSA2MHM8L2Rpdj48ZGl2IGNsYXNzPSJrcGlzIj4nCiAgKyc8ZGl2IGNsYXNzPSJrcGkgazEiPjxkaXYgY2xhc3M9ImxiIj5BSSB0b29scyBpbmRleGVkPC9kaXY+PGRpdiBjbGFzcz0idmwiIGlkPSJrcGktdG9vbHMiPuKApjwvZGl2PjxkaXYgY2xhc3M9InRyIiBpZD0ia3BpLXRvb2xzLXRyIj48L2Rpdj48L2Rpdj4nCiAgKyc8ZGl2IGNsYXNzPSJrcGkgazIiPjxkaXYgY2xhc3M9ImxiIj5GcmVlIGJyb3dzZXIgdG9vbHM8L2Rpdj48ZGl2IGNsYXNzPSJ2bCIgaWQ9ImtwaS1mcmVlIj7igKY8L2Rpdj48ZGl2IGNsYXNzPSJ0ciI+4payIDExOSBhZGRlZCBPY3QgMjAyNjwvZGl2PjwvZGl2PicKICArJzxkaXYgY2xhc3M9ImtwaSBrMyI+PGRpdiBjbGFzcz0ibGIiPlZpc2l0b3JzICg3ZCk8L2Rpdj48ZGl2IGNsYXNzPSJ2bCIgaWQ9ImtwaS12aXMiPuKApjwvZGl2PjxkaXYgY2xhc3M9InRyIiBpZD0ia3BpLXZpcy10ciI+PC9kaXY+PC9kaXY+JwogICsnPGRpdiBjbGFzcz0ia3BpIGs0Ij48ZGl2IGNsYXNzPSJsYiI+QXBpZnkgc3BlbmQgKG1vKTwvZGl2PjxkaXYgY2xhc3M9InZsIiBpZD0ia3BpLXNwZW5kIj7igKY8L2Rpdj48ZGl2IGNsYXNzPSJ0ciIgaWQ9ImtwaS1zcGVuZC10ciI+PC9kaXY+PC9kaXY+JwogICsnPC9kaXY+PC9kaXY+JwogICsnPGRpdiBjbGFzcz0iY2FyZCI+PGgyPvCfl4TvuI8gRDEgRGF0YWJhc2U8L2gyPjxkaXYgY2xhc3M9InN1YiI+VXNhZ2UgJmFtcDsgb3B0aW1pemF0aW9uPC9kaXY+PGRpdiBpZD0iZDEtaW5mbyI+PGRpdiBjbGFzcz0ibWV0YSI+bG9hZGluZ+KApjwvZGl2PjwvZGl2PjwvZGl2PicKICArJzxkaXYgY2xhc3M9ImNhcmQiPjxoMj5QaXBlbGluZSB0aW1lbGluZTwvaDI+PGRpdiBjbGFzcz0ic3ViIj5SZWNlbnQgcnVuczwvZGl2PjxkaXYgY2xhc3M9InRpbWVsaW5lIiBpZD0ib3YtdGltZWxpbmUiPjxkaXYgY2xhc3M9Im1ldGEiPmxvYWRpbmfigKY8L2Rpdj48L2Rpdj48L2Rpdj4nOwogIHRyeXsKICAgIHZhciBzdGF0cz1hd2FpdCBhcGkoInN0YXRzIikuY2F0Y2goZnVuY3Rpb24oKXtyZXR1cm4gbnVsbDt9KTsKICAgIHZhciBydW5zPWF3YWl0IGFwaSgicGlwZWxpbmUvcnVucyIpLmNhdGNoKGZ1bmN0aW9uKCl7cmV0dXJuIG51bGw7fSk7CiAgICB2YXIgdHJhZmZpYz1udWxsO3RyeXt0cmFmZmljPWF3YWl0IGFwaSgidHJhZmZpYz9kYXlzPTciKTt9Y2F0Y2goZSl7fQogICAgaWYoc3RhdHMpe2NvdW50VXAoZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoImtwaS10b29scyIpLHN0YXRzLnRvdGFsX3Rvb2xzfHwwKTtkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgia3BpLXRvb2xzLXRyIikudGV4dENvbnRlbnQ9IuKWsiAiKyhzdGF0cy5hZGRlZF8yNGh8fDApKyIgaW4gbGFzdCAyNGgiO30KICAgIGNvdW50VXAoZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoImtwaS1mcmVlIiksMjIxKTsKICAgIGlmKHRyYWZmaWMmJnRyYWZmaWMuZW5hYmxlZCl7Y291bnRVcChkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgia3BpLXZpcyIpLHRyYWZmaWMudmlzaXRzfHwwKTtkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgia3BpLXZpcy10ciIpLnRleHRDb250ZW50PSh0cmFmZmljLnBhZ2V2aWV3c3x8MCkudG9Mb2NhbGVTdHJpbmcoKSsiIHBhZ2V2aWV3cyI7fQogICAgZWxzZXtkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgia3BpLXZpcyIpLnRleHRDb250ZW50PSLigJQiO2RvY3VtZW50LmdldEVsZW1lbnRCeUlkKCJrcGktdmlzLXRyIikudGV4dENvbnRlbnQ9IldlYiBBbmFseXRpY3Mgbm90IGVuYWJsZWQiO30KICAgIHRyeXsKICAgICAgdmFyIGtkPWF3YWl0IGFwaSgiYXBpZnkta2V5cyIpO3ZhciB0dT0wLHRjPTAsYWM9MDsKICAgICAgZm9yKHZhciBpPTA7aTwoa2Qua2V5c3x8W10pLmxlbmd0aDtpKyspe3ZhciBrPWtkLmtleXNbaV07aWYoIWsuZW5hYmxlZCljb250aW51ZTt0cnl7dmFyIHU9YXdhaXQgYXBpKCJhcGlmeS1rZXlzLyIray5pZCsiL3VzYWdlIik7dHUrPXUudXNlZF91c2R8fDA7dGMrPWsubW9udGhseV9jYXBfdXNkfHw1O2FjKys7fWNhdGNoKGUpe319CiAgICAgIGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCJrcGktc3BlbmQiKS50ZXh0Q29udGVudD0iJCIrdHUudG9GaXhlZCgyKTsKICAgICAgZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoImtwaS1zcGVuZC10ciIpLnRleHRDb250ZW50PSJvZiAkIit0Yy50b0ZpeGVkKDApKyIgY2FwIMK3ICIrYWMrIiBrZXlzIjsKICAgIH1jYXRjaChlKXtkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgia3BpLXNwZW5kIikudGV4dENvbnRlbnQ9IuKAlCI7fQogICAgdHJ5ewogICAgICB2YXIgZDE9YXdhaXQgYXBpKCJkMS11c2FnZSIpO3ZhciB0PWQxLnRhYmxlc3x8e307CiAgICAgIHZhciBuYW1lcz17dG9vbHM6IkFJIHRvb2xzIixibG9nczoiQmxvZyBwb3N0cyIscHJvbXB0czoiUHJvbXB0cyIsYXBpZnlfa2V5czoiQXBpZnkga2V5cyIsbWFuaWZlc3RfZW5kcG9pbnRzOiJNYW5pZmVzdCBlbmRwb2ludHMiLHBpcGVsaW5lX3J1bnM6IlBpcGVsaW5lIHJ1bnMifTsKICAgICAgdmFyIGg9JzxkaXYgY2xhc3M9Indhcm5ib3giPvCfk4ogPGI+VGFibGUgcm93IGNvdW50czwvYj4gKGJlbG93KSDiiaAgQ2xvdWRmbGFyZSBxdW90YSB1c2FnZS4gUmVhbCBEMSBtZXRyaWNzIChyZWFkcy93cml0ZXMvc3RvcmFnZSkgYXJlIGluIDxhIGhyZWY9Imh0dHBzOi8vZGFzaC5jbG91ZGZsYXJlLmNvbSIgdGFyZ2V0PSJfYmxhbmsiPkNsb3VkZmxhcmUgRGFzaGJvYXJkIOKGkiBEMTwvYT4uPC9kaXY+JzsKICAgICAgaCs9JzxkaXYgY2xhc3M9ImYyIiBzdHlsZT0iZ3JpZC10ZW1wbGF0ZS1jb2x1bW5zOnJlcGVhdCgzLDFmcik7bWFyZ2luLXRvcDoxMHB4Ij4nOwogICAgICBmb3IodmFyIGtrIGluIG5hbWVzKXtpZih0W2trXT49MCloKz0nPGRpdj48ZGl2IGNsYXNzPSJsYiI+JytuYW1lc1tra10rJzwvZGl2PjxkaXYgY2xhc3M9InZsIiBzdHlsZT0iZm9udC1zaXplOjIwcHg7Y29sb3I6dmFyKC0taW5rKSI+Jyt0W2trXS50b0xvY2FsZVN0cmluZygpKyc8L2Rpdj48ZGl2IGNsYXNzPSJtZXRhIj5yb3dzPC9kaXY+PC9kaXY+Jzt9CiAgICAgIGgrPSc8L2Rpdj48ZGl2IGNsYXNzPSJoaW50IiBzdHlsZT0ibWFyZ2luLXRvcDoxMnB4Ij7wn5KhIDxiPlNhdmluZyBEMSByZWFkczo8L2I+PGJyPuKAoiAnKyhkMS50aXBzfHxbXSkuam9pbignPGJyPuKAoiAnKSsnPC9kaXY+JzsKICAgICAgaCs9JzxkaXYgY2xhc3M9Im1ldGEiIHN0eWxlPSJtYXJnaW4tdG9wOjhweCI+RnJlZSB0aWVyOiAxMDBLIHJlYWRzL2RheSDCtyAxMDBLIHdyaXRlcy9kYXkgwrcgNUdCIHN0b3JhZ2UgwrcgPGEgaHJlZj0iaHR0cHM6Ly9kYXNoLmNsb3VkZmxhcmUuY29tIiB0YXJnZXQ9Il9ibGFuayI+VmlldyByZWFsIHVzYWdlIOKGkjwvYT48L2Rpdj4nOwogICAgICBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgiZDEtaW5mbyIpLmlubmVySFRNTD1oOwogICAgfWNhdGNoKGUpe2RvY3VtZW50LmdldEVsZW1lbnRCeUlkKCJkMS1pbmZvIikuaW5uZXJIVE1MPSc8ZGl2IGNsYXNzPSJtZXRhIj5GYWlsZWQgdG8gbG9hZCBEMSBpbmZvLjwvZGl2Pic7fQogICAgaWYocnVucyl7CiAgICAgIHZhciBnaD1ydW5zLmdpdGh1Yl9ydW5zfHxbXTt2YXIgaDI9IiI7CiAgICAgIGdoLnNsaWNlKDAsNCkuZm9yRWFjaChmdW5jdGlvbihyKXt2YXIgb2s9ci5jb25jbHVzaW9uPT09InN1Y2Nlc3MiO3ZhciBydW49ci5zdGF0dXMhPT0iY29tcGxldGVkIjtoMis9JzxkaXYgY2xhc3M9InRsLWl0ZW0gJysob2s/Im9rIjpydW4/InJ1biI6ImJhZCIpKyciPjxiPiMnK3IuaWQrJzwvYj4gJysoci5jb25jbHVzaW9ufHxyLnN0YXR1c3x8InVua25vd24iKSsnIMK3IDxzcGFuIGNsYXNzPSJtZXRhIj4nK2VzYyhTdHJpbmcoci5oZWFkX3NoYXx8IiIpLnNsaWNlKDAsNykpKycgwrcgJyt0aW1lQWdvKHIuY3JlYXRlZF9hdCkrJzwvc3Bhbj48L2Rpdj4nO30pOwogICAgICBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgib3YtdGltZWxpbmUiKS5pbm5lckhUTUw9aDJ8fCc8ZGl2IGNsYXNzPSJtZXRhIj5ObyBydW5zIHlldC48L2Rpdj4nOwogICAgfQogIH1jYXRjaChlKXtsb2coIk92ZXJ2aWV3IGxvYWQgZmFpbGVkOiAiK2UubWVzc2FnZSk7fQp9LAoKYXN5bmMgYXBpZnkoKXsKICB2YXIgZD1hd2FpdCBhcGkoImFwaWZ5LWtleXMiKTsKICB2YXIgY29tcD1KT0JfU0lURVM7CiAgdHJ5e3ZhciBjPWF3YWl0IGFwaSgiY29tcGV0aXRvcnMiKTtpZihjJiZ0eXBlb2YgYz09PSJvYmplY3QiKWNvbXA9Yzt9Y2F0Y2goZSl7fQogIGZvcih2YXIgayBpbiBjb21wKXtKT0JfU0lURVNba109Y29tcFtrXTt9CiAgZnVuY3Rpb24gam9iT3B0cyhzZWwpe3JldHVybiBKT0JTLm1hcChmdW5jdGlvbihqKXtyZXR1cm4gJzxvcHRpb24gdmFsdWU9IicraisnIicrKHNlbD09PWo/IiBzZWxlY3RlZCI6IiIpKyc+JytqKyc8L29wdGlvbj4nO30pLmpvaW4oIiIpO30KICBmdW5jdGlvbiBzaXRlc0Zvcihqb2Ipe3JldHVybiAoY29tcFtqb2JdfHxbXSkuam9pbigiLCAiKXx8IuKAlCI7fQogIHZhciBieVNsb3Q9e307KGQua2V5c3x8W10pLmZvckVhY2goZnVuY3Rpb24oayl7YnlTbG90W2suc2xvdF09azt9KTsKICB2YXIgaD0nPGRpdiBjbGFzcz0iY2FyZCI+PGgyPvCflJEgQXBpZnkga2V5czwvaDI+PGRpdiBjbGFzcz0ic3ViIj5TbG90IE4g4oaSIEdpdEh1YiBTZWNyZXQgQVBJRllfS0VZX04gwrcgdXNhZ2UgYXV0by1sb2FkcyDCtyA8YnV0dG9uIGNsYXNzPSJidG4iIG9uY2xpY2s9ImFkZEFwaWZ5U2xvdCgpIj4rIEFkZCBuZXcgc2xvdDwvYnV0dG9uPjwvZGl2Pic7CiAgdmFyIG1heFNsb3Q9MzsKICAoZC5rZXlzfHxbXSkuZm9yRWFjaChmdW5jdGlvbihrKXtpZihrLnNsb3Q+bWF4U2xvdCltYXhTbG90PWsuc2xvdDt9KTsKICBpZih0eXBlb2Ygd2luZG93Ll9hcGlmeUV4dHJhU2xvdHM9PT0idW5kZWZpbmVkIil3aW5kb3cuX2FwaWZ5RXh0cmFTbG90cz0wOwogIHZhciB0b3RhbFNsb3RzPW1heFNsb3Qrd2luZG93Ll9hcGlmeUV4dHJhU2xvdHM7CiAgZm9yKHZhciBzPTE7czw9dG90YWxTbG90cztzKyspewogICAgdmFyIGtleT1ieVNsb3Rbc107dmFyIGpvYj1rZXk/a2V5LmFzc2lnbmVkX2pvYjooU0xPVF9KT0JTW3NdfHwib3RoZXIiKTsKICAgIGgrPSc8ZGl2IGNsYXNzPSJzbG90Ij48ZGl2IGNsYXNzPSJzbG90LXRvcCI+PGI+U2xvdCAnK3MrJzwvYj4nOwogICAgaWYoa2V5KXtoKz0nPHNwYW4gY2xhc3M9ImJhZGdlICcrKGtleS5lbmFibGVkPyJvbiI6Im9mZiIpKyciPicrKGtleS5lbmFibGVkPyJBQ1RJVkUiOiJESVNBQkxFRCIpKyc8L3NwYW4+Jzt9CiAgICBlbHNle2grPSc8c3BhbiBjbGFzcz0iYmFkZ2Ugb2ZmIj5FTVBUWTwvc3Bhbj4nO30KICAgIGgrPSc8c3BhbiBjbGFzcz0iYmFkZ2Ugam9iIj4nK2VzYyhqb2IpKyc8L3NwYW4+PHNwYW4gY2xhc3M9Im1ldGEiPuKGkiAnK2VzYyhzaXRlc0Zvcihqb2IpKSsnPC9zcGFuPjwvZGl2Pic7CiAgICBpZihrZXkpewogICAgICBoKz0nPGRpdiBjbGFzcz0iZjIiPjxkaXY+PGxhYmVsPkxhYmVsPC9sYWJlbD48aW5wdXQgaWQ9ImFrLWxhYmVsLScra2V5LmlkKyciIHZhbHVlPSInK2VzYyhrZXkubGFiZWx8fCIiKSsnIj48L2Rpdj4nCiAgICAgICsnPGRpdj48bGFiZWw+QXNzaWduZWQgam9iPC9sYWJlbD48c2VsZWN0IGlkPSJhay1qb2ItJytrZXkuaWQrJyI+Jytqb2JPcHRzKGtleS5hc3NpZ25lZF9qb2IpKyc8L3NlbGVjdD48L2Rpdj4nCiAgICAgICsnPGRpdj48bGFiZWw+TW9udGhseSBjYXAgKFVTRCk8L2xhYmVsPjxpbnB1dCBpZD0iYWstY2FwLScra2V5LmlkKyciIHR5cGU9Im51bWJlciIgc3RlcD0iMC41IiB2YWx1ZT0iJysoa2V5Lm1vbnRobHlfY2FwX3VzZHx8NSkrJyI+PC9kaXY+JwogICAgICArJzxkaXY+PGxhYmVsPlRva2VuPC9sYWJlbD48aW5wdXQgaWQ9ImFrLXRva2VuLScra2V5LmlkKyciIHR5cGU9InBhc3N3b3JkIiBwbGFjZWhvbGRlcj0i4oCi4oCi4oCi4oCi4oCi4oCi4oCi4oCiJytlc2MoKGtleS50b2tlbnx8IiIpLnNsaWNlKC00KSkrJyI+PC9kaXY+PC9kaXY+JwogICAgICArJzxkaXYgY2xhc3M9Im1ldGEiPlRva2VuOiA8c3BhbiBjbGFzcz0idG9rIj4nK2VzYyhrZXkudG9rZW58fCIiKSsnPC9zcGFuPiDCtyBEMSBTbG90ICcra2V5LnNsb3QrJyDihpIgQVBJRllfS0VZXycra2V5LnNsb3QrJzwvZGl2PicKICAgICAgKyc8ZGl2IGlkPSJ1c2FnZS0nK2tleS5pZCsnIj48ZGl2IGNsYXNzPSJtZXRhIj5sb2FkaW5nIHVzYWdl4oCmPC9kaXY+PC9kaXY+JwogICAgICArJzxkaXYgY2xhc3M9ImJ0bnJvdyI+PGJ1dHRvbiBjbGFzcz0iYnRuIGRhcmsiIGRhdGEtYWN0PSJzYXZlIiBkYXRhLWlkPSInK2tleS5pZCsnIj5TYXZlPC9idXR0b24+JwogICAgICArJzxidXR0b24gY2xhc3M9ImJ0biIgZGF0YS1hY3Q9InRlc3QiIGRhdGEtaWQ9Iicra2V5LmlkKyciPlRlc3Q8L2J1dHRvbj4nCiAgICAgICsnPGJ1dHRvbiBjbGFzcz0iYnRuIiBkYXRhLWFjdD0idG9nZ2xlIiBkYXRhLWlkPSInK2tleS5pZCsnIj4nKyhrZXkuZW5hYmxlZD8iRGlzYWJsZSI6IkVuYWJsZSIpKyc8L2J1dHRvbj4nCiAgICAgICsnPGJ1dHRvbiBjbGFzcz0iYnRuIGRhbmdlciIgZGF0YS1hY3Q9ImRlbCIgZGF0YS1pZD0iJytrZXkuaWQrJyI+UmVtb3ZlPC9idXR0b24+PC9kaXY+JzsKICAgIH1lbHNlewogICAgICBoKz0nPGRpdiBjbGFzcz0iaGludCI+4p6VIDxiPkVtcHR5IHNsb3Q8L2I+IOKAlCBwYXN0ZSBhbiBBcGlmeSBBUEkga2V5IHRvIGFjdGl2YXRlIDxiPicrZXNjKGpvYikrJzwvYj4gKCcrZXNjKHNpdGVzRm9yKGpvYikpKycpLjwvZGl2PicKICAgICAgKyc8ZGl2IGNsYXNzPSJmMiI+PGRpdj48bGFiZWw+TGFiZWw8L2xhYmVsPjxpbnB1dCBpZD0ibmstbGFiZWwtJytzKyciIHBsYWNlaG9sZGVyPSJlLmcuIHRhYWZ0IGtleSI+PC9kaXY+JwogICAgICArJzxkaXY+PGxhYmVsPkFQSSBLZXk8L2xhYmVsPjxpbnB1dCBpZD0ibmstdG9rZW4tJytzKyciIHR5cGU9InBhc3N3b3JkIiBwbGFjZWhvbGRlcj0iYXBpZnlfYXBpX+KApiI+PC9kaXY+JwogICAgICArJzxkaXY+PGxhYmVsPk1vbnRobHkgY2FwIChVU0QpPC9sYWJlbD48aW5wdXQgaWQ9Im5rLWNhcC0nK3MrJyIgdHlwZT0ibnVtYmVyIiBzdGVwPSIwLjUiIHZhbHVlPSI1Ij48L2Rpdj4nCiAgICAgICsnPGRpdj48bGFiZWw+QXNzaWduZWQgam9iPC9sYWJlbD48c2VsZWN0IGlkPSJuay1qb2ItJytzKyciPicram9iT3B0cyhqb2IpKyc8L3NlbGVjdD48L2Rpdj48L2Rpdj4nCiAgICAgICsnPGRpdiBjbGFzcz0iYnRucm93Ij48YnV0dG9uIGNsYXNzPSJidG4gZGFyayIgZGF0YS1hY3Q9ImFkZCIgZGF0YS1zbG90PSInK3MrJyI+KyBBZGQga2V5IHRvIFNsb3QgJytzKyc8L2J1dHRvbj48L2Rpdj4nOwogICAgfQogICAgaCs9JzwvZGl2Pic7CiAgfQogIGgrPSc8L2Rpdj4nOwogIFYuaW5uZXJIVE1MPWg7CiAgKGQua2V5c3x8W10pLmZvckVhY2goZnVuY3Rpb24oayl7bG9hZFVzYWdlKGsuaWQsay5tb250aGx5X2NhcF91c2R8fDUpO30pOwogIFYucXVlcnlTZWxlY3RvckFsbCgiW2RhdGEtYWN0XSIpLmZvckVhY2goZnVuY3Rpb24oYil7CiAgICBiLm9uY2xpY2s9ZnVuY3Rpb24oKXtoYW5kbGVBcGlmeShiLmRhdGFzZXQuYWN0LGIuZGF0YXNldC5pZHx8Yi5kYXRhc2V0LnNsb3QpO307CiAgfSk7Cn0sCgphc3luYyBtYW5pZmVzdCgpewogIHZhciBkPWF3YWl0IGFwaSgibWFuaWZlc3QiKTsKICB2YXIgZXBzPWQuZW5kcG9pbnRzfHxbXTsKICB2YXIgYWN0aXZlPWVwcy5maW5kKGZ1bmN0aW9uKGUpe3JldHVybiBlLmVuYWJsZWQmJihlLnVzZWRfdGhpc19tb250aHx8MCk8KGUubW9udGhseV9saW1pdHx8MTAwMDApO30pOwogIHZhciBoPSc8ZGl2IGNsYXNzPSJjYXJkIj48aDI+8J+kliBNYW5pZmVzdCBlbmRwb2ludHM8L2gyPjxkaXYgY2xhc3M9InN1YiI+TExNIHJvdXRlciDCtyBhdXRvLXJvbGxvdmVyIHRvIHRoZSBuZXh0IGVuZHBvaW50IHdoZW4gcXVvdGEgcnVucyBvdXQ8L2Rpdj4nOwogIGlmKGFjdGl2ZSl7aCs9JzxkaXYgY2xhc3M9ImhpbnQiPuKaoSA8Yj5Sb3V0ZXIgYWN0aXZlOjwvYj4gPGI+Jytlc2MoYWN0aXZlLmxhYmVsfHwoIkVuZHBvaW50ICIrYWN0aXZlLmlkKSkrJzwvYj4g4oCUIHBpcGVsaW5lIExMTSBjYWxscyBnbyBoZXJlIHVudGlsIGl0cyBxdW90YSBpcyB1c2VkLjwvZGl2Pic7fQogIGVsc2UgaWYoZXBzLmxlbmd0aCl7aCs9JzxkaXYgY2xhc3M9Indhcm5ib3giPuKaoO+4jyBObyBlbmRwb2ludCB3aXRoIHJlbWFpbmluZyBxdW90YSDigJQgTExNIGVucmljaG1lbnQgaXMgcGF1c2VkIHVudGlsIHF1b3RhIHJlc2V0cyBvciBhIG5ldyBrZXkgaXMgYWRkZWQuPC9kaXY+Jzt9CiAgZXBzLmZvckVhY2goZnVuY3Rpb24oZSl7CiAgICB2YXIgbGltaXQ9ZS5tb250aGx5X2xpbWl0fHwxMDAwMDt2YXIgdXNlZD1lLnVzZWRfdGhpc19tb250aHx8MDt2YXIgcGN0PU1hdGgucm91bmQoMTAwKnVzZWQvbGltaXQpOwogICAgdmFyIHdhcm44MD1wY3Q+PTgwJiZwY3Q8MTAwO3ZhciBpc0FjdGl2ZT1hY3RpdmUmJmFjdGl2ZS5pZD09PWUuaWQ7CiAgICBoKz0nPGRpdiBjbGFzcz0ic2xvdCInKyhpc0FjdGl2ZT8nIHN0eWxlPSJib3JkZXItY29sb3I6dmFyKC0tYW0pIic6JycpKyc+PGRpdiBjbGFzcz0ic2xvdC10b3AiPjxiPicrZXNjKGUubGFiZWx8fCgiRW5kcG9pbnQgIitlLmlkKSkrJzwvYj4nCiAgICArJzxzcGFuIGNsYXNzPSJiYWRnZSAnKyhlLmVuYWJsZWQ/Im9uIjoib2ZmIikrJyI+JysoZS5lbmFibGVkPyJBQ1RJVkUiOiJESVNBQkxFRCIpKyc8L3NwYW4+JwogICAgKyhpc0FjdGl2ZT8nPHNwYW4gY2xhc3M9ImJhZGdlIHJvdXRlciI+4pqhIFJPVVRFUjwvc3Bhbj4nOicnKQogICAgKyc8c3BhbiBjbGFzcz0idG9rIj4nK2VzYyhlLmJhc2VfdXJsfHwiIikucmVwbGFjZSgvXmh0dHBzPzpcL1wvLywiIikuc2xpY2UoMCwzMikrJzwvc3Bhbj48L2Rpdj4nCiAgICArJzxkaXYgY2xhc3M9InByb2cnKyhwY3Q+PTEwMD8iIG92ZXIiOiIiKSsnIj48aSBzdHlsZT0id2lkdGg6JytNYXRoLm1pbigxMDAscGN0KSsnJSI+PC9pPjwvZGl2PicKICAgICsnPGRpdiBjbGFzcz0ibWV0YSI+PGI+Jyt1c2VkLnRvTG9jYWxlU3RyaW5nKCkrJzwvYj4gLyAnK2xpbWl0LnRvTG9jYWxlU3RyaW5nKCkrJyByZXF1ZXN0cyB1c2VkICgnK3BjdCsnJSk8L2Rpdj4nCiAgICArKHdhcm44MD8nPGRpdiBjbGFzcz0id2FybmJveCI+4pqg77iPIE92ZXIgODAlIHVzZWQg4oCUIGFkZCBhIGJhY2t1cCBlbmRwb2ludCBvciBxdW90YSByZXNldHMgb24gZGF5ICcrKGUucmVzZXRfZGF5fHwxKSsnLjwvZGl2Pic6IiIpCiAgICArKHBjdD49MTAwPyc8ZGl2IGNsYXNzPSJ3YXJuYm94Ij7wn5qrIFF1b3RhIGV4aGF1c3RlZCDigJQgcm91dGVyIGhhcyByb2xsZWQgb3ZlciB0byB0aGUgbmV4dCBlbmRwb2ludC48L2Rpdj4nOiIiKQogICAgKyc8ZGl2IGNsYXNzPSJidG5yb3ciPjxidXR0b24gY2xhc3M9ImJ0biIgZGF0YS1tYWN0PSJ0ZXN0IiBkYXRhLWlkPSInK2UuaWQrJyI+VGVzdDwvYnV0dG9uPicKICAgICsnPGJ1dHRvbiBjbGFzcz0iYnRuIiBkYXRhLW1hY3Q9InRvZ2dsZSIgZGF0YS1pZD0iJytlLmlkKyciPicrKGUuZW5hYmxlZD8iRGlzYWJsZSI6IkVuYWJsZSIpKyc8L2J1dHRvbj4nCiAgICArJzxidXR0b24gY2xhc3M9ImJ0biBkYW5nZXIiIGRhdGEtbWFjdD0iZGVsIiBkYXRhLWlkPSInK2UuaWQrJyI+UmVtb3ZlPC9idXR0b24+PC9kaXY+PC9kaXY+JzsKICB9KTsKICBoKz0nPGRpdiBjbGFzcz0iY2FyZCIgc3R5bGU9Im1hcmdpbi10b3A6MTRweCI+PGgyPvCflI0gU0VPIEVucmljaG1lbnQ8L2gyPjxkaXYgY2xhc3M9InN1YiI+QXV0by13cml0ZSBTRU8gdGl0bGUsIG1ldGEgZGVzY3JpcHRpb24sIGZ1bGwgZGVzY3JpcHRpb24gJiBGQVEgdXNpbmcgdGhlIGRhc2hib2FyZCBrZXk8L2Rpdj48ZGl2IGlkPSJzZW8tc3RhdHVzIiBjbGFzcz0iaGludCI+Q2xpY2sgU3RhcnQgdG8gYmVnaW48L2Rpdj48ZGl2IHN0eWxlPSJtYXJnaW4tdG9wOjEwcHgiPjxidXR0b24gY2xhc3M9ImJ0biIgb25jbGljaz0ic2VvRW5yaWNoKCkiPuKWtiBTdGFydCBTRU8gRW5yaWNobWVudDwvYnV0dG9uPiA8YnV0dG9uIGNsYXNzPSJidG4gZ2hvc3QiIG9uY2xpY2s9InNlb0VucmljaCgxKSI+VGVzdCAxIHRvb2w8L2J1dHRvbj48L2Rpdj48L2Rpdj4nOwogIGgrPSc8ZGl2IGNsYXNzPSJzbG90IiBzdHlsZT0iYm9yZGVyLXN0eWxlOmRhc2hlZCI+PGRpdiBjbGFzcz0ic2xvdC10b3AiPjxiIHN0eWxlPSJjb2xvcjp2YXIoLS1tdXQpIj4rIE5ldyBlbmRwb2ludDwvYj48L2Rpdj4nCiAgKyc8ZGl2IGNsYXNzPSJmMiI+PGRpdj48bGFiZWw+TGFiZWw8L2xhYmVsPjxpbnB1dCBpZD0ibm0tbGFiZWwiIHBsYWNlaG9sZGVyPSJtYWluIj48L2Rpdj4nCiAgKyc8ZGl2PjxsYWJlbD5CYXNlIFVSTDwvbGFiZWw+PGlucHV0IGlkPSJubS11cmwiIHZhbHVlPSJodHRwczovL2FwcC5tYW5pZmVzdC5idWlsZC92MSI+PC9kaXY+JwogICsnPGRpdj48bGFiZWw+QVBJIEtleTwvbGFiZWw+PGlucHV0IGlkPSJubS1rZXkiIHR5cGU9InBhc3N3b3JkIiBwbGFjZWhvbGRlcj0ic2st4oCmIj48L2Rpdj4nCiAgKyc8ZGl2PjxsYWJlbD5Nb250aGx5IGxpbWl0IChyZXF1ZXN0cyk8L2xhYmVsPjxpbnB1dCBpZD0ibm0tbGltaXQiIHR5cGU9Im51bWJlciIgdmFsdWU9IjEwMDAwIj48L2Rpdj48L2Rpdj4nCiAgKyc8ZGl2IGNsYXNzPSJoaW50IiBzdHlsZT0ibWFyZ2luOjAgMCAxMnB4Ij5FYWNoIE1hbmlmZXN0IEFQSSBrZXkgaW5jbHVkZXMgPGI+MTAsMDAwIHJlcXVlc3RzL21vbnRoPC9iPi4gQWRkIGEgMm5kIGtleSBhcyBiYWNrdXAg4oCUIHRoZSByb3V0ZXIgcm9sbHMgb3ZlciBhdXRvbWF0aWNhbGx5LjwvZGl2PicKICArJzxkaXYgY2xhc3M9ImJ0bnJvdyI+PGJ1dHRvbiBjbGFzcz0iYnRuIGRhcmsiIGRhdGEtbWFjdD0iYWRkIj4rIEFkZCBlbmRwb2ludDwvYnV0dG9uPjwvZGl2PjwvZGl2Pic7CiAgaCs9JzwvZGl2Pic7CiAgVi5pbm5lckhUTUw9aDsKICBWLnF1ZXJ5U2VsZWN0b3JBbGwoIltkYXRhLW1hY3RdIikuZm9yRWFjaChmdW5jdGlvbihiKXsKICAgIGIub25jbGljaz1mdW5jdGlvbigpe2hhbmRsZU1hbmlmZXN0KGIuZGF0YXNldC5tYWN0LGIuZGF0YXNldC5pZCk7fTsKICB9KTsKfSwKCmFzeW5jIHJ1bnMoKXsKICB2YXIgZD1hd2FpdCBhcGkoInBpcGVsaW5lL3J1bnMiKTsKICB2YXIgZ2g9ZC5naXRodWJfcnVuc3x8W10sZGI9ZC5kYl9ydW5zfHxbXTsKICB2YXIgaD0nPGRpdiBjbGFzcz0iY2FyZCI+PGgyPvCflIQgUGlwZWxpbmUgcnVuczwvaDI+PGRpdiBjbGFzcz0ic3ViIj5HaXRIdWIgQWN0aW9ucyArIEQxIHJ1biBoaXN0b3J5PC9kaXY+JzsKICBpZighZ2gubGVuZ3RoJiYhZGIubGVuZ3RoKWgrPSc8ZGl2IGNsYXNzPSJtZXRhIj5ObyBydW5zIHJlY29yZGVkIHlldC48L2Rpdj4nOwogIGgrPSc8ZGl2IGNsYXNzPSJ0aW1lbGluZSI+JzsKICBnaC5zbGljZSgwLDgpLmZvckVhY2goZnVuY3Rpb24ocil7CiAgICB2YXIgb2s9ci5jb25jbHVzaW9uPT09InN1Y2Nlc3MiO3ZhciBydW5uaW5nPXIuc3RhdHVzIT09ImNvbXBsZXRlZCI7CiAgICBoKz0nPGRpdiBjbGFzcz0idGwtaXRlbSAnKyhvaz8ib2siOnJ1bm5pbmc/InJ1biI6ImJhZCIpKyciPjxiPiMnK3IuaWQrJzwvYj4gJytlc2Moci5jb25jbHVzaW9ufHxyLnN0YXR1c3x8InVua25vd24iKS5yZXBsYWNlKC9fL2csIiAiKQogICAgKycgPHNwYW4gY2xhc3M9Im1ldGEiPmNvbW1pdCAnK2VzYyhTdHJpbmcoci5oZWFkX3NoYXx8IiIpLnNsaWNlKDAsNykpKycgwrcgYnJhbmNoICcrZXNjKHIuaGVhZF9icmFuY2h8fCJtYWluIikrJyDCtyAnK3RpbWVBZ28oci5jcmVhdGVkX2F0KSsnPC9zcGFuPjwvZGl2Pic7CiAgfSk7CiAgaCs9JzwvZGl2Pic7CiAgaWYoZGIubGVuZ3RoKXsKICAgIGgrPSc8ZGl2IGNsYXNzPSJzdWIiIHN0eWxlPSJtYXJnaW4tdG9wOjE0cHgiPkQxIHBpcGVsaW5lX3J1bnMgdGFibGU8L2Rpdj48ZGl2IGNsYXNzPSJ0aW1lbGluZSI+JzsKICAgIGRiLnNsaWNlKDAsNSkuZm9yRWFjaChmdW5jdGlvbihyKXsKICAgICAgaCs9JzxkaXYgY2xhc3M9InRsLWl0ZW0gb2siPjxiPnJ1biAnK2VzYyhyLmlkKSsnPC9iPiA8c3BhbiBjbGFzcz0ibWV0YSI+Jytlc2Moci5zdGFydGVkX2F0fHwiIikrKHIudG9vbHNfYWRkZWQ/IiDCtyAiK3IudG9vbHNfYWRkZWQrIiB0b29scyI6IiIpKyc8L3NwYW4+PC9kaXY+JzsKICAgIH0pOwogICAgaCs9JzwvZGl2Pic7CiAgfQogIGgrPSc8L2Rpdj4nOwogIFYuaW5uZXJIVE1MPWg7Cn0sCgphc3luYyB0cmFmZmljKCl7CiAgVi5pbm5lckhUTUw9JzxkaXYgY2xhc3M9ImNhcmQiPjxoMj7wn5OIIFRyYWZmaWM8L2gyPjxkaXYgY2xhc3M9InN1YiI+Q2xvdWRmbGFyZSBXZWIgQW5hbHl0aWNzIChSVU0pIMK3IG5vIHNlcGFyYXRlIEFQSSBuZWVkZWQ8L2Rpdj4nCiAgKyc8ZGl2IGNsYXNzPSJidG5yb3ciIHN0eWxlPSJtYXJnaW4tdG9wOjA7bWFyZ2luLWJvdHRvbTo2cHgiPicKICArJzxidXR0b24gY2xhc3M9ImJ0biIgZGF0YS1kPSIxIj4yNGg8L2J1dHRvbj48YnV0dG9uIGNsYXNzPSJidG4iIGRhdGEtZD0iNyI+N2Q8L2J1dHRvbj48YnV0dG9uIGNsYXNzPSJidG4iIGRhdGEtZD0iMzAiPjMwZDwvYnV0dG9uPjwvZGl2PicKICArJzxkaXYgaWQ9InRkYXRhIj48ZGl2IGNsYXNzPSJtZXRhIj5sb2FkaW5n4oCmPC9kaXY+PC9kaXY+PC9kaXY+JzsKICBhc3luYyBmdW5jdGlvbiBzZW9FbnJpY2goc2luZ2xlKXsKICB2YXIgc3Q9ZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ3Nlby1zdGF0dXMnKTsKICB2YXIgbj1zaW5nbGU/MToxMDsKICBzdC5pbm5lckhUTUw9J+KPsyBFbnJpY2hpbmcgJytuKycgdG9vbChzKS4uLic7CiAgdHJ5ewogICAgdmFyIHI9YXdhaXQgYXBpKCcvc2VvLWVucmljaCcsJ1BPU1QnLHtsaW1pdDpufSk7CiAgICBpZihyJiZyLm9rKXsKICAgICAgc3QuaW5uZXJIVE1MPSfinIUgRW5yaWNoZWQgJytyLmRvbmUrJyB0b29sKHMpLiAnK3IucmVtYWluaW5nKycgcmVtYWluaW5nLic7CiAgICAgIGlmKHIucmVtYWluaW5nPjAmJiFzaW5nbGUpe3NldFRpbWVvdXQoZnVuY3Rpb24oKXtzZW9FbnJpY2goKTt9LDMwMDApO30KICAgIH1lbHNle3N0LmlubmVySFRNTD0n4p2MICcrKHImJnIuZXJyb3J8fCdGYWlsZWQnKTt9CiAgfWNhdGNoKGUpe3N0LmlubmVySFRNTD0n4p2MICcrZS5tZXNzYWdlO30KfQpmdW5jdGlvbiBsb2FkKGRheXMpewogICAgdmFyIGVsPWRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCJ0ZGF0YSIpOwogICAgVi5xdWVyeVNlbGVjdG9yQWxsKCJbZGF0YS1kXSIpLmZvckVhY2goZnVuY3Rpb24oYil7Yi5jbGFzc0xpc3QudG9nZ2xlKCJkYXJrIixiLmRhdGFzZXQuZD09ZGF5cyk7fSk7CiAgICBhcGkoInRyYWZmaWM/ZGF5cz0iK2RheXMpLnRoZW4oZnVuY3Rpb24ocil7CiAgICAgIGlmKCFyLmVuYWJsZWQpewogICAgICAgIGVsLmlubmVySFRNTD0nPGRpdiBjbGFzcz0iaGludCIgc3R5bGU9Im1hcmdpbi10b3A6MTJweCI+8J+TiiA8Yj5XZWIgQW5hbHl0aWNzIG5vdCBjb25uZWN0ZWQgeWV0LjwvYj48YnI+PGJyPkVuYWJsZSBpdDogQ2xvdWRmbGFyZSBkYXNoYm9hcmQg4oaSIFBhZ2VzIOKGkiA8Yj5haS1kaXJlY3RvcnktdjUtcmFkd2FuNjQ4PC9iPiDihpIgQW5hbHl0aWNzIOKGkiA8Yj5FbmFibGUgV2ViIEFuYWx5dGljczwvYj4uPGJyPkRhdGEgYXBwZWFycyB3aXRoaW4gYSBmZXcgaG91cnMuIE5vIGNvZGUgY2hhbmdlcyBvciBleHRyYSBBUEkga2V5cyBuZWVkZWQg4oCUIHRoZSBleGlzdGluZyB0b2tlbiBhbHJlYWR5IGhhcyBhY2Nlc3MuPC9kaXY+JzsKICAgICAgICByZXR1cm47CiAgICAgIH0KICAgICAgdmFyIHBhZ2VzPXIudG9wX3BhZ2VzfHxbXTsKICAgICAgdmFyIG1heD1NYXRoLm1heC5hcHBseShudWxsLHBhZ2VzLm1hcChmdW5jdGlvbihwKXtyZXR1cm4gcC52aWV3czt9KS5jb25jYXQoWzFdKSk7CiAgICAgIHZhciBoPSc8ZGl2IGNsYXNzPSJzcGFyayI+JytwYWdlcy5zbGljZSgwLDEyKS5tYXAoZnVuY3Rpb24ocCl7cmV0dXJuICc8aSBzdHlsZT0iaGVpZ2h0OicrTWF0aC5tYXgoNixNYXRoLnJvdW5kKDEwMCpwLnZpZXdzL21heCkpKyclIiB0aXRsZT0iJytlc2MocC5wYWdlKSsiIOKAlCAiK3Audmlld3MrJyI+PC9pPic7fSkuam9pbigiIikrJzwvZGl2Pic7CiAgICAgIGgrPSc8ZGl2IGNsYXNzPSJrcGlzIiBzdHlsZT0iZ3JpZC10ZW1wbGF0ZS1jb2x1bW5zOnJlcGVhdCgzLDFmcikiPicKICAgICAgKyc8ZGl2IGNsYXNzPSJrcGkgazEiPjxkaXYgY2xhc3M9ImxiIj5WaXNpdG9ycyAoJytyLmRheXMrJ2QpPC9kaXY+PGRpdiBjbGFzcz0idmwiIGlkPSJ0di12Ij4wPC9kaXY+PC9kaXY+JwogICAgICArJzxkaXYgY2xhc3M9ImtwaSBrMiI+PGRpdiBjbGFzcz0ibGIiPlBhZ2V2aWV3cyAoJytyLmRheXMrJ2QpPC9kaXY+PGRpdiBjbGFzcz0idmwiIGlkPSJ0di1wIj4wPC9kaXY+PC9kaXY+JwogICAgICArJzxkaXYgY2xhc3M9ImtwaSBrMyI+PGRpdiBjbGFzcz0ibGIiPlRvcCBwYWdlPC9kaXY+PGRpdiBjbGFzcz0idmwiIHN0eWxlPSJmb250LXNpemU6MTVweDt3b3JkLWJyZWFrOmJyZWFrLWFsbCI+Jytlc2MoKHBhZ2VzWzBdfHx7fSkucGFnZXx8IuKAlCIpLnNsaWNlKDAsNDApKyc8L2Rpdj48L2Rpdj48L2Rpdj4nOwogICAgICBpZihwYWdlcy5sZW5ndGgpewogICAgICAgIGgrPSc8ZGl2IGNsYXNzPSJzdWIiIHN0eWxlPSJtYXJnaW4tdG9wOjE2cHgiPlRvcCBwYWdlczwvZGl2PicrcGFnZXMuc2xpY2UoMCw4KS5tYXAoZnVuY3Rpb24ocCl7CiAgICAgICAgICByZXR1cm4gJzxkaXYgc3R5bGU9ImRpc3BsYXk6ZmxleDtqdXN0aWZ5LWNvbnRlbnQ6c3BhY2UtYmV0d2VlbjtwYWRkaW5nOjdweCAwO2JvcmRlci1ib3R0b206MXB4IHNvbGlkIHZhcigtLWxpbmUpO2ZvbnQtc2l6ZToxM3B4Ij48c3Bhbj4nK2VzYyhwLnBhZ2UpLnNsaWNlKDAsNTUpKyc8L3NwYW4+PGI+JytwLnZpZXdzLnRvTG9jYWxlU3RyaW5nKCkrJzwvYj48L2Rpdj4nO30pLmpvaW4oIiIpOwogICAgICB9CiAgICAgIGVsLmlubmVySFRNTD1oOwogICAgICBjb3VudFVwKGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCJ0di12Iiksci52aXNpdHN8fDApOwogICAgICBjb3VudFVwKGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCJ0di1wIiksci5wYWdldmlld3N8fDApOwogICAgfSkuY2F0Y2goZnVuY3Rpb24oKXtlbC5pbm5lckhUTUw9JzxkaXYgY2xhc3M9Im1ldGEiPkZhaWxlZCB0byBsb2FkIHRyYWZmaWMuPC9kaXY+Jzt9KTsKICB9CiAgVi5xdWVyeVNlbGVjdG9yQWxsKCJbZGF0YS1kXSIpLmZvckVhY2goZnVuY3Rpb24oYil7Yi5vbmNsaWNrPWZ1bmN0aW9uKCl7bG9hZChiLmRhdGFzZXQuZCk7fTt9KTsKICBsb2FkKDcpOwp9LAoKYXN5bmMgYWN0aW9ucygpewogIFYuaW5uZXJIVE1MPSc8ZGl2IGNsYXNzPSJjYXJkIj48aDI+4pqZ77iPIEFjdGlvbnM8L2gyPjxkaXYgY2xhc3M9InN1YiI+TWFudWFsIHRyaWdnZXJzIOKAlCB1c2UgY2FyZWZ1bGx5PC9kaXY+PGRpdiBjbGFzcz0iYWN0cyI+JwogICsnPGRpdiBjbGFzcz0iYWN0IiBpZD0iYWN0LWRpc3BhdGNoIj48ZGl2IGNsYXNzPSJlIj7wn5qAPC9kaXY+PGI+VHJpZ2dlciBwaXBlbGluZTwvYj48c3Bhbj5EaXNwYXRjaCB0aGUgR2l0SHViIHNjcmFwZXIgd29ya2Zsb3cgbm93IChzYW1lIGFzIGNyb24pPC9zcGFuPjwvZGl2PicKICArJzxkaXYgY2xhc3M9ImFjdCIgaWQ9ImFjdC1zbmFwc2hvdCI+PGRpdiBjbGFzcz0iZSI+8J+TuDwvZGl2PjxiPkJha2Ugc25hcHNob3Q8L2I+PHNwYW4+UnVucyB2aWEgcGlwZWxpbmUg4oCUIHJlZnJlc2hlcyBob21lcGFnZSBzZWN0aW9ucy5qc29uPC9zcGFuPjwvZGl2PicKICArJzxkaXYgY2xhc3M9ImFjdCIgaWQ9ImFjdC1kZWR1cGUiPjxkaXYgY2xhc3M9ImUiPvCfp7k8L2Rpdj48Yj5SdW4gZGVkdXBlPC9iPjxzcGFuPlJ1bnMgdmlhIHBpcGVsaW5lIOKAlCBjbGVhbnMgZHVwbGljYXRlIEFJIHRvb2xzPC9zcGFuPjwvZGl2PicKICArJzxkaXYgY2xhc3M9ImFjdCIgaWQ9ImFjdC10ZyI+PGRpdiBjbGFzcz0iZSI+8J+UlDwvZGl2PjxiPlRlc3QgVGVsZWdyYW08L2I+PHNwYW4+U2VuZCBhIHRlc3QgYWxlcnQgdG8gdGhlIGFkbWluIGNoYXQ8L3NwYW4+PC9kaXY+JwogICsnPC9kaXY+PGRpdiBjbGFzcz0iaGludCIgc3R5bGU9Im1hcmdpbi10b3A6MTRweCI+4oS577iPIFNuYXBzaG90ICZhbXA7IGRlZHVwZSBydW4gYXMgcGlwZWxpbmUgc3RlcHMg4oCUIHRyaWdnZXJpbmcgdGhlIHBpcGVsaW5lIHJ1bnMgdGhlIGZ1bGwgZmxvdyBpbmNsdWRpbmcgdGhlbS48L2Rpdj48L2Rpdj4nOwogIGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCJhY3QtZGlzcGF0Y2giKS5vbmNsaWNrPWZ1bmN0aW9uKCl7ZG9EaXNwYXRjaCgpO307CiAgZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoImFjdC1zbmFwc2hvdCIpLm9uY2xpY2s9ZnVuY3Rpb24oKXtkb0Rpc3BhdGNoKCJzbmFwc2hvdCIpO307CiAgZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoImFjdC1kZWR1cGUiKS5vbmNsaWNrPWZ1bmN0aW9uKCl7ZG9EaXNwYXRjaCgiZGVkdXBlIik7fTsKICBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgiYWN0LXRnIikub25jbGljaz1mdW5jdGlvbigpe2RvVGcoKTt9Owp9Cn07Cgphc3luYyBmdW5jdGlvbiBsb2FkVXNhZ2UoaWQsY2FwKXsKICB2YXIgZWw9ZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoInVzYWdlLSIraWQpO2lmKCFlbClyZXR1cm47CiAgdHJ5ewogICAgdmFyIHU9YXdhaXQgYXBpKCJhcGlmeS1rZXlzLyIraWQrIi91c2FnZSIpOwogICAgaWYoIXUuYXZhaWxhYmxlKXsKICAgICAgZWwuaW5uZXJIVE1MPSc8ZGl2IGNsYXNzPSJtZXRhIj7imqDvuI8gVXNhZ2UgdW5hdmFpbGFibGUgKCcrZXNjKHUucmVhc29ufHwidW5rbm93biIpKycpPC9kaXY+JzsKICAgICAgcmV0dXJuOwogICAgfQogICAgdmFyIHVzZWQ9dS50b3RhbF91c2R8fDA7dmFyIHBjdD1NYXRoLm1pbigxMDAsTWF0aC5yb3VuZCgxMDAqdXNlZC9jYXApKTsKICAgIHZhciBoPSc8ZGl2IGNsYXNzPSJwcm9nJysocGN0Pj05MD8iIG92ZXIiOiIiKSsnIj48aSBzdHlsZT0id2lkdGg6JytwY3QrJyUiPjwvaT48L2Rpdj4nCiAgICArJzxkaXYgY2xhc3M9Im1ldGEiPjxiPkFjdHVhbCBBcGlmeSB1c2FnZTogJCcrdXNlZC50b0ZpeGVkKDIpKyc8L2I+IC8gTG9jYWwgY2FwICQnK2NhcC50b0ZpeGVkKDIpKycgKCcrcGN0KyclKTwvZGl2PicKICAgICsnPGRpdiBjbGFzcz0ibWV0YSI+8J+RpCAnK2VzYyh1LnVzZXJuYW1lfHwiLSIpKycgwrcg8J+TiyBQbGFuOiAnK2VzYyh1LnBsYW58fCItIikKICAgICsnIMK3IPCfk4UgQ3ljbGU6ICcrZXNjKHUuY3ljbGVfc3RhcnR8fCItIikrJyDihpIgJytlc2ModS5jeWNsZV9lbmR8fCItIikrJzwvZGl2Pic7CiAgICBpZih1LnNlcnZpY2VzJiZ1LnNlcnZpY2VzLmxlbmd0aCl7CiAgICAgIGgrPSc8ZGl2IGNsYXNzPSJtZXRhIiBzdHlsZT0ibWFyZ2luLXRvcDo0cHgiPjxiPkJyZWFrZG93bjo8L2I+PGJyPic7CiAgICAgIHUuc2VydmljZXMuZm9yRWFjaChmdW5jdGlvbihzdil7CiAgICAgICAgaCs9J8K3ICcrZXNjKHN2LmxhYmVsKSsnOiAkJytzdi51c2QudG9GaXhlZCgyKSsoc3YudW5pdD8nICgnK3N2LnF1YW50aXR5KycgJytzdi51bml0KycpJzoiIikrJzxicj4nOwogICAgICB9KTsKICAgICAgaCs9JzwvZGl2Pic7CiAgICB9CiAgICBlbC5pbm5lckhUTUw9aDsKICB9Y2F0Y2goZSl7ZWwuaW5uZXJIVE1MPSc8ZGl2IGNsYXNzPSJtZXRhIj5Vc2FnZSB1bmF2YWlsYWJsZS48L2Rpdj4nO30KfQoKZnVuY3Rpb24gYWRkQXBpZnlTbG90KCl7CiAgd2luZG93Ll9hcGlmeUV4dHJhU2xvdHM9KHdpbmRvdy5fYXBpZnlFeHRyYVNsb3RzfHwwKSsxOwogIHZpZXdzLmFwaWZ5KCk7Cn0KYXN5bmMgZnVuY3Rpb24gaGFuZGxlQXBpZnkoYWN0LGlkKXsKICB0cnl7CiAgICBpZihhY3Q9PT0ic2F2ZSIpewogICAgICB2YXIgbGFiZWw9ZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoImFrLWxhYmVsLSIraWQpLnZhbHVlOwogICAgICB2YXIgam9iPWRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCJhay1qb2ItIitpZCkudmFsdWU7CiAgICAgIHZhciBjYXA9cGFyc2VGbG9hdChkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgiYWstY2FwLSIraWQpLnZhbHVlKXx8NTsKICAgICAgdmFyIHRva2VuPWRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCJhay10b2tlbi0iK2lkKS52YWx1ZTsKICAgICAgdmFyIGJvZHk9e2lkOnBhcnNlSW50KGlkKSxsYWJlbDpsYWJlbCxhc3NpZ25lZF9qb2I6am9iLG1vbnRobHlfY2FwX3VzZDpjYXB9OwogICAgICBpZih0b2tlbilib2R5LnRva2VuPXRva2VuOwogICAgICBhd2FpdCBhcGkoImFwaWZ5LWtleXMiLHttZXRob2Q6IlBPU1QiLGJvZHk6SlNPTi5zdHJpbmdpZnkoYm9keSl9KTsKICAgICAgbG9nKCJLZXkgIitpZCsiIHNhdmVkLiIpO3ZpZXdzLmFwaWZ5KCk7CiAgICB9ZWxzZSBpZihhY3Q9PT0iYWRkIil7CiAgICAgIHZhciBzPWlkOwogICAgICB2YXIgbmxhYmVsPWRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCJuay1sYWJlbC0iK3MpLnZhbHVlOwogICAgICB2YXIgbnRva2VuPWRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCJuay10b2tlbi0iK3MpLnZhbHVlOwogICAgICB2YXIgbmNhcD1wYXJzZUZsb2F0KGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCJuay1jYXAtIitzKS52YWx1ZSl8fDU7CiAgICAgIHZhciBuam9iPWRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCJuay1qb2ItIitzKS52YWx1ZTsKICAgICAgaWYoIW50b2tlbil7YWxlcnQoIlBhc3RlIGFuIEFQSSBrZXkgZmlyc3QuIik7cmV0dXJuO30KICAgICAgYXdhaXQgYXBpKCJhcGlmeS1rZXlzIix7bWV0aG9kOiJQT1NUIixib2R5OkpTT04uc3RyaW5naWZ5KHtzbG90OnBhcnNlSW50KHMpLGxhYmVsOm5sYWJlbCx0b2tlbjpudG9rZW4sbW9udGhseV9jYXBfdXNkOm5jYXAsYXNzaWduZWRfam9iOm5qb2J9KX0pOwogICAgICBsb2coIlNsb3QgIitzKyIga2V5IGFkZGVkLiIpO3ZpZXdzLmFwaWZ5KCk7CiAgICB9ZWxzZSBpZihhY3Q9PT0idGVzdCIpewogICAgICBsb2coIlRlc3Rpbmcga2V5ICIraWQrIuKApiIpOwogICAgICB2YXIgcj1hd2FpdCBhcGkoImFwaWZ5LWtleXMvIitpZCsiL3Rlc3QiLHttZXRob2Q6IlBPU1QifSk7CiAgICAgIGlmKHIub2spewogICAgICAgIHZhciBtc2c9IktleSB3b3JrcyDinIUiOwogICAgICAgIGlmKHIudXNlcm5hbWUpbXNnKz0iXG5Vc2VyOiAiK3IudXNlcm5hbWU7CiAgICAgICAgaWYoci5wbGFuKW1zZys9IlxuUGxhbjogIityLnBsYW47CiAgICAgICAgaWYoci5jcmVkaXQpewogICAgICAgICAgbXNnKz0iXG5Vc2VkIHRoaXMgY3ljbGU6ICQiKyhyLmNyZWRpdC51c2VkX3VzZHx8MCkudG9GaXhlZCgyKTsKICAgICAgICAgIGlmKHIuY3JlZGl0LmN5Y2xlX3N0YXJ0KW1zZys9IlxuQ3ljbGU6ICIrci5jcmVkaXQuY3ljbGVfc3RhcnQrIiDihpIgIityLmNyZWRpdC5jeWNsZV9lbmQ7CiAgICAgICAgfQogICAgICAgIGxvZygiVGVzdCAiK2lkKyI6IE9LIOKchSAiKyhyLnVzZXJuYW1lfHwiIikpOwogICAgICAgIGFsZXJ0KG1zZyk7CiAgICAgIH1lbHNlewogICAgICAgIGxvZygiVGVzdCAiK2lkKyI6IEZBSUxFRCDinYwgIisoci5lcnJvcnx8ci5zdGF0dXN8fCIiKSk7CiAgICAgICAgYWxlcnQoIlRlc3QgZmFpbGVkOiAiKyhyLmVycm9yfHxyLnN0YXR1c3x8InVua25vd24iKSk7CiAgICAgIH0KICAgIH1lbHNlIGlmKGFjdD09PSJ0b2dnbGUiKXsKICAgICAgYXdhaXQgYXBpKCJhcGlmeS1rZXlzLyIraWQrIi90b2dnbGUiLHttZXRob2Q6IlBPU1QifSk7CiAgICAgIGxvZygiS2V5ICIraWQrIiB0b2dnbGVkLiIpO3ZpZXdzLmFwaWZ5KCk7CiAgICB9ZWxzZSBpZihhY3Q9PT0iZGVsIil7CiAgICAgIGlmKCFjb25maXJtKCJSZW1vdmUgdGhpcyBrZXk/IikpcmV0dXJuOwogICAgICBhd2FpdCBhcGkoImFwaWZ5LWtleXMvIitpZCx7bWV0aG9kOiJERUxFVEUifSk7CiAgICAgIGxvZygiS2V5ICIraWQrIiByZW1vdmVkLiIpO3ZpZXdzLmFwaWZ5KCk7CiAgICB9CiAgfWNhdGNoKGUpe2xvZygiRXJyb3I6ICIrZS5tZXNzYWdlKTthbGVydCgiRXJyb3I6ICIrZS5tZXNzYWdlKTt9Cn0KCmFzeW5jIGZ1bmN0aW9uIGhhbmRsZU1hbmlmZXN0KGFjdCxpZCl7CiAgdHJ5ewogICAgaWYoYWN0PT09ImFkZCIpewogICAgICB2YXIgbGFiZWw9ZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoIm5tLWxhYmVsIikudmFsdWU7CiAgICAgIHZhciB1cmw9ZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoIm5tLXVybCIpLnZhbHVlOwogICAgICB2YXIga2V5PWRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCJubS1rZXkiKS52YWx1ZTsKICAgICAgdmFyIGxpbWl0PXBhcnNlSW50KGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCJubS1saW1pdCIpLnZhbHVlKXx8MTAwMDA7CiAgICAgIGlmKCFrZXkpe2FsZXJ0KCJQYXN0ZSBhbiBBUEkga2V5IGZpcnN0LiIpO3JldHVybjt9CiAgICAgIGF3YWl0IGFwaSgibWFuaWZlc3QiLHttZXRob2Q6IlBPU1QiLGJvZHk6SlNPTi5zdHJpbmdpZnkoe2xhYmVsOmxhYmVsLGJhc2VfdXJsOnVybCxhcGlfa2V5OmtleSxtb250aGx5X2xpbWl0OmxpbWl0fSl9KTsKICAgICAgbG9nKCJFbmRwb2ludCBhZGRlZC4iKTt2aWV3cy5tYW5pZmVzdCgpOwogICAgfWVsc2UgaWYoYWN0PT09InRlc3QiKXsKICAgICAgbG9nKCJUZXN0aW5nIGVuZHBvaW50ICIraWQrIuKApiIpOwogICAgICB2YXIgcj1hd2FpdCBhcGkoIm1hbmlmZXN0LyIraWQrIi90ZXN0Iix7bWV0aG9kOiJQT1NUIn0pOwogICAgICBsb2coIlRlc3QgIitpZCsiOiAiKyhyLm9rPyJPSyDinIUiOiJGQUlMRUQg4p2MICIrKHIuZXJyb3J8fCIiKSkpOwogICAgICBhbGVydChyLm9rPyJFbmRwb2ludCB3b3JrcyDinIUiOiJUZXN0IGZhaWxlZDogIisoci5lcnJvcnx8InVua25vd24iKSk7CiAgICB9ZWxzZSBpZihhY3Q9PT0idG9nZ2xlIil7CiAgICAgIGF3YWl0IGFwaSgibWFuaWZlc3QvIitpZCsiL3RvZ2dsZSIse21ldGhvZDoiUE9TVCJ9KTsKICAgICAgbG9nKCJFbmRwb2ludCAiK2lkKyIgdG9nZ2xlZC4iKTt2aWV3cy5tYW5pZmVzdCgpOwogICAgfWVsc2UgaWYoYWN0PT09ImRlbCIpewogICAgICBpZighY29uZmlybSgiUmVtb3ZlIHRoaXMgZW5kcG9pbnQ/IikpcmV0dXJuOwogICAgICBhd2FpdCBhcGkoIm1hbmlmZXN0LyIraWQse21ldGhvZDoiREVMRVRFIn0pOwogICAgICBsb2coIkVuZHBvaW50ICIraWQrIiByZW1vdmVkLiIpO3ZpZXdzLm1hbmlmZXN0KCk7CiAgICB9CiAgfWNhdGNoKGUpe2xvZygiRXJyb3I6ICIrZS5tZXNzYWdlKTthbGVydCgiRXJyb3I6ICIrZS5tZXNzYWdlKTt9Cn0KCmFzeW5jIGZ1bmN0aW9uIGRvRGlzcGF0Y2goKXsKICBpZighY29uZmlybSgiVHJpZ2dlciB0aGUgcGlwZWxpbmUgbm93PyIpKXJldHVybjsKICBsb2coIkRpc3BhdGNoaW5nIHBpcGVsaW5l4oCmIik7CiAgdHJ5e3ZhciByPWF3YWl0IGFwaSgicGlwZWxpbmUvZGlzcGF0Y2giLHttZXRob2Q6IlBPU1QifSk7bG9nKCJEaXNwYXRjaDogIisoci5vaz8ic2VudCDinIUiOiJmYWlsZWQg4p2MICIrKHIuc3RhdHVzfHwiIikpKTt9CiAgY2F0Y2goZSl7bG9nKCJEaXNwYXRjaCBmYWlsZWQ6ICIrZS5tZXNzYWdlKTt9Cn0KYXN5bmMgZnVuY3Rpb24gZG9UZygpewogIHRyeXt2YXIgcj1hd2FpdCBhcGkoInRlbGVncmFtL3Rlc3QiLHttZXRob2Q6IlBPU1QifSk7bG9nKCJUZWxlZ3JhbSB0ZXN0OiAiKyhyLm9rPyJzZW50IOKchSI6ImZhaWxlZCDinYwiKSk7fQogIGNhdGNoKGUpe2xvZygiVGVsZWdyYW0gZmFpbGVkOiAiK2UubWVzc2FnZSk7fQp9CgovLyBUYWIgcmVuZGVyaW5nCnZhciBjdXJUYWI9Im92ZXJ2aWV3IjsKdmFyIGN1clRhYj1sb2NhdGlvbi5oYXNoLnJlcGxhY2UoIiMiLCIiKXx8bG9jYWxTdG9yYWdlLmdldEl0ZW0oImFkbWluX3RhYiIpfHwib3ZlcnZpZXciOwpmdW5jdGlvbiByZW5kZXJUYWJzKCl7CiAgdmFyIHNhdmVkPWN1clRhYjsKICBpZighVEFCUy5zb21lKGZ1bmN0aW9uKHQpe3JldHVybiB0WzBdPT09c2F2ZWQ7fSkpc2F2ZWQ9Im92ZXJ2aWV3IjsKICBjdXJUYWI9c2F2ZWQ7CiAgZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoInRhYnMiKS5pbm5lckhUTUw9VEFCUy5tYXAoZnVuY3Rpb24odCl7CiAgICByZXR1cm4gJzxidXR0b24gZGF0YS10YWI9IicrdFswXSsnIiBjbGFzcz0iJysoY3VyVGFiPT09dFswXT8ib24iOiIiKSsnIj4nK3RbMV0rJzwvYnV0dG9uPic7CiAgfSkuam9pbigiIik7CiAgZG9jdW1lbnQucXVlcnlTZWxlY3RvckFsbCgiI3RhYnMgYnV0dG9uIikuZm9yRWFjaChmdW5jdGlvbihiKXsKICAgIGIub25jbGljaz1mdW5jdGlvbigpe2N1clRhYj1iLmRhdGFzZXQudGFiO3RyeXtsb2NhbFN0b3JhZ2Uuc2V0SXRlbSgiYWRtaW5fdGFiIixjdXJUYWIpO2hpc3RvcnkucmVwbGFjZVN0YXRlKG51bGwsIiIsIiMiK2N1clRhYik7fWNhdGNoKGUpe31yZW5kZXJUYWJzKCk7dmlld3NbY3VyVGFiXSgpO307CiAgfSk7Cn0KCgpmdW5jdGlvbiB0aWNrKCl7ZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoImNsb2NrIikudGV4dENvbnRlbnQ9bmV3IERhdGUoKS50b0xvY2FsZVN0cmluZygpO30Kc2V0SW50ZXJ2YWwodGljaywxMDAwKTt0aWNrKCk7CnJlbmRlclRhYnMoKTt2aWV3c1tjdXJUYWJdKCk7CnZpZXdzLm92ZXJ2aWV3KCk7CnNldEludGVydmFsKGZ1bmN0aW9uKCl7aWYoY3VyVGFiPT09Im92ZXJ2aWV3Iil2aWV3cy5vdmVydmlldygpO30sNjAwMDApOwo8L3NjcmlwdD4KPC9ib2R5Pgo8L2h0bWw+Cg==";
  // Decode base64 to string (handles UTF-8)
  const bin = atob(B64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
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
    // ─── Admin (hidden dashboard + API) ───
    if (pathname === '/z9-admin' || pathname === '/z9-admin/') {
      const auth = await requireAdmin(request, env);
      if (!auth.ok) return new Response('Admin: unauthorized (' + auth.reason + ')', { status: 401 });
      return new Response(dashboardHTML(), { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
    }
    if (pathname.startsWith('/z9-admin/api/')) {
      return adminApi(request, env, url, pathname, method);
    }
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
           return this.addTool(env, await getJsonBody(request), 'published');
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
    return cacheFetch(null, env, 'api-tools-v4?' + qs, 3600, async () => {
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
    return cacheFetch(null, env, 'api-categories-v3', 3600, async () => {
      const result = await env.DB.prepare(
        `SELECT category, COUNT(*) as tool_count
         FROM tools
         WHERE status = 'published' AND category IS NOT NULL AND category != ''
         GROUP BY category
         ORDER BY tool_count DESC`
      ).all();
      const merged = new Map();
      for (const row of (result.results || [])) {
        const category = canonicalCategory(row.category);
        merged.set(category, (merged.get(category) || 0) + Number(row.tool_count || 0));
      }
      const categories = [...merged.entries()]
        .map(([category, tool_count]) => ({ category, tool_count }))
        .sort((a, b) => b.tool_count - a.tool_count);
      return okResponse({ categories });
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
            `SELECT COUNT(DISTINCT CASE
              WHEN category IN ('Chat','AI Assistant','Assistants') THEN 'Assistants & Agents'
              WHEN category IN ('Coding','Open Source') THEN 'Coding & Dev'
              WHEN category IN ('Image','Design') THEN 'Design & Art'
              WHEN category = 'Video' THEN 'Video & Animation'
              WHEN category = 'Audio' THEN 'Voice & Sound'
              WHEN category IN ('Writing','Content') THEN 'Writing & Content'
              WHEN category IN ('Business','Productivity','Marketing') THEN 'Business & Productivity'
              WHEN category IN ('Analytics','Automation','Data') THEN 'Data & Automation'
              WHEN category IN ('Education','Research') THEN 'Education & Research'
              WHEN category IN ('AI Tools','') OR category IS NULL THEN 'Other'
              ELSE category END) AS c
             FROM tools WHERE status = 'published'`
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
    const name = String(body.name).trim().slice(0, 120);
    const url = String(body.url).trim().slice(0, 500);
    const description = String(body.short_desc || '').trim().slice(0, 500);
    const email = String(body.email || '').trim().slice(0, 200);
    if (!name || !validToolUrl(url) || (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))) {
      return jsonError('Please provide a valid name, HTTP(S) URL and email', 400);
    }
    const result = await env.DB.prepare(
      `INSERT INTO submitted_tools (name, url, category, short_desc, pricing, submitter_email)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).bind(
      name,
      url,
      canonicalCategory(body.category),
      description,
      ['free', 'freemium', 'paid'].includes(String(body.pricing || '').toLowerCase()) ? String(body.pricing).toLowerCase() : null,
      email
    ).run();

    const id = result.meta.last_row_id;

    if (env.TELEGRAM_BOT_TOKEN && env.ADMIN_TELEGRAM_ID) {
      const text =
        `🔧 New Tool Submitted!\n` +
        `Name: ${name}\n` +
        `URL: ${url}\n` +
        `Category: ${canonicalCategory(body.category)}`;
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
  async addTool(env, body, publicationStatus = 'pending') {
    if (!body || !body.name) {
      return jsonError('Name is required', 400);
    }
    const tool = { ...body };
    tool.name = String(tool.name).trim();
    tool.slug = slugify(tool.name);
    tool.url = String(tool.url || tool.website_url || '').trim();
    if (!tool.slug || tool.slug.length < 2 || !validToolUrl(tool.url)) {
      return jsonError('A valid tool name and HTTP(S) URL are required', 400);
    }
    const pricing = ['free', 'freemium', 'paid'].includes(String(tool.pricing || '').toLowerCase())
      ? String(tool.pricing).toLowerCase() : null;
    tool.category = canonicalCategory(tool.category);
    tool.pricing = pricing;

    const existing = await env.DB.prepare(
      `SELECT id, name, pricing, description, short_desc, category, url, tags, compatible_tools FROM tools WHERE slug = ? OR url = ?`
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
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`
    ).bind(
      tool.name,
      tool.slug,
      tool.description || '',
      tool.short_desc || '',
      tool.category || '',
      tool.pricing || null,
      tool.url || '',
      tool.logo_url || '',
      tool.logo_type || 'favicon',
      tool.tags || '',
      tool.compatible_tools || '',
      tool.views || 0,
      tool.votes || 0,
      tool.featured || 0,
      tag,
      publicationStatus === 'published' ? 'published' : 'pending'
    ).run();

    if (publicationStatus === 'published' && tag === 'regular') {
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
             pricing: submitted.pricing || null,
             url: submitted.url || ''
          };
          const addResult = await this.addTool(env, tool, 'published');
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
  },
  async scheduled(event, env, ctx) {
    if (event.cron === '*/5 * * * *') {
      ctx.waitUntil(seoEnrichCron(env));
    } else {
      ctx.waitUntil(handleCronTrigger(env));
    }
  }
};
