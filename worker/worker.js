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
// All /api/admin/* routes require either a valid Cloudflare Access JWT
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
  return { ok: true, username: u.username || '', plan: (u.plan || {}).id || '' };
}

async function apifyUsage(token) {
  try {
    const r = await fetch('https://api.apify.com/v2/users/me/usage/monthly', {
      headers: { 'Authorization': 'Bearer ' + token }
    });
    if (!r.ok) return { available: false };
    const d = await r.json();
    return { available: true, usage: d.data || d };
  } catch (e) { return { available: false }; }
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
  const sub = pathname.replace(/^\/api\/admin\//, '');
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
    const { slot, label, token, assigned_job, monthly_cap_usd } = body;
    if (!token) return json({ error: 'token required' }, 400);
    await env.DB.prepare(
      `INSERT INTO apify_keys (slot, label, token, assigned_job, monthly_cap_usd) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(slot) DO UPDATE SET label=excluded.label, token=excluded.token, assigned_job=excluded.assigned_job, monthly_cap_usd=excluded.monthly_cap_usd`
    ).bind(parseInt(slot) || 1, String(label || ''), String(token), String(assigned_job || 'ai-directory-scrape'), parseFloat(monthly_cap_usd) || 5).run();
    return json({ ok: true });
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
    ).bind(String(label || ''), String(base_url || 'https://app.manifest.build/v1'), String(api_key), parseInt(monthly_limit) || 1000).run();
    return json({ ok: true });
  }
  m = sub.match(/^manifest\/(\d+)\/test$/);
  if (m && method === 'POST') {
    const row = await env.DB.prepare(`SELECT base_url, api_key FROM manifest_endpoints WHERE id=?`).bind(m[1]).first();
    if (!row) return json({ error: 'not found' }, 404);
    return json(await manifestTest(row.base_url, row.api_key));
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
    let total = { c: 0 }, today = { c: 0 }, noFaq = { c: 0 };
    try { total = await env.DB.prepare(`SELECT COUNT(*) AS c FROM tools WHERE status='published'`).first(); } catch (e) {}
    try { today = await env.DB.prepare(`SELECT COUNT(*) AS c FROM tools WHERE status='published' AND created_at > datetime('now', '-1 day')`).first(); } catch (e) {}
    try { noFaq = await env.DB.prepare(`SELECT COUNT(*) AS c FROM tools WHERE status='published' AND (faq IS NULL OR faq='')`).first(); } catch (e) {}
    return json({ total_tools: total.c, added_24h: today.c, missing_faq: noFaq.c, time: new Date().toISOString() });
  }

  return json({ error: 'unknown admin route' }, 404);
}

