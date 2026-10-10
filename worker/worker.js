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
  const B64 = "PCFkb2N0eXBlIGh0bWw+CjxodG1sIGxhbmc9ImVuIj4KPGhlYWQ+CjxtZXRhIGNoYXJzZXQ9InV0Zi04Ij4KPG1ldGEgbmFtZT0idmlld3BvcnQiIGNvbnRlbnQ9IndpZHRoPWRldmljZS13aWR0aCxpbml0aWFsLXNjYWxlPTEiPgo8dGl0bGU+QWRtaW4g4oCUIEFJIERpcmVjdG9yeTwvdGl0bGU+CjxzdHlsZT4KOnJvb3R7LS1iZzojZjZmN2ZiOy0tY2FyZDojZmZmOy0tbGluZTojZThlYWYxOy0taW5rOiMxYTFkMjk7LS1tdXQ6IzZiNzI4MDstLWFtOiNFODk0MEM7LS1vazojMTBiOTgxOy0tYmFkOiNlZjQ0NDQ7LS1ibDojM2I4MmY2Oy0tcHU6IzhiNWNmNn0KKntib3gtc2l6aW5nOmJvcmRlci1ib3g7bWFyZ2luOjA7cGFkZGluZzowfQpib2R5e2JhY2tncm91bmQ6dmFyKC0tYmcpO2NvbG9yOnZhcigtLWluayk7Zm9udDoxNHB4LzEuNSBzeXN0ZW0tdWksLWFwcGxlLXN5c3RlbSxzYW5zLXNlcmlmO21pbi1oZWlnaHQ6MTAwdmh9CmhlYWRlcntiYWNrZ3JvdW5kOmxpbmVhci1ncmFkaWVudCgxMzVkZWcsIzFhMWQyOSwjMmQzMTQyKTtjb2xvcjojZmZmO3BhZGRpbmc6MTRweCAyNHB4O2Rpc3BsYXk6ZmxleDtqdXN0aWZ5LWNvbnRlbnQ6c3BhY2UtYmV0d2VlbjthbGlnbi1pdGVtczpjZW50ZXI7cG9zaXRpb246c3RpY2t5O3RvcDowO3otaW5kZXg6MTB9CmhlYWRlciBoMXtmb250LXNpemU6MTdweDtmb250LXdlaWdodDo3MDB9CmhlYWRlciAucmlnaHR7ZGlzcGxheTpmbGV4O2dhcDoxMHB4O2FsaWduLWl0ZW1zOmNlbnRlcn0KLmRvdHt3aWR0aDo5cHg7aGVpZ2h0OjlweDtib3JkZXItcmFkaXVzOjUwJTtiYWNrZ3JvdW5kOnZhcigtLW9rKTtkaXNwbGF5OmlubGluZS1ibG9jazthbmltYXRpb246cHVsc2UgMnMgaW5maW5pdGV9CkBrZXlmcmFtZXMgcHVsc2V7MCUsMTAwJXtvcGFjaXR5OjF9NTAle29wYWNpdHk6LjR9fQojYmt7YmFja2dyb3VuZDojZmZmZmZmMjI7Ym9yZGVyOjFweCBzb2xpZCAjZmZmZmZmMzM7Y29sb3I6I2ZmZjtib3JkZXItcmFkaXVzOjhweDtwYWRkaW5nOjdweCAxMHB4O2ZvbnQtc2l6ZToxMnB4O3dpZHRoOjEzMHB4fQojYms6OnBsYWNlaG9sZGVye2NvbG9yOiNmZmZmZmY4OH0KI2Nsb2Nre2ZvbnQtc2l6ZToxMnB4O2NvbG9yOiNmZmZmZmZhYX0KbWFpbnttYXgtd2lkdGg6MTE1MHB4O21hcmdpbjowIGF1dG87cGFkZGluZzoyMnB4fQoudGFic3tkaXNwbGF5OmZsZXg7Z2FwOjhweDttYXJnaW4tYm90dG9tOjE4cHg7ZmxleC13cmFwOndyYXB9Ci50YWJzIGJ1dHRvbntiYWNrZ3JvdW5kOnZhcigtLWNhcmQpO2JvcmRlcjoxcHggc29saWQgdmFyKC0tbGluZSk7Ym9yZGVyLXJhZGl1czoxMHB4O3BhZGRpbmc6OXB4IDE1cHg7Zm9udC1zaXplOjEzcHg7Zm9udC13ZWlnaHQ6NjAwO2NvbG9yOnZhcigtLW11dCk7Y3Vyc29yOnBvaW50ZXI7dHJhbnNpdGlvbjphbGwgLjE1c30KLnRhYnMgYnV0dG9uOmhvdmVye2JvcmRlci1jb2xvcjp2YXIoLS1hbSk7Y29sb3I6dmFyKC0taW5rKX0KLnRhYnMgYnV0dG9uLm9ue2JhY2tncm91bmQ6dmFyKC0taW5rKTtjb2xvcjojZmZmO2JvcmRlci1jb2xvcjp2YXIoLS1pbmspfQouY2FyZHtiYWNrZ3JvdW5kOnZhcigtLWNhcmQpO2JvcmRlcjoxcHggc29saWQgdmFyKC0tbGluZSk7Ym9yZGVyLXJhZGl1czoxNHB4O3BhZGRpbmc6MjBweDttYXJnaW4tYm90dG9tOjE0cHg7YW5pbWF0aW9uOnJpc2UgLjNzIGVhc2V9CkBrZXlmcmFtZXMgcmlzZXtmcm9te29wYWNpdHk6MDt0cmFuc2Zvcm06dHJhbnNsYXRlWSg4cHgpfXRve29wYWNpdHk6MTt0cmFuc2Zvcm06bm9uZX19Ci5jYXJkIGgye2ZvbnQtc2l6ZToxNXB4O21hcmdpbi1ib3R0b206MnB4fQouc3Vie2ZvbnQtc2l6ZToxMnB4O2NvbG9yOnZhcigtLW11dCk7bWFyZ2luLWJvdHRvbToxNHB4fQoua3Bpc3tkaXNwbGF5OmdyaWQ7Z3JpZC10ZW1wbGF0ZS1jb2x1bW5zOnJlcGVhdCg0LDFmcik7Z2FwOjEycHh9CkBtZWRpYShtYXgtd2lkdGg6ODAwcHgpey5rcGlze2dyaWQtdGVtcGxhdGUtY29sdW1uczpyZXBlYXQoMiwxZnIpfX0KLmtwaXtib3JkZXItcmFkaXVzOjEycHg7cGFkZGluZzoxNnB4O2NvbG9yOiNmZmY7cG9zaXRpb246cmVsYXRpdmU7b3ZlcmZsb3c6aGlkZGVufQoua3BpIC5sYntmb250LXNpemU6MTFweDtmb250LXdlaWdodDo3MDA7bGV0dGVyLXNwYWNpbmc6LjA1ZW07dGV4dC10cmFuc2Zvcm06dXBwZXJjYXNlO29wYWNpdHk6Ljg1fQoua3BpIC52bHtmb250LXNpemU6MzBweDtmb250LXdlaWdodDo4MDA7bWFyZ2luOjRweCAwfQoua3BpIC50cntmb250LXNpemU6MTFweDtvcGFjaXR5Oi44fQouazF7YmFja2dyb3VuZDpsaW5lYXItZ3JhZGllbnQoMTM1ZGVnLCNmNTllMGIsI2Q5NzcwNil9Ci5rMntiYWNrZ3JvdW5kOmxpbmVhci1ncmFkaWVudCgxMzVkZWcsIzNiODJmNiwjMWQ0ZWQ4KX0KLmsze2JhY2tncm91bmQ6bGluZWFyLWdyYWRpZW50KDEzNWRlZywjMTBiOTgxLCMwNDc4NTcpfQouazR7YmFja2dyb3VuZDpsaW5lYXItZ3JhZGllbnQoMTM1ZGVnLCM4YjVjZjYsIzZkMjhkOSl9Ci5zbG90e2JvcmRlcjoxcHggc29saWQgdmFyKC0tbGluZSk7Ym9yZGVyLXJhZGl1czoxMnB4O3BhZGRpbmc6MTZweDttYXJnaW4tYm90dG9tOjEycHg7YmFja2dyb3VuZDojZmZmfQouc2xvdC10b3B7ZGlzcGxheTpmbGV4O2dhcDo4cHg7YWxpZ24taXRlbXM6Y2VudGVyO21hcmdpbi1ib3R0b206MTBweDtmbGV4LXdyYXA6d3JhcH0KLmJhZGdle2ZvbnQtc2l6ZToxMHB4O2ZvbnQtd2VpZ2h0OjgwMDtib3JkZXItcmFkaXVzOjk5cHg7cGFkZGluZzozcHggMTBweDtsZXR0ZXItc3BhY2luZzouMDRlbX0KLmJhZGdlLm9ue2JhY2tncm91bmQ6I2QxZmFlNTtjb2xvcjojMDQ3ODU3fQouYmFkZ2Uub2Zme2JhY2tncm91bmQ6I2ZlZTJlMjtjb2xvcjojYjkxYzFjfQouYmFkZ2Uuam9ie2JhY2tncm91bmQ6I2ZlZjNjNztjb2xvcjojOTI0MDBlfQouYmFkZ2Uucm91dGVye2JhY2tncm91bmQ6I2RiZWFmZTtjb2xvcjojMWQ0ZWQ4fQoudG9re2ZvbnQtc2l6ZToxMXB4O2NvbG9yOnZhcigtLW11dCk7Zm9udC1mYW1pbHk6bW9ub3NwYWNlO2JhY2tncm91bmQ6I2YzZjRmNjtwYWRkaW5nOjNweCA4cHg7Ym9yZGVyLXJhZGl1czo2cHh9Ci5mMntkaXNwbGF5OmdyaWQ7Z3JpZC10ZW1wbGF0ZS1jb2x1bW5zOjFmciAxZnI7Z2FwOjEwcHg7bWFyZ2luLWJvdHRvbToxMHB4fQpAbWVkaWEobWF4LXdpZHRoOjYwMHB4KXsuZjJ7Z3JpZC10ZW1wbGF0ZS1jb2x1bW5zOjFmcn19CmxhYmVse2ZvbnQtc2l6ZToxMXB4O2ZvbnQtd2VpZ2h0OjYwMDtjb2xvcjp2YXIoLS1tdXQpO2Rpc3BsYXk6YmxvY2s7bWFyZ2luLWJvdHRvbTo0cHg7dGV4dC10cmFuc2Zvcm06dXBwZXJjYXNlO2xldHRlci1zcGFjaW5nOi4wNGVtfQppbnB1dCxzZWxlY3R7d2lkdGg6MTAwJTtiYWNrZ3JvdW5kOiNmZmY7Ym9yZGVyOjFweCBzb2xpZCB2YXIoLS1saW5lKTtib3JkZXItcmFkaXVzOjhweDtwYWRkaW5nOjlweCAxMHB4O2ZvbnQtc2l6ZToxM3B4O2NvbG9yOnZhcigtLWluayl9CmlucHV0OmZvY3VzLHNlbGVjdDpmb2N1c3tvdXRsaW5lOm5vbmU7Ym9yZGVyLWNvbG9yOnZhcigtLWFtKX0KLnByb2d7aGVpZ2h0OjlweDtiYWNrZ3JvdW5kOiNmM2Y0ZjY7Ym9yZGVyLXJhZGl1czo5OXB4O292ZXJmbG93OmhpZGRlbjttYXJnaW46MTBweCAwIDZweH0KLnByb2cgaXtkaXNwbGF5OmJsb2NrO2hlaWdodDoxMDAlO2JhY2tncm91bmQ6bGluZWFyLWdyYWRpZW50KDkwZGVnLHZhcigtLW9rKSwjMzRkMzk5KTtib3JkZXItcmFkaXVzOjk5cHg7dHJhbnNpdGlvbjp3aWR0aCAuNnMgZWFzZX0KLnByb2cub3ZlciBpe2JhY2tncm91bmQ6bGluZWFyLWdyYWRpZW50KDkwZGVnLHZhcigtLWJhZCksI2Y4NzE3MSl9Ci5tZXRhe2ZvbnQtc2l6ZToxMnB4O2NvbG9yOnZhcigtLW11dCl9Ci5idG5yb3d7ZGlzcGxheTpmbGV4O2dhcDo4cHg7bWFyZ2luLXRvcDoxMnB4O2ZsZXgtd3JhcDp3cmFwfQouYnRue2JhY2tncm91bmQ6I2ZmZjtib3JkZXI6MXB4IHNvbGlkIHZhcigtLWxpbmUpO2JvcmRlci1yYWRpdXM6OHB4O3BhZGRpbmc6OHB4IDE0cHg7Zm9udC1zaXplOjEzcHg7Zm9udC13ZWlnaHQ6NjAwO2N1cnNvcjpwb2ludGVyO2NvbG9yOnZhcigtLWluayl9Ci5idG46aG92ZXJ7Ym9yZGVyLWNvbG9yOnZhcigtLWFtKX0KLmJ0bi5kYXJre2JhY2tncm91bmQ6dmFyKC0taW5rKTtjb2xvcjojZmZmO2JvcmRlci1jb2xvcjp2YXIoLS1pbmspfQouYnRuLmRhbmdlcntjb2xvcjp2YXIoLS1iYWQpO2JvcmRlci1jb2xvcjojZmVjYWNhfQouYnRuLmRhbmdlcjpob3Zlcntib3JkZXItY29sb3I6dmFyKC0tYmFkKX0KLmhpbnR7YmFja2dyb3VuZDojZmZmYmViO2JvcmRlcjoxcHggc29saWQgI2ZkZTY4YTtib3JkZXItcmFkaXVzOjEwcHg7cGFkZGluZzoxMnB4IDE0cHg7Zm9udC1zaXplOjEzcHg7bWFyZ2luLWJvdHRvbToxMnB4fQoud2FybmJveHtiYWNrZ3JvdW5kOiNmZWYyZjI7Ym9yZGVyOjFweCBzb2xpZCAjZmVjYWNhO2JvcmRlci1yYWRpdXM6MTBweDtwYWRkaW5nOjEycHggMTRweDtmb250LXNpemU6MTNweDttYXJnaW46MTBweCAwO2Rpc3BsYXk6YmxvY2t9Ci50aW1lbGluZXtwb3NpdGlvbjpyZWxhdGl2ZTtwYWRkaW5nLWxlZnQ6MjJweH0KLnRpbWVsaW5lOjpiZWZvcmV7Y29udGVudDoiIjtwb3NpdGlvbjphYnNvbHV0ZTtsZWZ0OjdweDt0b3A6NnB4O2JvdHRvbTo2cHg7d2lkdGg6MnB4O2JhY2tncm91bmQ6dmFyKC0tbGluZSl9Ci50bC1pdGVte3Bvc2l0aW9uOnJlbGF0aXZlO3BhZGRpbmc6OHB4IDAgOHB4IDhweH0KLnRsLWl0ZW06OmJlZm9yZXtjb250ZW50OiIiO3Bvc2l0aW9uOmFic29sdXRlO2xlZnQ6LTE5cHg7dG9wOjEzcHg7d2lkdGg6MTBweDtoZWlnaHQ6MTBweDtib3JkZXItcmFkaXVzOjUwJTtiYWNrZ3JvdW5kOnZhcigtLW11dCl9Ci50bC1pdGVtLm9rOjpiZWZvcmV7YmFja2dyb3VuZDp2YXIoLS1vayl9Ci50bC1pdGVtLmJhZDo6YmVmb3Jle2JhY2tncm91bmQ6dmFyKC0tYmFkKX0KLnRsLWl0ZW0ucnVuOjpiZWZvcmV7YmFja2dyb3VuZDp2YXIoLS1hbSk7YW5pbWF0aW9uOnB1bHNlIDEuNXMgaW5maW5pdGV9Ci5zcGFya3tkaXNwbGF5OmZsZXg7YWxpZ24taXRlbXM6ZmxleC1lbmQ7Z2FwOjNweDtoZWlnaHQ6OTBweDttYXJnaW46MTRweCAwfQouc3BhcmsgaXtmbGV4OjE7YmFja2dyb3VuZDpsaW5lYXItZ3JhZGllbnQoMTgwZGVnLHZhcigtLWFtKSwjZmJiZjI0KTtib3JkZXItcmFkaXVzOjNweCAzcHggMCAwO21pbi1oZWlnaHQ6NnB4fQouYWN0c3tkaXNwbGF5OmdyaWQ7Z3JpZC10ZW1wbGF0ZS1jb2x1bW5zOnJlcGVhdCgyLDFmcik7Z2FwOjEycHh9CkBtZWRpYShtYXgtd2lkdGg6NjAwcHgpey5hY3Rze2dyaWQtdGVtcGxhdGUtY29sdW1uczoxZnJ9fQouYWN0e2JvcmRlcjoxcHggc29saWQgdmFyKC0tbGluZSk7Ym9yZGVyLXJhZGl1czoxMnB4O3BhZGRpbmc6MTZweDtjdXJzb3I6cG9pbnRlcjt0cmFuc2l0aW9uOmFsbCAuMTVzO2JhY2tncm91bmQ6I2ZmZn0KLmFjdDpob3Zlcntib3JkZXItY29sb3I6dmFyKC0tYW0pO3RyYW5zZm9ybTp0cmFuc2xhdGVZKC0ycHgpO2JveC1zaGFkb3c6MCA0cHggMTRweCAjMDAwMX0KLmFjdCAuZXtmb250LXNpemU6MjRweDttYXJnaW4tYm90dG9tOjZweH0KLmFjdCBie2Rpc3BsYXk6YmxvY2s7Zm9udC1zaXplOjE0cHg7bWFyZ2luLWJvdHRvbToycHh9Ci5hY3Qgc3Bhbntmb250LXNpemU6MTJweDtjb2xvcjp2YXIoLS1tdXQpfQojbG9ne2JhY2tncm91bmQ6IzFhMWQyOTtjb2xvcjojYTdmM2QwO2JvcmRlci1yYWRpdXM6MTJweDtwYWRkaW5nOjE0cHg7Zm9udC1mYW1pbHk6bW9ub3NwYWNlO2ZvbnQtc2l6ZToxMnB4O3doaXRlLXNwYWNlOnByZS13cmFwO21heC1oZWlnaHQ6MjIwcHg7b3ZlcmZsb3c6YXV0b30KPC9zdHlsZT4KPC9oZWFkPgo8Ym9keT4KPGhlYWRlcj4KPGgxPjxzcGFuIGNsYXNzPSJkb3QiPjwvc3Bhbj4gQUkgRGlyZWN0b3J5IOKAlCBBZG1pbjwvaDE+CjxkaXYgY2xhc3M9InJpZ2h0Ij4KPGlucHV0IGlkPSJiayIgdHlwZT0icGFzc3dvcmQiIHBsYWNlaG9sZGVyPSJTZXR1cCBrZXkiPgo8c3BhbiBpZD0iY2xvY2siPjwvc3Bhbj4KPC9kaXY+CjwvaGVhZGVyPgo8bWFpbj4KPGRpdiBjbGFzcz0idGFicyIgaWQ9InRhYnMiPjwvZGl2Pgo8ZGl2IGlkPSJ2aWV3Ij48L2Rpdj4KPGRpdiBjbGFzcz0iY2FyZCI+PGgyPvCfk4sgTG9nPC9oMj48ZGl2IGNsYXNzPSJzdWIiPlJlY2VudCBhY3Rpb25zPC9kaXY+PGRpdiBpZD0ibG9nIj48L2Rpdj48L2Rpdj4KPC9tYWluPgo8c2NyaXB0PgoidXNlIHN0cmljdCI7CmNvbnN0IFYgPSBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgidmlldyIpOwpjb25zdCBUQUJTID0gW1sib3ZlcnZpZXciLCLwn5OKIE92ZXJ2aWV3Il0sWyJhcGlmeSIsIvCflJEgQXBpZnkga2V5cyJdLFsibWFuaWZlc3QiLCLwn6SWIE1hbmlmZXN0Il0sWyJydW5zIiwi8J+UhCBQaXBlbGluZSBydW5zIl0sWyJ0cmFmZmljIiwi8J+TiCBUcmFmZmljIl0sWyJhY3Rpb25zIiwi4pqZ77iPIEFjdGlvbnMiXV07CmNvbnN0IEpPQl9TSVRFUyA9IHsidG9vbGlmeS1kYWlseSI6WyJ0b29saWZ5LmFpIl0sInRhYWZ0LWRhaWx5IjpbInRoZXJlc2FuYWlmb3J0aGF0LmNvbSJdLCJsb25ndGFpbC13ZWVrbHkiOlsiZnV0dXJlcGVkaWEuaW8iLCJmdXR1cmV0b29scy5pbyIsInRvcGFpLnRvb2xzIiwiYmV5b25kdG9vbHMuaW8iLCJ0b29sZmsuY29tIl0sIm90aGVyIjpbXX07CmNvbnN0IEpPQlMgPSBbInRvb2xpZnktZGFpbHkiLCJ0YWFmdC1kYWlseSIsImxvbmd0YWlsLXdlZWtseSIsIm90aGVyIl07CmNvbnN0IFNMT1RfSk9CUyA9IHsxOiJ0b29saWZ5LWRhaWx5IiwyOiJ0YWFmdC1kYWlseSIsMzoibG9uZ3RhaWwtd2Vla2x5In07CgpmdW5jdGlvbiBlc2Mocyl7cmV0dXJuIFN0cmluZyhzPT1udWxsPyIiOnMpLnJlcGxhY2UoL1smPD4iJ10vZyxmdW5jdGlvbihjKXtyZXR1cm4geyImIjoiJmFtcDsiLCI8IjoiJmx0OyIsIj4iOiImZ3Q7IiwnIic6IiZxdW90OyIsIiciOiImIzM5OyJ9W2NdO30pO30KZnVuY3Rpb24gbG9nKG0pe3ZhciBlbD1kb2N1bWVudC5nZXRFbGVtZW50QnlJZCgibG9nIik7dmFyIHQ9bmV3IERhdGUoKS50b0xvY2FsZVRpbWVTdHJpbmcoKTtlbC50ZXh0Q29udGVudD0iWyIrdCsiXSAiK20rIlxuIitlbC50ZXh0Q29udGVudDt9CmZ1bmN0aW9uIGNvdW50VXAoZWwsdG8pe2lmKCFlbClyZXR1cm47dmFyIGZyb209MDt2YXIgc3Q9bnVsbDtmdW5jdGlvbiBmKHRzKXtpZighc3Qpc3Q9dHM7dmFyIHA9TWF0aC5taW4oMSwodHMtc3QpLzkwMCk7ZWwudGV4dENvbnRlbnQ9TWF0aC5yb3VuZChmcm9tKyh0by1mcm9tKSpwKS50b0xvY2FsZVN0cmluZygpO2lmKHA8MSlyZXF1ZXN0QW5pbWF0aW9uRnJhbWUoZik7fXJlcXVlc3RBbmltYXRpb25GcmFtZShmKTt9CmZ1bmN0aW9uIHRpbWVBZ28ocyl7aWYoIXMpcmV0dXJuIuKAlCI7dmFyIGQ9KERhdGUubm93KCktbmV3IERhdGUocykuZ2V0VGltZSgpKS8xZTM7aWYoZDw2MClyZXR1cm4ianVzdCBub3ciO2lmKGQ8MzYwMClyZXR1cm4gTWF0aC5mbG9vcihkLzYwKSsibSBhZ28iO2lmKGQ8ODY0MDApcmV0dXJuIE1hdGguZmxvb3IoZC8zNjAwKSsiaCBhZ28iO3JldHVybiBNYXRoLmZsb29yKGQvODY0MDApKyJkIGFnbyI7fQphc3luYyBmdW5jdGlvbiBhcGkocGF0aCxvcHRzKXsKICBvcHRzPW9wdHN8fHt9OwogIHZhciBoZWFkZXJzPXsiQ29udGVudC1UeXBlIjoiYXBwbGljYXRpb24vanNvbiJ9OwogIHZhciBiaz1kb2N1bWVudC5nZXRFbGVtZW50QnlJZCgiYmsiKS52YWx1ZXx8bG9jYWxTdG9yYWdlLmdldEl0ZW0oIno5X2JrZXkiKXx8IiI7CiAgaWYoYmspaGVhZGVyc1siWC1TZXR1cC1LZXkiXT1iazsKICB2YXIgcj1hd2FpdCBmZXRjaCgiL3o5LWFkbWluL2FwaS8iK3BhdGgsT2JqZWN0LmFzc2lnbih7aGVhZGVyczpoZWFkZXJzfSxvcHRzKSk7CiAgaWYoIXIub2spdGhyb3cgbmV3IEVycm9yKCJBUEkgIityLnN0YXR1cyk7CiAgcmV0dXJuIHIuanNvbigpOwp9Cgp2YXIgdmlld3M9ewphc3luYyBvdmVydmlldygpewogIFYuaW5uZXJIVE1MPSc8ZGl2IGNsYXNzPSJjYXJkIj48aDI+QXQgYSBnbGFuY2U8L2gyPjxkaXYgY2xhc3M9InN1YiI+TGl2ZSBkYXRhIMK3IGF1dG8tcmVmcmVzaGVzIGV2ZXJ5IDYwczwvZGl2PjxkaXYgY2xhc3M9ImtwaXMiPicKICArJzxkaXYgY2xhc3M9ImtwaSBrMSI+PGRpdiBjbGFzcz0ibGIiPkFJIHRvb2xzIGluZGV4ZWQ8L2Rpdj48ZGl2IGNsYXNzPSJ2bCIgaWQ9ImtwaS10b29scyI+4oCmPC9kaXY+PGRpdiBjbGFzcz0idHIiIGlkPSJrcGktdG9vbHMtdHIiPjwvZGl2PjwvZGl2PicKICArJzxkaXYgY2xhc3M9ImtwaSBrMiI+PGRpdiBjbGFzcz0ibGIiPkZyZWUgYnJvd3NlciB0b29sczwvZGl2PjxkaXYgY2xhc3M9InZsIiBpZD0ia3BpLWZyZWUiPuKApjwvZGl2PjxkaXYgY2xhc3M9InRyIj7ilrIgMTE5IGFkZGVkIE9jdCAyMDI2PC9kaXY+PC9kaXY+JwogICsnPGRpdiBjbGFzcz0ia3BpIGszIj48ZGl2IGNsYXNzPSJsYiI+VmlzaXRvcnMgKDdkKTwvZGl2PjxkaXYgY2xhc3M9InZsIiBpZD0ia3BpLXZpcyI+4oCmPC9kaXY+PGRpdiBjbGFzcz0idHIiIGlkPSJrcGktdmlzLXRyIj48L2Rpdj48L2Rpdj4nCiAgKyc8ZGl2IGNsYXNzPSJrcGkgazQiPjxkaXYgY2xhc3M9ImxiIj5BcGlmeSBzcGVuZCAobW8pPC9kaXY+PGRpdiBjbGFzcz0idmwiIGlkPSJrcGktc3BlbmQiPuKApjwvZGl2PjxkaXYgY2xhc3M9InRyIiBpZD0ia3BpLXNwZW5kLXRyIj48L2Rpdj48L2Rpdj4nCiAgKyc8L2Rpdj48L2Rpdj4nCiAgKyc8ZGl2IGNsYXNzPSJjYXJkIj48aDI+8J+XhO+4jyBEMSBEYXRhYmFzZTwvaDI+PGRpdiBjbGFzcz0ic3ViIj5Vc2FnZSAmYW1wOyBvcHRpbWl6YXRpb248L2Rpdj48ZGl2IGlkPSJkMS1pbmZvIj48ZGl2IGNsYXNzPSJtZXRhIj5sb2FkaW5n4oCmPC9kaXY+PC9kaXY+PC9kaXY+JwogICsnPGRpdiBjbGFzcz0iY2FyZCI+PGgyPlBpcGVsaW5lIHRpbWVsaW5lPC9oMj48ZGl2IGNsYXNzPSJzdWIiPlJlY2VudCBydW5zPC9kaXY+PGRpdiBjbGFzcz0idGltZWxpbmUiIGlkPSJvdi10aW1lbGluZSI+PGRpdiBjbGFzcz0ibWV0YSI+bG9hZGluZ+KApjwvZGl2PjwvZGl2PjwvZGl2Pic7CiAgdHJ5ewogICAgdmFyIHN0YXRzPWF3YWl0IGFwaSgic3RhdHMiKS5jYXRjaChmdW5jdGlvbigpe3JldHVybiBudWxsO30pOwogICAgdmFyIHJ1bnM9YXdhaXQgYXBpKCJwaXBlbGluZS9ydW5zIikuY2F0Y2goZnVuY3Rpb24oKXtyZXR1cm4gbnVsbDt9KTsKICAgIHZhciB0cmFmZmljPW51bGw7dHJ5e3RyYWZmaWM9YXdhaXQgYXBpKCJ0cmFmZmljP2RheXM9NyIpO31jYXRjaChlKXt9CiAgICBpZihzdGF0cyl7Y291bnRVcChkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgia3BpLXRvb2xzIiksc3RhdHMudG90YWxfdG9vbHN8fDApO2RvY3VtZW50LmdldEVsZW1lbnRCeUlkKCJrcGktdG9vbHMtdHIiKS50ZXh0Q29udGVudD0i4payICIrKHN0YXRzLmFkZGVkXzI0aHx8MCkrIiBpbiBsYXN0IDI0aCI7fQogICAgY291bnRVcChkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgia3BpLWZyZWUiKSwyMjEpOwogICAgaWYodHJhZmZpYyYmdHJhZmZpYy5lbmFibGVkKXtjb3VudFVwKGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCJrcGktdmlzIiksdHJhZmZpYy52aXNpdHN8fDApO2RvY3VtZW50LmdldEVsZW1lbnRCeUlkKCJrcGktdmlzLXRyIikudGV4dENvbnRlbnQ9KHRyYWZmaWMucGFnZXZpZXdzfHwwKS50b0xvY2FsZVN0cmluZygpKyIgcGFnZXZpZXdzIjt9CiAgICBlbHNle2RvY3VtZW50LmdldEVsZW1lbnRCeUlkKCJrcGktdmlzIikudGV4dENvbnRlbnQ9IuKAlCI7ZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoImtwaS12aXMtdHIiKS50ZXh0Q29udGVudD0iV2ViIEFuYWx5dGljcyBub3QgZW5hYmxlZCI7fQogICAgdHJ5ewogICAgICB2YXIga2Q9YXdhaXQgYXBpKCJhcGlmeS1rZXlzIik7dmFyIHR1PTAsdGM9MCxhYz0wOwogICAgICBmb3IodmFyIGk9MDtpPChrZC5rZXlzfHxbXSkubGVuZ3RoO2krKyl7dmFyIGs9a2Qua2V5c1tpXTtpZighay5lbmFibGVkKWNvbnRpbnVlO3RyeXt2YXIgdT1hd2FpdCBhcGkoImFwaWZ5LWtleXMvIitrLmlkKyIvdXNhZ2UiKTt0dSs9dS51c2VkX3VzZHx8MDt0Yys9ay5tb250aGx5X2NhcF91c2R8fDU7YWMrKzt9Y2F0Y2goZSl7fX0KICAgICAgZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoImtwaS1zcGVuZCIpLnRleHRDb250ZW50PSIkIit0dS50b0ZpeGVkKDIpOwogICAgICBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgia3BpLXNwZW5kLXRyIikudGV4dENvbnRlbnQ9Im9mICQiK3RjLnRvRml4ZWQoMCkrIiBjYXAgwrcgIithYysiIGtleXMiOwogICAgfWNhdGNoKGUpe2RvY3VtZW50LmdldEVsZW1lbnRCeUlkKCJrcGktc3BlbmQiKS50ZXh0Q29udGVudD0i4oCUIjt9CiAgICB0cnl7CiAgICAgIHZhciBkMT1hd2FpdCBhcGkoImQxLXVzYWdlIik7dmFyIHQ9ZDEudGFibGVzfHx7fTsKICAgICAgdmFyIG5hbWVzPXt0b29sczoiQUkgdG9vbHMiLGJsb2dzOiJCbG9nIHBvc3RzIixwcm9tcHRzOiJQcm9tcHRzIixhcGlmeV9rZXlzOiJBcGlmeSBrZXlzIixtYW5pZmVzdF9lbmRwb2ludHM6Ik1hbmlmZXN0IGVuZHBvaW50cyIscGlwZWxpbmVfcnVuczoiUGlwZWxpbmUgcnVucyJ9OwogICAgICB2YXIgaD0nPGRpdiBjbGFzcz0iZjIiIHN0eWxlPSJncmlkLXRlbXBsYXRlLWNvbHVtbnM6cmVwZWF0KDMsMWZyKSI+JzsKICAgICAgZm9yKHZhciBrayBpbiBuYW1lcyl7aWYodFtra10+PTApaCs9JzxkaXY+PGRpdiBjbGFzcz0ibGIiPicrbmFtZXNba2tdKyc8L2Rpdj48ZGl2IGNsYXNzPSJ2bCIgc3R5bGU9ImZvbnQtc2l6ZToyMHB4O2NvbG9yOnZhcigtLWluaykiPicrdFtra10udG9Mb2NhbGVTdHJpbmcoKSsnPC9kaXY+PGRpdiBjbGFzcz0ibWV0YSI+cm93czwvZGl2PjwvZGl2Pic7fQogICAgICBoKz0nPC9kaXY+PGRpdiBjbGFzcz0iaGludCIgc3R5bGU9Im1hcmdpbi10b3A6MTJweCI+8J+SoSA8Yj5TYXZpbmcgRDEgcmVhZHM6PC9iPjxicj7igKIgJysoZDEudGlwc3x8W10pLmpvaW4oJzxicj7igKIgJykrJzwvZGl2Pic7CiAgICAgIGgrPSc8ZGl2IGNsYXNzPSJtZXRhIiBzdHlsZT0ibWFyZ2luLXRvcDo4cHgiPkZyZWUgdGllcjogMTAwSyByZWFkcy9kYXkgwrcgMTAwSyB3cml0ZXMvZGF5IMK3IDVHQiBzdG9yYWdlPC9kaXY+JzsKICAgICAgZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoImQxLWluZm8iKS5pbm5lckhUTUw9aDsKICAgIH1jYXRjaChlKXtkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgiZDEtaW5mbyIpLmlubmVySFRNTD0nPGRpdiBjbGFzcz0ibWV0YSI+RmFpbGVkIHRvIGxvYWQgRDEgaW5mby48L2Rpdj4nO30KICAgIGlmKHJ1bnMpewogICAgICB2YXIgZ2g9cnVucy5naXRodWJfcnVuc3x8W107dmFyIGgyPSIiOwogICAgICBnaC5zbGljZSgwLDQpLmZvckVhY2goZnVuY3Rpb24ocil7dmFyIG9rPXIuY29uY2x1c2lvbj09PSJzdWNjZXNzIjt2YXIgcnVuPXIuc3RhdHVzIT09ImNvbXBsZXRlZCI7aDIrPSc8ZGl2IGNsYXNzPSJ0bC1pdGVtICcrKG9rPyJvayI6cnVuPyJydW4iOiJiYWQiKSsnIj48Yj4jJytyLmlkKyc8L2I+ICcrKHIuY29uY2x1c2lvbnx8ci5zdGF0dXN8fCJ1bmtub3duIikrJyDCtyA8c3BhbiBjbGFzcz0ibWV0YSI+Jytlc2MoU3RyaW5nKHIuaGVhZF9zaGF8fCIiKS5zbGljZSgwLDcpKSsnIMK3ICcrdGltZUFnbyhyLmNyZWF0ZWRfYXQpKyc8L3NwYW4+PC9kaXY+Jzt9KTsKICAgICAgZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoIm92LXRpbWVsaW5lIikuaW5uZXJIVE1MPWgyfHwnPGRpdiBjbGFzcz0ibWV0YSI+Tm8gcnVucyB5ZXQuPC9kaXY+JzsKICAgIH0KICB9Y2F0Y2goZSl7bG9nKCJPdmVydmlldyBsb2FkIGZhaWxlZDogIitlLm1lc3NhZ2UpO30KfSwKCmFzeW5jIGFwaWZ5KCl7CiAgdmFyIGQ9YXdhaXQgYXBpKCJhcGlmeS1rZXlzIik7CiAgdmFyIGNvbXA9Sk9CX1NJVEVTOwogIHRyeXt2YXIgYz1hd2FpdCBhcGkoImNvbXBldGl0b3JzIik7aWYoYyYmdHlwZW9mIGM9PT0ib2JqZWN0Iiljb21wPWM7fWNhdGNoKGUpe30KICBmb3IodmFyIGsgaW4gY29tcCl7Sk9CX1NJVEVTW2tdPWNvbXBba107fQogIGZ1bmN0aW9uIGpvYk9wdHMoc2VsKXtyZXR1cm4gSk9CUy5tYXAoZnVuY3Rpb24oail7cmV0dXJuICc8b3B0aW9uIHZhbHVlPSInK2orJyInKyhzZWw9PT1qPyIgc2VsZWN0ZWQiOiIiKSsnPicraisnPC9vcHRpb24+Jzt9KS5qb2luKCIiKTt9CiAgZnVuY3Rpb24gc2l0ZXNGb3Ioam9iKXtyZXR1cm4gKGNvbXBbam9iXXx8W10pLmpvaW4oIiwgIil8fCLigJQiO30KICB2YXIgYnlTbG90PXt9OyhkLmtleXN8fFtdKS5mb3JFYWNoKGZ1bmN0aW9uKGspe2J5U2xvdFtrLnNsb3RdPWs7fSk7CiAgdmFyIGg9JzxkaXYgY2xhc3M9ImNhcmQiPjxoMj7wn5SRIEFwaWZ5IGtleXM8L2gyPjxkaXYgY2xhc3M9InN1YiI+U2xvdCBOIOKGkiBHaXRIdWIgU2VjcmV0IEFQSUZZX0tFWV9OIMK3IHVzYWdlIGF1dG8tbG9hZHM8L2Rpdj4nOwogIGZvcih2YXIgcz0xO3M8PTM7cysrKXsKICAgIHZhciBrZXk9YnlTbG90W3NdO3ZhciBqb2I9a2V5P2tleS5hc3NpZ25lZF9qb2I6KFNMT1RfSk9CU1tzXXx8Im90aGVyIik7CiAgICBoKz0nPGRpdiBjbGFzcz0ic2xvdCI+PGRpdiBjbGFzcz0ic2xvdC10b3AiPjxiPlNsb3QgJytzKyc8L2I+JzsKICAgIGlmKGtleSl7aCs9JzxzcGFuIGNsYXNzPSJiYWRnZSAnKyhrZXkuZW5hYmxlZD8ib24iOiJvZmYiKSsnIj4nKyhrZXkuZW5hYmxlZD8iQUNUSVZFIjoiRElTQUJMRUQiKSsnPC9zcGFuPic7fQogICAgZWxzZXtoKz0nPHNwYW4gY2xhc3M9ImJhZGdlIG9mZiI+RU1QVFk8L3NwYW4+Jzt9CiAgICBoKz0nPHNwYW4gY2xhc3M9ImJhZGdlIGpvYiI+Jytlc2Moam9iKSsnPC9zcGFuPjxzcGFuIGNsYXNzPSJtZXRhIj7ihpIgJytlc2Moc2l0ZXNGb3Ioam9iKSkrJzwvc3Bhbj48L2Rpdj4nOwogICAgaWYoa2V5KXsKICAgICAgaCs9JzxkaXYgY2xhc3M9ImYyIj48ZGl2PjxsYWJlbD5MYWJlbDwvbGFiZWw+PGlucHV0IGlkPSJhay1sYWJlbC0nK2tleS5pZCsnIiB2YWx1ZT0iJytlc2Moa2V5LmxhYmVsfHwiIikrJyI+PC9kaXY+JwogICAgICArJzxkaXY+PGxhYmVsPkFzc2lnbmVkIGpvYjwvbGFiZWw+PHNlbGVjdCBpZD0iYWstam9iLScra2V5LmlkKyciPicram9iT3B0cyhrZXkuYXNzaWduZWRfam9iKSsnPC9zZWxlY3Q+PC9kaXY+JwogICAgICArJzxkaXY+PGxhYmVsPk1vbnRobHkgY2FwIChVU0QpPC9sYWJlbD48aW5wdXQgaWQ9ImFrLWNhcC0nK2tleS5pZCsnIiB0eXBlPSJudW1iZXIiIHN0ZXA9IjAuNSIgdmFsdWU9IicrKGtleS5tb250aGx5X2NhcF91c2R8fDUpKyciPjwvZGl2PicKICAgICAgKyc8ZGl2PjxsYWJlbD5Ub2tlbjwvbGFiZWw+PGlucHV0IGlkPSJhay10b2tlbi0nK2tleS5pZCsnIiB0eXBlPSJwYXNzd29yZCIgcGxhY2Vob2xkZXI9IuKAouKAouKAouKAouKAouKAouKAouKAoicrZXNjKChrZXkudG9rZW58fCIiKS5zbGljZSgtNCkpKyciPjwvZGl2PjwvZGl2PicKICAgICAgKyc8ZGl2IGNsYXNzPSJtZXRhIj5Ub2tlbjogPHNwYW4gY2xhc3M9InRvayI+Jytlc2Moa2V5LnRva2VufHwiIikrJzwvc3Bhbj4gwrcgRDEgU2xvdCAnK2tleS5zbG90Kycg4oaSIEFQSUZZX0tFWV8nK2tleS5zbG90Kyc8L2Rpdj4nCiAgICAgICsnPGRpdiBpZD0idXNhZ2UtJytrZXkuaWQrJyI+PGRpdiBjbGFzcz0ibWV0YSI+bG9hZGluZyB1c2FnZeKApjwvZGl2PjwvZGl2PicKICAgICAgKyc8ZGl2IGNsYXNzPSJidG5yb3ciPjxidXR0b24gY2xhc3M9ImJ0biBkYXJrIiBkYXRhLWFjdD0ic2F2ZSIgZGF0YS1pZD0iJytrZXkuaWQrJyI+U2F2ZTwvYnV0dG9uPicKICAgICAgKyc8YnV0dG9uIGNsYXNzPSJidG4iIGRhdGEtYWN0PSJ0ZXN0IiBkYXRhLWlkPSInK2tleS5pZCsnIj5UZXN0PC9idXR0b24+JwogICAgICArJzxidXR0b24gY2xhc3M9ImJ0biIgZGF0YS1hY3Q9InRvZ2dsZSIgZGF0YS1pZD0iJytrZXkuaWQrJyI+Jysoa2V5LmVuYWJsZWQ/IkRpc2FibGUiOiJFbmFibGUiKSsnPC9idXR0b24+JwogICAgICArJzxidXR0b24gY2xhc3M9ImJ0biBkYW5nZXIiIGRhdGEtYWN0PSJkZWwiIGRhdGEtaWQ9Iicra2V5LmlkKyciPlJlbW92ZTwvYnV0dG9uPjwvZGl2Pic7CiAgICB9ZWxzZXsKICAgICAgaCs9JzxkaXYgY2xhc3M9ImhpbnQiPuKelSA8Yj5FbXB0eSBzbG90PC9iPiDigJQgcGFzdGUgYW4gQXBpZnkgQVBJIGtleSB0byBhY3RpdmF0ZSA8Yj4nK2VzYyhqb2IpKyc8L2I+ICgnK2VzYyhzaXRlc0Zvcihqb2IpKSsnKS48L2Rpdj4nCiAgICAgICsnPGRpdiBjbGFzcz0iZjIiPjxkaXY+PGxhYmVsPkxhYmVsPC9sYWJlbD48aW5wdXQgaWQ9Im5rLWxhYmVsLScrcysnIiBwbGFjZWhvbGRlcj0iZS5nLiB0YWFmdCBrZXkiPjwvZGl2PicKICAgICAgKyc8ZGl2PjxsYWJlbD5BUEkgS2V5PC9sYWJlbD48aW5wdXQgaWQ9Im5rLXRva2VuLScrcysnIiB0eXBlPSJwYXNzd29yZCIgcGxhY2Vob2xkZXI9ImFwaWZ5X2FwaV/igKYiPjwvZGl2PicKICAgICAgKyc8ZGl2PjxsYWJlbD5Nb250aGx5IGNhcCAoVVNEKTwvbGFiZWw+PGlucHV0IGlkPSJuay1jYXAtJytzKyciIHR5cGU9Im51bWJlciIgc3RlcD0iMC41IiB2YWx1ZT0iNSI+PC9kaXY+JwogICAgICArJzxkaXY+PGxhYmVsPkFzc2lnbmVkIGpvYjwvbGFiZWw+PHNlbGVjdCBpZD0ibmstam9iLScrcysnIj4nK2pvYk9wdHMoam9iKSsnPC9zZWxlY3Q+PC9kaXY+PC9kaXY+JwogICAgICArJzxkaXYgY2xhc3M9ImJ0bnJvdyI+PGJ1dHRvbiBjbGFzcz0iYnRuIGRhcmsiIGRhdGEtYWN0PSJhZGQiIGRhdGEtc2xvdD0iJytzKyciPisgQWRkIGtleSB0byBTbG90ICcrcysnPC9idXR0b24+PC9kaXY+JzsKICAgIH0KICAgIGgrPSc8L2Rpdj4nOwogIH0KICBoKz0nPC9kaXY+JzsKICBWLmlubmVySFRNTD1oOwogIChkLmtleXN8fFtdKS5mb3JFYWNoKGZ1bmN0aW9uKGspe2xvYWRVc2FnZShrLmlkLGsubW9udGhseV9jYXBfdXNkfHw1KTt9KTsKICBWLnF1ZXJ5U2VsZWN0b3JBbGwoIltkYXRhLWFjdF0iKS5mb3JFYWNoKGZ1bmN0aW9uKGIpewogICAgYi5vbmNsaWNrPWZ1bmN0aW9uKCl7aGFuZGxlQXBpZnkoYi5kYXRhc2V0LmFjdCxiLmRhdGFzZXQuaWR8fGIuZGF0YXNldC5zbG90KTt9OwogIH0pOwp9LAoKYXN5bmMgbWFuaWZlc3QoKXsKICB2YXIgZD1hd2FpdCBhcGkoIm1hbmlmZXN0Iik7CiAgdmFyIGVwcz1kLmVuZHBvaW50c3x8W107CiAgdmFyIGFjdGl2ZT1lcHMuZmluZChmdW5jdGlvbihlKXtyZXR1cm4gZS5lbmFibGVkJiYoZS51c2VkX3RoaXNfbW9udGh8fDApPChlLm1vbnRobHlfbGltaXR8fDEwMDAwKTt9KTsKICB2YXIgaD0nPGRpdiBjbGFzcz0iY2FyZCI+PGgyPvCfpJYgTWFuaWZlc3QgZW5kcG9pbnRzPC9oMj48ZGl2IGNsYXNzPSJzdWIiPkxMTSByb3V0ZXIgwrcgYXV0by1yb2xsb3ZlciB0byB0aGUgbmV4dCBlbmRwb2ludCB3aGVuIHF1b3RhIHJ1bnMgb3V0PC9kaXY+JzsKICBpZihhY3RpdmUpe2grPSc8ZGl2IGNsYXNzPSJoaW50Ij7imqEgPGI+Um91dGVyIGFjdGl2ZTo8L2I+IDxiPicrZXNjKGFjdGl2ZS5sYWJlbHx8KCJFbmRwb2ludCAiK2FjdGl2ZS5pZCkpKyc8L2I+IOKAlCBwaXBlbGluZSBMTE0gY2FsbHMgZ28gaGVyZSB1bnRpbCBpdHMgcXVvdGEgaXMgdXNlZC48L2Rpdj4nO30KICBlbHNlIGlmKGVwcy5sZW5ndGgpe2grPSc8ZGl2IGNsYXNzPSJ3YXJuYm94Ij7imqDvuI8gTm8gZW5kcG9pbnQgd2l0aCByZW1haW5pbmcgcXVvdGEg4oCUIExMTSBlbnJpY2htZW50IGlzIHBhdXNlZCB1bnRpbCBxdW90YSByZXNldHMgb3IgYSBuZXcga2V5IGlzIGFkZGVkLjwvZGl2Pic7fQogIGVwcy5mb3JFYWNoKGZ1bmN0aW9uKGUpewogICAgdmFyIGxpbWl0PWUubW9udGhseV9saW1pdHx8MTAwMDA7dmFyIHVzZWQ9ZS51c2VkX3RoaXNfbW9udGh8fDA7dmFyIHBjdD1NYXRoLnJvdW5kKDEwMCp1c2VkL2xpbWl0KTsKICAgIHZhciB3YXJuODA9cGN0Pj04MCYmcGN0PDEwMDt2YXIgaXNBY3RpdmU9YWN0aXZlJiZhY3RpdmUuaWQ9PT1lLmlkOwogICAgaCs9JzxkaXYgY2xhc3M9InNsb3QiJysoaXNBY3RpdmU/JyBzdHlsZT0iYm9yZGVyLWNvbG9yOnZhcigtLWFtKSInOicnKSsnPjxkaXYgY2xhc3M9InNsb3QtdG9wIj48Yj4nK2VzYyhlLmxhYmVsfHwoIkVuZHBvaW50ICIrZS5pZCkpKyc8L2I+JwogICAgKyc8c3BhbiBjbGFzcz0iYmFkZ2UgJysoZS5lbmFibGVkPyJvbiI6Im9mZiIpKyciPicrKGUuZW5hYmxlZD8iQUNUSVZFIjoiRElTQUJMRUQiKSsnPC9zcGFuPicKICAgICsoaXNBY3RpdmU/JzxzcGFuIGNsYXNzPSJiYWRnZSByb3V0ZXIiPuKaoSBST1VURVI8L3NwYW4+JzonJykKICAgICsnPHNwYW4gY2xhc3M9InRvayI+Jytlc2MoZS5iYXNlX3VybHx8IiIpLnJlcGxhY2UoL15odHRwcz86XC9cLy8sIiIpLnNsaWNlKDAsMzIpKyc8L3NwYW4+PC9kaXY+JwogICAgKyc8ZGl2IGNsYXNzPSJwcm9nJysocGN0Pj0xMDA/IiBvdmVyIjoiIikrJyI+PGkgc3R5bGU9IndpZHRoOicrTWF0aC5taW4oMTAwLHBjdCkrJyUiPjwvaT48L2Rpdj4nCiAgICArJzxkaXYgY2xhc3M9Im1ldGEiPjxiPicrdXNlZC50b0xvY2FsZVN0cmluZygpKyc8L2I+IC8gJytsaW1pdC50b0xvY2FsZVN0cmluZygpKycgcmVxdWVzdHMgdXNlZCAoJytwY3QrJyUpPC9kaXY+JwogICAgKyh3YXJuODA/JzxkaXYgY2xhc3M9Indhcm5ib3giPuKaoO+4jyBPdmVyIDgwJSB1c2VkIOKAlCBhZGQgYSBiYWNrdXAgZW5kcG9pbnQgb3IgcXVvdGEgcmVzZXRzIG9uIGRheSAnKyhlLnJlc2V0X2RheXx8MSkrJy48L2Rpdj4nOiIiKQogICAgKyhwY3Q+PTEwMD8nPGRpdiBjbGFzcz0id2FybmJveCI+8J+aqyBRdW90YSBleGhhdXN0ZWQg4oCUIHJvdXRlciBoYXMgcm9sbGVkIG92ZXIgdG8gdGhlIG5leHQgZW5kcG9pbnQuPC9kaXY+JzoiIikKICAgICsnPGRpdiBjbGFzcz0iYnRucm93Ij48YnV0dG9uIGNsYXNzPSJidG4iIGRhdGEtbWFjdD0idGVzdCIgZGF0YS1pZD0iJytlLmlkKyciPlRlc3Q8L2J1dHRvbj4nCiAgICArJzxidXR0b24gY2xhc3M9ImJ0biIgZGF0YS1tYWN0PSJ0b2dnbGUiIGRhdGEtaWQ9IicrZS5pZCsnIj4nKyhlLmVuYWJsZWQ/IkRpc2FibGUiOiJFbmFibGUiKSsnPC9idXR0b24+JwogICAgKyc8YnV0dG9uIGNsYXNzPSJidG4gZGFuZ2VyIiBkYXRhLW1hY3Q9ImRlbCIgZGF0YS1pZD0iJytlLmlkKyciPlJlbW92ZTwvYnV0dG9uPjwvZGl2PjwvZGl2Pic7CiAgfSk7CiAgaCs9JzxkaXYgY2xhc3M9InNsb3QiIHN0eWxlPSJib3JkZXItc3R5bGU6ZGFzaGVkIj48ZGl2IGNsYXNzPSJzbG90LXRvcCI+PGIgc3R5bGU9ImNvbG9yOnZhcigtLW11dCkiPisgTmV3IGVuZHBvaW50PC9iPjwvZGl2PicKICArJzxkaXYgY2xhc3M9ImYyIj48ZGl2PjxsYWJlbD5MYWJlbDwvbGFiZWw+PGlucHV0IGlkPSJubS1sYWJlbCIgcGxhY2Vob2xkZXI9Im1haW4iPjwvZGl2PicKICArJzxkaXY+PGxhYmVsPkJhc2UgVVJMPC9sYWJlbD48aW5wdXQgaWQ9Im5tLXVybCIgdmFsdWU9Imh0dHBzOi8vYXBwLm1hbmlmZXN0LmJ1aWxkL3YxIj48L2Rpdj4nCiAgKyc8ZGl2PjxsYWJlbD5BUEkgS2V5PC9sYWJlbD48aW5wdXQgaWQ9Im5tLWtleSIgdHlwZT0icGFzc3dvcmQiIHBsYWNlaG9sZGVyPSJzay3igKYiPjwvZGl2PicKICArJzxkaXY+PGxhYmVsPk1vbnRobHkgbGltaXQgKHJlcXVlc3RzKTwvbGFiZWw+PGlucHV0IGlkPSJubS1saW1pdCIgdHlwZT0ibnVtYmVyIiB2YWx1ZT0iMTAwMDAiPjwvZGl2PjwvZGl2PicKICArJzxkaXYgY2xhc3M9ImhpbnQiIHN0eWxlPSJtYXJnaW46MCAwIDEycHgiPkVhY2ggTWFuaWZlc3QgQVBJIGtleSBpbmNsdWRlcyA8Yj4xMCwwMDAgcmVxdWVzdHMvbW9udGg8L2I+LiBBZGQgYSAybmQga2V5IGFzIGJhY2t1cCDigJQgdGhlIHJvdXRlciByb2xscyBvdmVyIGF1dG9tYXRpY2FsbHkuPC9kaXY+JwogICsnPGRpdiBjbGFzcz0iYnRucm93Ij48YnV0dG9uIGNsYXNzPSJidG4gZGFyayIgZGF0YS1tYWN0PSJhZGQiPisgQWRkIGVuZHBvaW50PC9idXR0b24+PC9kaXY+PC9kaXY+JzsKICBoKz0nPC9kaXY+JzsKICBWLmlubmVySFRNTD1oOwogIFYucXVlcnlTZWxlY3RvckFsbCgiW2RhdGEtbWFjdF0iKS5mb3JFYWNoKGZ1bmN0aW9uKGIpewogICAgYi5vbmNsaWNrPWZ1bmN0aW9uKCl7aGFuZGxlTWFuaWZlc3QoYi5kYXRhc2V0Lm1hY3QsYi5kYXRhc2V0LmlkKTt9OwogIH0pOwp9LAoKYXN5bmMgcnVucygpewogIHZhciBkPWF3YWl0IGFwaSgicGlwZWxpbmUvcnVucyIpOwogIHZhciBnaD1kLmdpdGh1Yl9ydW5zfHxbXSxkYj1kLmRiX3J1bnN8fFtdOwogIHZhciBoPSc8ZGl2IGNsYXNzPSJjYXJkIj48aDI+8J+UhCBQaXBlbGluZSBydW5zPC9oMj48ZGl2IGNsYXNzPSJzdWIiPkdpdEh1YiBBY3Rpb25zICsgRDEgcnVuIGhpc3Rvcnk8L2Rpdj4nOwogIGlmKCFnaC5sZW5ndGgmJiFkYi5sZW5ndGgpaCs9JzxkaXYgY2xhc3M9Im1ldGEiPk5vIHJ1bnMgcmVjb3JkZWQgeWV0LjwvZGl2Pic7CiAgaCs9JzxkaXYgY2xhc3M9InRpbWVsaW5lIj4nOwogIGdoLnNsaWNlKDAsOCkuZm9yRWFjaChmdW5jdGlvbihyKXsKICAgIHZhciBvaz1yLmNvbmNsdXNpb249PT0ic3VjY2VzcyI7dmFyIHJ1bm5pbmc9ci5zdGF0dXMhPT0iY29tcGxldGVkIjsKICAgIGgrPSc8ZGl2IGNsYXNzPSJ0bC1pdGVtICcrKG9rPyJvayI6cnVubmluZz8icnVuIjoiYmFkIikrJyI+PGI+Iycrci5pZCsnPC9iPiAnK2VzYyhyLmNvbmNsdXNpb258fHIuc3RhdHVzfHwidW5rbm93biIpLnJlcGxhY2UoL18vZywiICIpCiAgICArJyA8c3BhbiBjbGFzcz0ibWV0YSI+Y29tbWl0ICcrZXNjKFN0cmluZyhyLmhlYWRfc2hhfHwiIikuc2xpY2UoMCw3KSkrJyDCtyBicmFuY2ggJytlc2Moci5oZWFkX2JyYW5jaHx8Im1haW4iKSsnIMK3ICcrdGltZUFnbyhyLmNyZWF0ZWRfYXQpKyc8L3NwYW4+PC9kaXY+JzsKICB9KTsKICBoKz0nPC9kaXY+JzsKICBpZihkYi5sZW5ndGgpewogICAgaCs9JzxkaXYgY2xhc3M9InN1YiIgc3R5bGU9Im1hcmdpbi10b3A6MTRweCI+RDEgcGlwZWxpbmVfcnVucyB0YWJsZTwvZGl2PjxkaXYgY2xhc3M9InRpbWVsaW5lIj4nOwogICAgZGIuc2xpY2UoMCw1KS5mb3JFYWNoKGZ1bmN0aW9uKHIpewogICAgICBoKz0nPGRpdiBjbGFzcz0idGwtaXRlbSBvayI+PGI+cnVuICcrZXNjKHIuaWQpKyc8L2I+IDxzcGFuIGNsYXNzPSJtZXRhIj4nK2VzYyhyLnN0YXJ0ZWRfYXR8fCIiKSsoci50b29sc19hZGRlZD8iIMK3ICIrci50b29sc19hZGRlZCsiIHRvb2xzIjoiIikrJzwvc3Bhbj48L2Rpdj4nOwogICAgfSk7CiAgICBoKz0nPC9kaXY+JzsKICB9CiAgaCs9JzwvZGl2Pic7CiAgVi5pbm5lckhUTUw9aDsKfSwKCmFzeW5jIHRyYWZmaWMoKXsKICBWLmlubmVySFRNTD0nPGRpdiBjbGFzcz0iY2FyZCI+PGgyPvCfk4ggVHJhZmZpYzwvaDI+PGRpdiBjbGFzcz0ic3ViIj5DbG91ZGZsYXJlIFdlYiBBbmFseXRpY3MgKFJVTSkgwrcgbm8gc2VwYXJhdGUgQVBJIG5lZWRlZDwvZGl2PicKICArJzxkaXYgY2xhc3M9ImJ0bnJvdyIgc3R5bGU9Im1hcmdpbi10b3A6MDttYXJnaW4tYm90dG9tOjZweCI+JwogICsnPGJ1dHRvbiBjbGFzcz0iYnRuIiBkYXRhLWQ9IjEiPjI0aDwvYnV0dG9uPjxidXR0b24gY2xhc3M9ImJ0biIgZGF0YS1kPSI3Ij43ZDwvYnV0dG9uPjxidXR0b24gY2xhc3M9ImJ0biIgZGF0YS1kPSIzMCI+MzBkPC9idXR0b24+PC9kaXY+JwogICsnPGRpdiBpZD0idGRhdGEiPjxkaXYgY2xhc3M9Im1ldGEiPmxvYWRpbmfigKY8L2Rpdj48L2Rpdj48L2Rpdj4nOwogIGZ1bmN0aW9uIGxvYWQoZGF5cyl7CiAgICB2YXIgZWw9ZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoInRkYXRhIik7CiAgICBWLnF1ZXJ5U2VsZWN0b3JBbGwoIltkYXRhLWRdIikuZm9yRWFjaChmdW5jdGlvbihiKXtiLmNsYXNzTGlzdC50b2dnbGUoImRhcmsiLGIuZGF0YXNldC5kPT1kYXlzKTt9KTsKICAgIGFwaSgidHJhZmZpYz9kYXlzPSIrZGF5cykudGhlbihmdW5jdGlvbihyKXsKICAgICAgaWYoIXIuZW5hYmxlZCl7CiAgICAgICAgZWwuaW5uZXJIVE1MPSc8ZGl2IGNsYXNzPSJoaW50IiBzdHlsZT0ibWFyZ2luLXRvcDoxMnB4Ij7wn5OKIDxiPldlYiBBbmFseXRpY3Mgbm90IGNvbm5lY3RlZCB5ZXQuPC9iPjxicj48YnI+RW5hYmxlIGl0OiBDbG91ZGZsYXJlIGRhc2hib2FyZCDihpIgUGFnZXMg4oaSIDxiPmFpLWRpcmVjdG9yeS12NS1yYWR3YW42NDg8L2I+IOKGkiBBbmFseXRpY3Mg4oaSIDxiPkVuYWJsZSBXZWIgQW5hbHl0aWNzPC9iPi48YnI+RGF0YSBhcHBlYXJzIHdpdGhpbiBhIGZldyBob3Vycy4gTm8gY29kZSBjaGFuZ2VzIG9yIGV4dHJhIEFQSSBrZXlzIG5lZWRlZCDigJQgdGhlIGV4aXN0aW5nIHRva2VuIGFscmVhZHkgaGFzIGFjY2Vzcy48L2Rpdj4nOwogICAgICAgIHJldHVybjsKICAgICAgfQogICAgICB2YXIgcGFnZXM9ci50b3BfcGFnZXN8fFtdOwogICAgICB2YXIgbWF4PU1hdGgubWF4LmFwcGx5KG51bGwscGFnZXMubWFwKGZ1bmN0aW9uKHApe3JldHVybiBwLnZpZXdzO30pLmNvbmNhdChbMV0pKTsKICAgICAgdmFyIGg9JzxkaXYgY2xhc3M9InNwYXJrIj4nK3BhZ2VzLnNsaWNlKDAsMTIpLm1hcChmdW5jdGlvbihwKXtyZXR1cm4gJzxpIHN0eWxlPSJoZWlnaHQ6JytNYXRoLm1heCg2LE1hdGgucm91bmQoMTAwKnAudmlld3MvbWF4KSkrJyUiIHRpdGxlPSInK2VzYyhwLnBhZ2UpKyIg4oCUICIrcC52aWV3cysnIj48L2k+Jzt9KS5qb2luKCIiKSsnPC9kaXY+JzsKICAgICAgaCs9JzxkaXYgY2xhc3M9ImtwaXMiIHN0eWxlPSJncmlkLXRlbXBsYXRlLWNvbHVtbnM6cmVwZWF0KDMsMWZyKSI+JwogICAgICArJzxkaXYgY2xhc3M9ImtwaSBrMSI+PGRpdiBjbGFzcz0ibGIiPlZpc2l0b3JzICgnK3IuZGF5cysnZCk8L2Rpdj48ZGl2IGNsYXNzPSJ2bCIgaWQ9InR2LXYiPjA8L2Rpdj48L2Rpdj4nCiAgICAgICsnPGRpdiBjbGFzcz0ia3BpIGsyIj48ZGl2IGNsYXNzPSJsYiI+UGFnZXZpZXdzICgnK3IuZGF5cysnZCk8L2Rpdj48ZGl2IGNsYXNzPSJ2bCIgaWQ9InR2LXAiPjA8L2Rpdj48L2Rpdj4nCiAgICAgICsnPGRpdiBjbGFzcz0ia3BpIGszIj48ZGl2IGNsYXNzPSJsYiI+VG9wIHBhZ2U8L2Rpdj48ZGl2IGNsYXNzPSJ2bCIgc3R5bGU9ImZvbnQtc2l6ZToxNXB4O3dvcmQtYnJlYWs6YnJlYWstYWxsIj4nK2VzYygocGFnZXNbMF18fHt9KS5wYWdlfHwi4oCUIikuc2xpY2UoMCw0MCkrJzwvZGl2PjwvZGl2PjwvZGl2Pic7CiAgICAgIGlmKHBhZ2VzLmxlbmd0aCl7CiAgICAgICAgaCs9JzxkaXYgY2xhc3M9InN1YiIgc3R5bGU9Im1hcmdpbi10b3A6MTZweCI+VG9wIHBhZ2VzPC9kaXY+JytwYWdlcy5zbGljZSgwLDgpLm1hcChmdW5jdGlvbihwKXsKICAgICAgICAgIHJldHVybiAnPGRpdiBzdHlsZT0iZGlzcGxheTpmbGV4O2p1c3RpZnktY29udGVudDpzcGFjZS1iZXR3ZWVuO3BhZGRpbmc6N3B4IDA7Ym9yZGVyLWJvdHRvbToxcHggc29saWQgdmFyKC0tbGluZSk7Zm9udC1zaXplOjEzcHgiPjxzcGFuPicrZXNjKHAucGFnZSkuc2xpY2UoMCw1NSkrJzwvc3Bhbj48Yj4nK3Audmlld3MudG9Mb2NhbGVTdHJpbmcoKSsnPC9iPjwvZGl2Pic7fSkuam9pbigiIik7CiAgICAgIH0KICAgICAgZWwuaW5uZXJIVE1MPWg7CiAgICAgIGNvdW50VXAoZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoInR2LXYiKSxyLnZpc2l0c3x8MCk7CiAgICAgIGNvdW50VXAoZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoInR2LXAiKSxyLnBhZ2V2aWV3c3x8MCk7CiAgICB9KS5jYXRjaChmdW5jdGlvbigpe2VsLmlubmVySFRNTD0nPGRpdiBjbGFzcz0ibWV0YSI+RmFpbGVkIHRvIGxvYWQgdHJhZmZpYy48L2Rpdj4nO30pOwogIH0KICBWLnF1ZXJ5U2VsZWN0b3JBbGwoIltkYXRhLWRdIikuZm9yRWFjaChmdW5jdGlvbihiKXtiLm9uY2xpY2s9ZnVuY3Rpb24oKXtsb2FkKGIuZGF0YXNldC5kKTt9O30pOwogIGxvYWQoNyk7Cn0sCgphc3luYyBhY3Rpb25zKCl7CiAgVi5pbm5lckhUTUw9JzxkaXYgY2xhc3M9ImNhcmQiPjxoMj7impnvuI8gQWN0aW9uczwvaDI+PGRpdiBjbGFzcz0ic3ViIj5NYW51YWwgdHJpZ2dlcnMg4oCUIHVzZSBjYXJlZnVsbHk8L2Rpdj48ZGl2IGNsYXNzPSJhY3RzIj4nCiAgKyc8ZGl2IGNsYXNzPSJhY3QiIGlkPSJhY3QtZGlzcGF0Y2giPjxkaXYgY2xhc3M9ImUiPvCfmoA8L2Rpdj48Yj5UcmlnZ2VyIHBpcGVsaW5lPC9iPjxzcGFuPkRpc3BhdGNoIHRoZSBHaXRIdWIgc2NyYXBlciB3b3JrZmxvdyBub3cgKHNhbWUgYXMgY3Jvbik8L3NwYW4+PC9kaXY+JwogICsnPGRpdiBjbGFzcz0iYWN0IiBpZD0iYWN0LXNuYXBzaG90Ij48ZGl2IGNsYXNzPSJlIj7wn5O4PC9kaXY+PGI+QmFrZSBzbmFwc2hvdDwvYj48c3Bhbj5SdW5zIHZpYSBwaXBlbGluZSDigJQgcmVmcmVzaGVzIGhvbWVwYWdlIHNlY3Rpb25zLmpzb248L3NwYW4+PC9kaXY+JwogICsnPGRpdiBjbGFzcz0iYWN0IiBpZD0iYWN0LWRlZHVwZSI+PGRpdiBjbGFzcz0iZSI+8J+nuTwvZGl2PjxiPlJ1biBkZWR1cGU8L2I+PHNwYW4+UnVucyB2aWEgcGlwZWxpbmUg4oCUIGNsZWFucyBkdXBsaWNhdGUgQUkgdG9vbHM8L3NwYW4+PC9kaXY+JwogICsnPGRpdiBjbGFzcz0iYWN0IiBpZD0iYWN0LXRnIj48ZGl2IGNsYXNzPSJlIj7wn5SUPC9kaXY+PGI+VGVzdCBUZWxlZ3JhbTwvYj48c3Bhbj5TZW5kIGEgdGVzdCBhbGVydCB0byB0aGUgYWRtaW4gY2hhdDwvc3Bhbj48L2Rpdj4nCiAgKyc8L2Rpdj48ZGl2IGNsYXNzPSJoaW50IiBzdHlsZT0ibWFyZ2luLXRvcDoxNHB4Ij7ihLnvuI8gU25hcHNob3QgJmFtcDsgZGVkdXBlIHJ1biBhcyBwaXBlbGluZSBzdGVwcyDigJQgdHJpZ2dlcmluZyB0aGUgcGlwZWxpbmUgcnVucyB0aGUgZnVsbCBmbG93IGluY2x1ZGluZyB0aGVtLjwvZGl2PjwvZGl2Pic7CiAgZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoImFjdC1kaXNwYXRjaCIpLm9uY2xpY2s9ZnVuY3Rpb24oKXtkb0Rpc3BhdGNoKCk7fTsKICBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgiYWN0LXNuYXBzaG90Iikub25jbGljaz1mdW5jdGlvbigpe2RvRGlzcGF0Y2goInNuYXBzaG90Iik7fTsKICBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgiYWN0LWRlZHVwZSIpLm9uY2xpY2s9ZnVuY3Rpb24oKXtkb0Rpc3BhdGNoKCJkZWR1cGUiKTt9OwogIGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCJhY3QtdGciKS5vbmNsaWNrPWZ1bmN0aW9uKCl7ZG9UZygpO307Cn0KfTsKCmFzeW5jIGZ1bmN0aW9uIGxvYWRVc2FnZShpZCxjYXApewogIHZhciBlbD1kb2N1bWVudC5nZXRFbGVtZW50QnlJZCgidXNhZ2UtIitpZCk7aWYoIWVsKXJldHVybjsKICB0cnl7CiAgICB2YXIgdT1hd2FpdCBhcGkoImFwaWZ5LWtleXMvIitpZCsiL3VzYWdlIik7CiAgICB2YXIgdXNlZD11LnVzZWRfdXNkfHwwO3ZhciBwY3Q9TWF0aC5taW4oMTAwLE1hdGgucm91bmQoMTAwKnVzZWQvY2FwKSk7CiAgICBlbC5pbm5lckhUTUw9JzxkaXYgY2xhc3M9InByb2cnKyhwY3Q+PTkwPyIgb3ZlciI6IiIpKyciPjxpIHN0eWxlPSJ3aWR0aDonK3BjdCsnJSI+PC9pPjwvZGl2PicKICAgICsnPGRpdiBjbGFzcz0ibWV0YSI+PGI+JCcrdXNlZC50b0ZpeGVkKDIpKyc8L2I+IC8gJCcrY2FwLnRvRml4ZWQoMikrJyB1c2VkICgnK3BjdCsnJSknCiAgICArKHUubGltaXRfdXNkPycgwrcgbGltaXQgJCcrdS5saW1pdF91c2Q6JycpKyh1LnJlc2V0PycgwrcgcmVzZXRzICcrZXNjKHUucmVzZXQpOiIiKSsnPC9kaXY+JzsKICB9Y2F0Y2goZSl7ZWwuaW5uZXJIVE1MPSc8ZGl2IGNsYXNzPSJtZXRhIj5Vc2FnZSB1bmF2YWlsYWJsZS48L2Rpdj4nO30KfQoKYXN5bmMgZnVuY3Rpb24gaGFuZGxlQXBpZnkoYWN0LGlkKXsKICB0cnl7CiAgICBpZihhY3Q9PT0ic2F2ZSIpewogICAgICB2YXIgbGFiZWw9ZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoImFrLWxhYmVsLSIraWQpLnZhbHVlOwogICAgICB2YXIgam9iPWRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCJhay1qb2ItIitpZCkudmFsdWU7CiAgICAgIHZhciBjYXA9cGFyc2VGbG9hdChkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgiYWstY2FwLSIraWQpLnZhbHVlKXx8NTsKICAgICAgdmFyIHRva2VuPWRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCJhay10b2tlbi0iK2lkKS52YWx1ZTsKICAgICAgdmFyIGJvZHk9e2lkOnBhcnNlSW50KGlkKSxsYWJlbDpsYWJlbCxhc3NpZ25lZF9qb2I6am9iLG1vbnRobHlfY2FwX3VzZDpjYXB9OwogICAgICBpZih0b2tlbilib2R5LnRva2VuPXRva2VuOwogICAgICBhd2FpdCBhcGkoImFwaWZ5LWtleXMiLHttZXRob2Q6IlBPU1QiLGJvZHk6SlNPTi5zdHJpbmdpZnkoYm9keSl9KTsKICAgICAgbG9nKCJLZXkgIitpZCsiIHNhdmVkLiIpO3ZpZXdzLmFwaWZ5KCk7CiAgICB9ZWxzZSBpZihhY3Q9PT0iYWRkIil7CiAgICAgIHZhciBzPWlkOwogICAgICB2YXIgbmxhYmVsPWRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCJuay1sYWJlbC0iK3MpLnZhbHVlOwogICAgICB2YXIgbnRva2VuPWRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCJuay10b2tlbi0iK3MpLnZhbHVlOwogICAgICB2YXIgbmNhcD1wYXJzZUZsb2F0KGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCJuay1jYXAtIitzKS52YWx1ZSl8fDU7CiAgICAgIHZhciBuam9iPWRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCJuay1qb2ItIitzKS52YWx1ZTsKICAgICAgaWYoIW50b2tlbil7YWxlcnQoIlBhc3RlIGFuIEFQSSBrZXkgZmlyc3QuIik7cmV0dXJuO30KICAgICAgYXdhaXQgYXBpKCJhcGlmeS1rZXlzIix7bWV0aG9kOiJQT1NUIixib2R5OkpTT04uc3RyaW5naWZ5KHtzbG90OnBhcnNlSW50KHMpLGxhYmVsOm5sYWJlbCx0b2tlbjpudG9rZW4sbW9udGhseV9jYXBfdXNkOm5jYXAsYXNzaWduZWRfam9iOm5qb2J9KX0pOwogICAgICBsb2coIlNsb3QgIitzKyIga2V5IGFkZGVkLiIpO3ZpZXdzLmFwaWZ5KCk7CiAgICB9ZWxzZSBpZihhY3Q9PT0idGVzdCIpewogICAgICBsb2coIlRlc3Rpbmcga2V5ICIraWQrIuKApiIpOwogICAgICB2YXIgcj1hd2FpdCBhcGkoImFwaWZ5LWtleXMvIitpZCsiL3Rlc3QiLHttZXRob2Q6IlBPU1QifSk7CiAgICAgIGxvZygiVGVzdCAiK2lkKyI6ICIrKHIub2s/Ik9LIOKchSI6IkZBSUxFRCDinYwgIisoci5lcnJvcnx8IiIpKSk7CiAgICAgIGFsZXJ0KHIub2s/IktleSB3b3JrcyDinIUiOiJUZXN0IGZhaWxlZDogIisoci5lcnJvcnx8InVua25vd24iKSk7CiAgICB9ZWxzZSBpZihhY3Q9PT0idG9nZ2xlIil7CiAgICAgIGF3YWl0IGFwaSgiYXBpZnkta2V5cy8iK2lkKyIvdG9nZ2xlIix7bWV0aG9kOiJQT1NUIn0pOwogICAgICBsb2coIktleSAiK2lkKyIgdG9nZ2xlZC4iKTt2aWV3cy5hcGlmeSgpOwogICAgfWVsc2UgaWYoYWN0PT09ImRlbCIpewogICAgICBpZighY29uZmlybSgiUmVtb3ZlIHRoaXMga2V5PyIpKXJldHVybjsKICAgICAgYXdhaXQgYXBpKCJhcGlmeS1rZXlzLyIraWQse21ldGhvZDoiREVMRVRFIn0pOwogICAgICBsb2coIktleSAiK2lkKyIgcmVtb3ZlZC4iKTt2aWV3cy5hcGlmeSgpOwogICAgfQogIH1jYXRjaChlKXtsb2coIkVycm9yOiAiK2UubWVzc2FnZSk7YWxlcnQoIkVycm9yOiAiK2UubWVzc2FnZSk7fQp9Cgphc3luYyBmdW5jdGlvbiBoYW5kbGVNYW5pZmVzdChhY3QsaWQpewogIHRyeXsKICAgIGlmKGFjdD09PSJhZGQiKXsKICAgICAgdmFyIGxhYmVsPWRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCJubS1sYWJlbCIpLnZhbHVlOwogICAgICB2YXIgdXJsPWRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCJubS11cmwiKS52YWx1ZTsKICAgICAgdmFyIGtleT1kb2N1bWVudC5nZXRFbGVtZW50QnlJZCgibm0ta2V5IikudmFsdWU7CiAgICAgIHZhciBsaW1pdD1wYXJzZUludChkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgibm0tbGltaXQiKS52YWx1ZSl8fDEwMDAwOwogICAgICBpZigha2V5KXthbGVydCgiUGFzdGUgYW4gQVBJIGtleSBmaXJzdC4iKTtyZXR1cm47fQogICAgICBhd2FpdCBhcGkoIm1hbmlmZXN0Iix7bWV0aG9kOiJQT1NUIixib2R5OkpTT04uc3RyaW5naWZ5KHtsYWJlbDpsYWJlbCxiYXNlX3VybDp1cmwsYXBpX2tleTprZXksbW9udGhseV9saW1pdDpsaW1pdH0pfSk7CiAgICAgIGxvZygiRW5kcG9pbnQgYWRkZWQuIik7dmlld3MubWFuaWZlc3QoKTsKICAgIH1lbHNlIGlmKGFjdD09PSJ0ZXN0Iil7CiAgICAgIGxvZygiVGVzdGluZyBlbmRwb2ludCAiK2lkKyLigKYiKTsKICAgICAgdmFyIHI9YXdhaXQgYXBpKCJtYW5pZmVzdC8iK2lkKyIvdGVzdCIse21ldGhvZDoiUE9TVCJ9KTsKICAgICAgbG9nKCJUZXN0ICIraWQrIjogIisoci5vaz8iT0sg4pyFIjoiRkFJTEVEIOKdjCAiKyhyLmVycm9yfHwiIikpKTsKICAgICAgYWxlcnQoci5vaz8iRW5kcG9pbnQgd29ya3Mg4pyFIjoiVGVzdCBmYWlsZWQ6ICIrKHIuZXJyb3J8fCJ1bmtub3duIikpOwogICAgfWVsc2UgaWYoYWN0PT09InRvZ2dsZSIpewogICAgICBhd2FpdCBhcGkoIm1hbmlmZXN0LyIraWQrIi90b2dnbGUiLHttZXRob2Q6IlBPU1QifSk7CiAgICAgIGxvZygiRW5kcG9pbnQgIitpZCsiIHRvZ2dsZWQuIik7dmlld3MubWFuaWZlc3QoKTsKICAgIH1lbHNlIGlmKGFjdD09PSJkZWwiKXsKICAgICAgaWYoIWNvbmZpcm0oIlJlbW92ZSB0aGlzIGVuZHBvaW50PyIpKXJldHVybjsKICAgICAgYXdhaXQgYXBpKCJtYW5pZmVzdC8iK2lkLHttZXRob2Q6IkRFTEVURSJ9KTsKICAgICAgbG9nKCJFbmRwb2ludCAiK2lkKyIgcmVtb3ZlZC4iKTt2aWV3cy5tYW5pZmVzdCgpOwogICAgfQogIH1jYXRjaChlKXtsb2coIkVycm9yOiAiK2UubWVzc2FnZSk7YWxlcnQoIkVycm9yOiAiK2UubWVzc2FnZSk7fQp9Cgphc3luYyBmdW5jdGlvbiBkb0Rpc3BhdGNoKCl7CiAgaWYoIWNvbmZpcm0oIlRyaWdnZXIgdGhlIHBpcGVsaW5lIG5vdz8iKSlyZXR1cm47CiAgbG9nKCJEaXNwYXRjaGluZyBwaXBlbGluZeKApiIpOwogIHRyeXt2YXIgcj1hd2FpdCBhcGkoInBpcGVsaW5lL2Rpc3BhdGNoIix7bWV0aG9kOiJQT1NUIn0pO2xvZygiRGlzcGF0Y2g6ICIrKHIub2s/InNlbnQg4pyFIjoiZmFpbGVkIOKdjCAiKyhyLnN0YXR1c3x8IiIpKSk7fQogIGNhdGNoKGUpe2xvZygiRGlzcGF0Y2ggZmFpbGVkOiAiK2UubWVzc2FnZSk7fQp9CmFzeW5jIGZ1bmN0aW9uIGRvVGcoKXsKICB0cnl7dmFyIHI9YXdhaXQgYXBpKCJ0ZWxlZ3JhbS90ZXN0Iix7bWV0aG9kOiJQT1NUIn0pO2xvZygiVGVsZWdyYW0gdGVzdDogIisoci5vaz8ic2VudCDinIUiOiJmYWlsZWQg4p2MIikpO30KICBjYXRjaChlKXtsb2coIlRlbGVncmFtIGZhaWxlZDogIitlLm1lc3NhZ2UpO30KfQoKLy8gVGFiIHJlbmRlcmluZwp2YXIgY3VyVGFiPSJvdmVydmlldyI7CmZ1bmN0aW9uIHJlbmRlclRhYnMoKXsKICBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgidGFicyIpLmlubmVySFRNTD1UQUJTLm1hcChmdW5jdGlvbih0KXsKICAgIHJldHVybiAnPGJ1dHRvbiBkYXRhLXRhYj0iJyt0WzBdKyciIGNsYXNzPSInKyhjdXJUYWI9PT10WzBdPyJvbiI6IiIpKyciPicrdFsxXSsnPC9idXR0b24+JzsKICB9KS5qb2luKCIiKTsKICBkb2N1bWVudC5xdWVyeVNlbGVjdG9yQWxsKCIjdGFicyBidXR0b24iKS5mb3JFYWNoKGZ1bmN0aW9uKGIpewogICAgYi5vbmNsaWNrPWZ1bmN0aW9uKCl7Y3VyVGFiPWIuZGF0YXNldC50YWI7cmVuZGVyVGFicygpO3ZpZXdzW2N1clRhYl0oKTt9OwogIH0pOwp9CmRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCJiayIpLnZhbHVlPWxvY2FsU3RvcmFnZS5nZXRJdGVtKCJ6OV9ia2V5Iil8fCIiOwpkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgiYmsiKS5hZGRFdmVudExpc3RlbmVyKCJpbnB1dCIsZnVuY3Rpb24oZSl7bG9jYWxTdG9yYWdlLnNldEl0ZW0oIno5X2JrZXkiLGUudGFyZ2V0LnZhbHVlKTt9KTsKZnVuY3Rpb24gdGljaygpe2RvY3VtZW50LmdldEVsZW1lbnRCeUlkKCJjbG9jayIpLnRleHRDb250ZW50PW5ldyBEYXRlKCkudG9Mb2NhbGVTdHJpbmcoKTt9CnNldEludGVydmFsKHRpY2ssMTAwMCk7dGljaygpOwpyZW5kZXJUYWJzKCk7CnZpZXdzLm92ZXJ2aWV3KCk7CnNldEludGVydmFsKGZ1bmN0aW9uKCl7aWYoY3VyVGFiPT09Im92ZXJ2aWV3Iil2aWV3cy5vdmVydmlldygpO30sNjAwMDApOwo8L3NjcmlwdD4KPC9ib2R5Pgo8L2h0bWw+Cg==";
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
    ctx.waitUntil(handleCronTrigger(env));
  }
};