// --- Dashboard HTML (served by the worker, same origin as the API) ---
function dashboardHTML() {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Admin — AI Directory</title>
<style>
:root{--bg:#0e0f12;--card:#17191f;--line:#262a33;--ink:#eef1f6;--muted:#9aa3b2;--amber:#E8940C;--ok:#3FBFA0;--bad:#e5484d}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:14px/1.5 system-ui,sans-serif}
header{padding:16px 24px;border-bottom:1px solid var(--line);display:flex;justify-content:space-between;align-items:center}
h1{font-size:18px;margin:0}main{max-width:1100px;margin:0 auto;padding:24px}
.tabs{display:flex;gap:8px;margin-bottom:20px;flex-wrap:wrap}
.tabs button{background:var(--card);color:var(--muted);border:1px solid var(--line);border-radius:8px;padding:8px 14px;cursor:pointer}
.tabs button.on{color:var(--ink);border-color:var(--amber)}
.card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:18px;margin-bottom:14px}
.slot{border:1px solid var(--line);border-radius:10px;padding:14px;margin-bottom:12px}
.slot h3{margin:0 0 10px;font-size:13px;color:var(--muted);text-transform:uppercase;letter-spacing:.06em}
.grid{display:grid;grid-template-columns:1fr 1fr;gap:10px}
label{font-size:11px;color:var(--muted);display:block;margin-bottom:4px}
input,select{width:100%;background:#0e0f12;border:1px solid var(--line);color:var(--ink);border-radius:8px;padding:9px 10px;font-size:13px}
.bar{height:8px;background:#0e0f12;border-radius:99px;overflow:hidden;margin:8px 0}
.bar i{display:block;height:100%;background:var(--ok)}
.bar.over i{background:var(--bad)}
.row{display:flex;gap:8px;align-items:center;margin-top:10px;flex-wrap:wrap}
button.b{background:var(--amber);color:#111;border:0;border-radius:8px;padding:9px 14px;font-weight:700;cursor:pointer;font-size:13px}
button.g{background:transparent;color:var(--ink);border:1px solid var(--line);border-radius:8px;padding:8px 12px;cursor:pointer;font-size:13px}
button.danger{color:var(--bad);border-color:var(--bad)}
.pill{font-size:11px;font-weight:800;border-radius:99px;padding:3px 10px}
.pill.ok{background:#12332b;color:var(--ok)}.pill.bad{background:#3a1416;color:var(--bad)}
.meta{font-size:12px;color:var(--muted)}
#log{white-space:pre-wrap;font-size:12px;color:var(--muted);max-height:300px;overflow:auto}
</style></head><body>
<header><h1>AI Directory — Admin</h1><span><input id="bk" type="password" placeholder="Setup key" style="width:140px;display:inline-block" oninput="localStorage.setItem('z9_bkey',this.value)"><span class="meta" id="clock"></span></span></header>
<main>
<div class="tabs">
<button data-t="overview" class="on">Overview</button>
<button data-t="apify">Apify keys</button>
<button data-t="manifest">Manifest</button>
<button data-t="runs">Pipeline runs</button>
<button data-t="actions">Actions</button>
</div>
<div id="view"></div>
<div class="card"><h3 style="margin-top:0">Log</h3><div id="log"></div></div>
</main>
<script>
const V = document.getElementById('view'), LOG = document.getElementById('log');
const log = (m) => { LOG.textContent += new Date().toLocaleTimeString() + ' ' + m + '\\n'; LOG.scrollTop = 1e6; };
function bkey() { return localStorage.getItem('z9_bkey') || ''; }
async function api(path, method, body) {
  const h = { 'Content-Type': 'application/json' };
  if (bkey()) h['X-Bootstrap-Key'] = bkey();
  const r = await fetch('/api/admin/' + path, { method: method || 'GET',
    headers: h, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || ('HTTP ' + r.status));
  return j;
}
const views = {
  async overview() {
    const s = await api('stats');
    V.innerHTML = '<div class="card"><h3 style="margin-top:0">Site</h3><div class="grid">'
      + '<div><label>Total published tools</label><div style="font-size:26px;font-weight:800">' + s.total_tools + '</div></div>'
      + '<div><label>Added last 24h</label><div style="font-size:26px;font-weight:800">' + s.added_24h + '</div></div>'
      + '<div><label>Missing FAQ (enrichment queue)</label><div style="font-size:26px;font-weight:800">' + s.missing_faq + '</div></div>'
      + '<div><label>Worker time</label><div class="meta">' + s.time + '</div></div></div></div>';
  },
  async apify() {
    const d = await api('apify-keys');
    let h = '<div class="card"><h3 style="margin-top:0">Apify keys (slots)</h3>';
    d.keys.forEach((k) => {
      h += '<div class="slot" data-id="' + k.id + '"><h3>Slot ' + k.slot + ' <span class="pill ' + (k.enabled ? 'ok' : 'bad') + '">' + (k.enabled ? 'active' : 'disabled') + '</span></h3>'
        + '<div class="grid"><div><label>Label</label><input data-f="label" value="' + esc(k.label) + '"></div>'
        + '<div><label>API Token</label><input data-f="token" type="password" placeholder="Stored ' + esc(k.token) + ' — type to replace"></div>'
        + '<div><label>Assigned job</label><input data-f="assigned_job" value="' + esc(k.assigned_job) + '"></div>'
        + '<div><label>Monthly cap USD</label><input data-f="monthly_cap_usd" type="number" step="0.5" value="' + k.monthly_cap_usd + '"></div></div>'
        + '<div class="bar" id="bar-' + k.id + '"><i style="width:0%"></i></div><div class="meta" id="use-' + k.id + '">usage not loaded</div>'
        + '<div class="row"><button class="g" onclick="saveApify(' + k.id + ',' + k.slot + ')">Save</button>'
        + '<button class="g" onclick="testApify(' + k.id + ')">Test</button>'
        + '<button class="g" onclick="usageApify(' + k.id + ')">Check usage</button>'
        + '<button class="g danger" onclick="delApify(' + k.id + ')">Remove</button></div></div>';
    });
    h += '<div class="slot"><h3>+ New slot</h3><div class="grid">'
      + '<div><label>Slot #</label><input id="nk-slot" type="number" value="' + (d.keys.length + 1) + '"></div>'
      + '<div><label>Label</label><input id="nk-label" placeholder="my-key"></div>'
      + '<div><label>API Token</label><input id="nk-token" type="password"></div>'
      + '<div><label>Monthly cap USD</label><input id="nk-cap" type="number" step="0.5" value="5"></div></div>'
      + '<div class="row"><button class="b" onclick="addApify()">Add key</button></div></div></div>';
    V.innerHTML = h;
  },
  async manifest() {
    const d = await api('manifest');
    let h = '<div class="card"><h3 style="margin-top:0">Manifest endpoints (LLM router)</h3><div class="meta">Pipeline uses the enabled endpoint with remaining monthly quota (rollover).</div>';
    d.endpoints.forEach((e) => {
      const pct = e.monthly_limit ? Math.round(100 * e.used_this_month / e.monthly_limit) : 0;
      h += '<div class="slot"><h3>' + esc(e.label || ('Endpoint ' + e.id)) + ' <span class="pill ' + (e.enabled ? 'ok' : 'bad') + '">' + (e.enabled ? 'active' : 'disabled') + '</span></h3>'
        + '<div class="meta">' + esc(e.base_url) + ' · key ' + esc(e.api_key) + '</div>'
        + '<div class="bar' + (pct >= 100 ? ' over' : '') + '"><i style="width:' + Math.min(100, pct) + '%"></i></div>'
        + '<div class="meta">' + e.used_this_month + ' / ' + e.monthly_limit + ' used (' + pct + '%)</div>'
        + '<div class="row"><button class="g" onclick="testManifest(' + e.id + ')">Test</button>'
        + '<button class="g danger" onclick="delManifest(' + e.id + ')">Remove</button></div></div>';
    });
    h += '<div class="slot"><h3>+ New endpoint</h3><div class="grid">'
      + '<div><label>Label</label><input id="nm-label" placeholder="main"></div>'
      + '<div><label>Base URL</label><input id="nm-url" value="https://app.manifest.build/v1"></div>'
      + '<div><label>API Key</label><input id="nm-key" type="password"></div>'
      + '<div><label>Monthly limit (requests)</label><input id="nm-limit" type="number" value="1000"></div></div>'
      + '<div class="row"><button class="b" onclick="addManifest()">Add endpoint</button></div></div></div>';
    V.innerHTML = h;
  },
  async runs() {
    const d = await api('pipeline/runs');
    let h = '<div class="card"><h3 style="margin-top:0">Recent runs</h3>';
    (d.github_runs || []).forEach((r) => {
      h += '<div class="meta">#' + r.id + ' · ' + r.head_sha + ' · ' + r.status + '/' + (r.conclusion || '…') + ' · ' + r.created_at + '</div>';
    });
    h += '</div>';
    V.innerHTML = h;
  },
  async actions() {
    V.innerHTML = '<div class="card"><h3 style="margin-top:0">Actions</h3><div class="row">'
      + '<button class="b" onclick="doDispatch()">Dispatch pipeline now</button>'
      + '<button class="g" onclick="doTg()">Send Telegram test</button></div>'
      + '<div class="meta" style="margin-top:8px">Dispatch triggers the GitHub Actions pipeline immediately (same as the 6am/6pm cron).</div></div>';
  }
};
function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }
document.querySelectorAll('.tabs button').forEach((b) => b.onclick = () => {
  document.querySelectorAll('.tabs button').forEach((x) => x.classList.remove('on'));
  b.classList.add('on'); views[b.dataset.t]().catch((e) => log('ERR ' + e.message));
});
window.saveApify = async (id, slot) => {
  const sl = document.querySelector('.slot[data-id="' + id + '"]');
  const g = (f) => sl.querySelector('[data-f="' + f + '"]').value;
  if (!g('token')) { log('Token unchanged — only label/job/cap saved when a new token is typed.'); return; }
  await api('apify-keys', 'POST', { slot: slot, label: g('label'), token: g('token'), assigned_job: g('assigned_job'), monthly_cap_usd: g('monthly_cap_usd') });
  log('Saved slot.'); views.apify();
};
window.addApify = async () => {
  const v = (id) => document.getElementById(id).value;
  if (!v('nk-token')) return log('Token required.');
  await api('apify-keys', 'POST', { slot: v('nk-slot'), label: v('nk-label'), token: v('nk-token'), monthly_cap_usd: v('nk-cap') });
  log('Key added.'); views.apify();
};
window.delApify = async (id) => { if (confirm('Remove this key?')) { await fetch('/api/admin/apify-keys/' + id, { method: 'DELETE' }); log('Removed.'); views.apify(); } };
window.testApify = async (id) => { log('Testing…'); const r = await api('apify-keys/' + id + '/test', 'POST'); log(r.ok ? 'OK: ' + r.username + ' (' + r.plan + ')' : 'FAILED: HTTP ' + r.status); };
window.usageApify = async (id) => {
  const r = await api('apify-keys/' + id + '/usage');
  document.getElementById('use-' + id).textContent = r.available ? JSON.stringify(r.usage).slice(0, 200) : 'Live usage unavailable — monthly cap is the source of truth.';
  log('Usage checked.');
};
window.addManifest = async () => {
  const v = (id) => document.getElementById(id).value;
  if (!v('nm-key')) return log('API key required.');
  await api('manifest', 'POST', { label: v('nm-label'), base_url: v('nm-url'), api_key: v('nm-key'), monthly_limit: v('nm-limit') });
  log('Endpoint added.'); views.manifest();
};
window.delManifest = async (id) => { if (confirm('Remove this endpoint?')) { await fetch('/api/admin/manifest/' + id, { method: 'DELETE' }); log('Removed.'); views.manifest(); } };
window.testManifest = async (id) => { log('Testing…'); const r = await api('manifest/' + id + '/test', 'POST'); log(r.ok ? 'OK (' + r.status + ')' : 'FAILED: HTTP ' + r.status + ' ' + (r.sample || '')); };
window.doDispatch = async () => { const r = await api('pipeline/dispatch', 'POST'); log(r.ok ? 'Dispatched.' : 'Dispatch failed: ' + r.status); };
window.doTg = async () => { const r = await api('telegram/test', 'POST'); log(r.ok ? 'Telegram test sent.' : 'Telegram failed.'); };
setInterval(() => { document.getElementById('clock').textContent = new Date().toLocaleString(); }, 1000);
document.getElementById('bk').value = bkey();
views.overview().catch((e) => { V.innerHTML = '<div class="card"><span style="color:var(--bad)">Auth required.</span><div class="meta">' + esc(e.message) + '</div><div class="meta">Enter the setup key above (one-time), or protect this page with a Cloudflare Access application.</div></div>'; });
</script></body></html>`;
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
    if (pathname.startsWith('/api/admin/')) {
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
    ctx.waitUntil(handleCronTrigger(env));
  }
};
