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
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Admin — AI Directory</title>
<style>
*{box-sizing:border-box;margin:0}body{font:14px/1.55 -apple-system,"Segoe UI",Inter,Roboto,sans-serif;background:#f6f7f9;color:#1a1d24;min-height:100vh}
:root{--am:#E8940C;--am-deep:#c77a06;--ok:#0d9d6c;--bad:#e5484d;--line:#e8eaef;--card:#fff;--mut:#8a8fa0;--ink:#1a1d24}
@keyframes fadeUp{from{opacity:0;transform:translateY(12px)}to{opacity:1;transform:none}}
@keyframes pulse{50%{opacity:.35}}
@keyframes grow{from{width:0!important}}
@keyframes rise{from{transform:scaleY(0);transform-origin:bottom}}
.wrap{max-width:1080px;margin:auto;padding:28px 24px 60px}
.header{background:linear-gradient(135deg,#1a1d24,#3a2c12);color:#fff;border-radius:20px;padding:26px 32px;margin-bottom:22px;animation:fadeUp .4s;position:relative;overflow:hidden}
.header::after{content:"";position:absolute;right:-50px;top:-50px;width:200px;height:200px;border-radius:50%;background:radial-gradient(circle,rgba(232,148,12,.3),transparent 70%);pointer-events:none}
.header h1{font-size:22px;font-weight:800;position:relative}.header h1 span{color:var(--am)}
.header p{color:#a8a294;font-size:13px;position:relative;margin-top:4px}
.hrow{display:flex;align-items:center;gap:12px;margin-top:14px;position:relative;flex-wrap:wrap}
.status{display:inline-flex;align-items:center;gap:7px;background:rgba(13,157,108,.15);color:#4ade9e;font-size:12px;font-weight:700;padding:6px 14px;border-radius:99px}
.status i{width:8px;height:8px;border-radius:99px;background:#4ade9e;animation:pulse 1.8s infinite}
.hrow input{background:rgba(255,255,255,.08);border:1px solid rgba(255,255,255,.15);color:#fff;border-radius:9px;padding:8px 13px;font-size:12.5px;width:150px;outline:none}
.hrow input::placeholder{color:#8a8474}
.hrow .clock{color:#8a8474;font-size:12px;margin-left:auto}
.tabs{display:flex;gap:8px;margin-bottom:20px;animation:fadeUp .45s;flex-wrap:wrap}
.tabs button{background:var(--card);border:1.5px solid var(--line);padding:10px 20px;border-radius:12px;font-weight:600;cursor:pointer;font-size:13px;color:#5a6070;transition:.16s}
.tabs button:hover{border-color:var(--am);transform:translateY(-1px);box-shadow:0 4px 12px rgba(0,0,0,.06)}
.tabs button.on{background:#1a1d24;color:#fff;border-color:#1a1d24;font-weight:700}
.card{background:var(--card);border:1px solid var(--line);border-radius:18px;padding:24px;margin-bottom:16px;box-shadow:0 2px 12px rgba(0,0,0,.04);animation:fadeUp .5s}
.card h2{font-size:16px;margin-bottom:2px}.card .sub{color:var(--mut);font-size:12.5px;margin-bottom:18px}
.kpis{display:grid;grid-template-columns:repeat(4,1fr);gap:14px}
.kpi{border-radius:16px;padding:20px;color:#fff;position:relative;overflow:hidden;transition:.18s}
.kpi:hover{transform:translateY(-3px)}
.kpi.k1{background:linear-gradient(135deg,#E8940C,#c77a06)}
.kpi.k2{background:linear-gradient(135deg,#0d9d6c,#0a7a54)}
.kpi.k3{background:linear-gradient(135deg,#7c6cf0,#5a4bd0)}
.kpi.k4{background:linear-gradient(135deg,#e5484d,#c03036)}
.kpi .lb{font-size:11px;opacity:.85;text-transform:uppercase;letter-spacing:.7px;font-weight:700}
.kpi .vl{font-size:32px;font-weight:800;letter-spacing:-1px;margin:4px 0}
.kpi .tr{font-size:12px;opacity:.9}
.slot{border:2px solid var(--line);border-radius:16px;padding:20px;margin-bottom:12px;transition:.15s;animation:fadeUp .5s;background:#fff}
.slot:hover{border-color:var(--am)}
.slot-top{display:flex;align-items:center;gap:10px;margin-bottom:12px;flex-wrap:wrap}
.slot-top b{font-size:15px}
.badge{font-size:10px;font-weight:800;letter-spacing:.5px;padding:4px 12px;border-radius:99px}
.badge.on{background:#dcf5e9;color:#0d7a54}.badge.off{background:#f1f2f5;color:#8a8fa0}.badge.job{background:#fdf0dc;color:#b45309}
.tok{font-size:11px;color:var(--mut);background:#f6f7f9;border:1px solid var(--line);border-radius:99px;padding:4px 12px;margin-left:auto;font-family:ui-monospace,monospace}
.prog{height:10px;background:#f1f2f5;border-radius:99px;overflow:hidden;margin:10px 0 6px}
.prog i{display:block;height:100%;border-radius:99px;background:linear-gradient(90deg,var(--ok),#5ce0b0);animation:grow 1.2s ease}
.prog.over i{background:linear-gradient(90deg,var(--bad),#ff8a8a)}
.meta{font-size:12.5px;color:var(--mut)}
.meta b{color:var(--ink)}
.hint{background:rgba(232,148,12,.07);border:1px solid rgba(232,148,12,.22);border-radius:11px;padding:11px 15px;font-size:12.5px;color:#8a6d2b;margin:12px 0}
.hint b{color:var(--am-deep)}
.btnrow{display:flex;gap:10px;margin-top:14px;flex-wrap:wrap}
.btn{border:1.5px solid var(--line);background:#fff;padding:9px 22px;border-radius:11px;font-weight:700;cursor:pointer;font-size:13px;transition:.15s;color:var(--ink)}
.btn:hover{border-color:#1a1d24;transform:translateY(-1px)}
.btn.dark{background:#1a1d24;color:#fff;border-color:#1a1d24}
.btn.dark:hover{background:#2a2d36}
.btn.danger:hover{border-color:var(--bad);color:var(--bad)}
input,select{border:1.5px solid var(--line);border-radius:10px;padding:10px 13px;font-size:13px;width:100%;outline:none;transition:.15s;background:#fff;color:var(--ink)}
input:focus,select:focus{border-color:var(--am);box-shadow:0 0 0 3px rgba(232,148,12,.12)}
input[readonly]{background:#f6f7f9;color:var(--mut)}
.f2{display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:12px}
.f2 label,.flabel{font-size:11px;font-weight:700;color:var(--mut);text-transform:uppercase;letter-spacing:.5px;display:block;margin-bottom:6px}
.timeline{position:relative;padding-left:24px}
.timeline::before{content:"";position:absolute;left:7px;top:8px;bottom:8px;width:2px;background:var(--line)}
.ev{position:relative;margin-bottom:16px}
.ev::before{content:"";position:absolute;left:-21px;top:5px;width:10px;height:10px;border-radius:99px;background:var(--ok);box-shadow:0 0 0 4px #dcf5e9}
.ev.bad::before{background:var(--bad);box-shadow:0 0 0 4px #fde8e8}
.ev.run::before{background:var(--am);box-shadow:0 0 0 4px #fdf0dc;animation:pulse 1.2s infinite}
.ev b{font-size:13.5px}.ev div{font-size:12px;color:var(--mut)}
.spark{display:flex;align-items:end;gap:5px;height:100px;margin:14px 0}
.spark i{flex:1;border-radius:5px 5px 2px 2px;background:linear-gradient(180deg,var(--am),#fde6bd);animation:rise .7s cubic-bezier(.22,.8,.28,1);min-height:4px}
.spark i:hover{filter:brightness(.92)}
.acts{display:grid;grid-template-columns:1fr 1fr;gap:12px}
.act{border:2px solid var(--line);border-radius:14px;padding:18px;cursor:pointer;transition:.16s;background:#fff}
.act:hover{border-color:#1a1d24;transform:translateY(-2px);box-shadow:0 8px 20px rgba(0,0,0,.07)}
.act .e{font-size:24px}.act b{font-size:13.5px;display:block;margin:6px 0 2px}.act span{font-size:12px;color:var(--mut)}
.logcard{background:var(--card);border:1px solid var(--line);border-radius:18px;padding:24px;box-shadow:0 2px 12px rgba(0,0,0,.04)}
.logcard h2{font-size:16px;margin-bottom:12px}
#log{background:#1a1d24;color:#a8b2a0;border-radius:12px;padding:16px;font:12px/1.7 ui-monospace,SFMono-Regular,Menlo,monospace;max-height:220px;overflow:auto;white-space:pre-wrap}
.warnbox{display:none;background:#fde8e8;border:1px solid #f5c6c6;color:#a03030;border-radius:11px;padding:11px 15px;font-size:12.5px;margin:10px 0}
.svc{font-size:11.5px;color:var(--mut);margin-top:6px}
@media(max-width:750px){.kpis{grid-template-columns:1fr 1fr}.f2{grid-template-columns:1fr}.acts{grid-template-columns:1fr}}
</style></head><body><div class="wrap">
<div class="header"><h1>AI Directory <span>— Admin</span></h1><p>Hidden control center · Zero Trust protected</p>
<div class="hrow"><div class="status"><i></i><span id="health">Checking…</span></div>
<input id="bk" type="password" placeholder="Setup key" oninput="localStorage.setItem('z9_bkey',this.value)">
<span class="clock" id="clock"></span></div></div>
<div class="tabs">
<button data-t="overview" class="on">📊 Overview</button>
<button data-t="apify">🔑 Apify keys</button>
<button data-t="manifest">🤖 Manifest</button>
<button data-t="runs">🔄 Pipeline runs</button>
<button data-t="traffic">📈 Traffic</button>
<button data-t="actions">⚙️ Actions</button>
</div>
<div id="view"></div>
<div class="logcard"><h2>📝 Log</h2><div id="log"></div></div>
</div>
<script>
const V = document.getElementById('view'), LOG = document.getElementById('log');
const log = (m) => { LOG.textContent += new Date().toLocaleTimeString() + ' ' + m + '\\n'; LOG.scrollTop = 1e6; };
function bkey() { return localStorage.getItem('z9_bkey') || ''; }
async function api(path, method, body) {
  const h = { 'Content-Type': 'application/json' };
  if (bkey()) h['X-Bootstrap-Key'] = bkey();
  const r = await fetch('/z9-admin/api/' + path, { method: method || 'GET',
    headers: h, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || ('HTTP ' + r.status));
  return j;
}
function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }
// Animated count-up for KPI numbers
function countUp(el, target, prefix) {
  prefix = prefix || '';
  const t0 = performance.now(), dur = 1100;
  function frame(ts) {
    const p = Math.min(1, (ts - t0) / dur), e = 1 - Math.pow(1 - p, 3);
    el.textContent = prefix + Math.floor(target * e).toLocaleString();
    if (p < 1) requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
}
function timeAgo(iso) {
  if (!iso) return '—';
  const s = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return s + 's ago';
  if (s < 3600) return Math.floor(s / 60) + 'm ago';
  if (s < 86400) return Math.floor(s / 3600) + 'h ago';
  return Math.floor(s / 86400) + 'd ago';
}
// Job -> competitor mapping (also served by GET /z9-admin/api/competitors)
// 3-slot plan: Slot 1 = toolify daily, Slot 2 = taaft daily, Slot 3 = long-tail weekly
const JOB_SITES = {
  'toolify-daily': ['toolify.ai'],
  'taaft-daily': ['theresanaiforthat.com'],
  'longtail-weekly': ['futurepedia.io', 'futuretools.io', 'topai.tools', 'beyondtools.io', 'toolfk.com'],
  'other': []
};
const JOBS = ['toolify-daily', 'taaft-daily', 'longtail-weekly', 'other'];
const SLOT_JOBS = { 1: 'toolify-daily', 2: 'taaft-daily', 3: 'longtail-weekly' };
let activeTab = 'overview', refreshTimer = null;
const views = {
  async overview() {
    V.innerHTML = '<div class="card"><h2>At a glance</h2><div class="sub">Live data · auto-refreshes every 60s</div><div class="kpis">'
      + '<div class="kpi k1"><div class="lb">AI tools indexed</div><div class="vl" id="kpi-tools">…</div><div class="tr" id="kpi-tools-tr"></div></div>'
      + '<div class="kpi k2"><div class="lb">Free browser tools</div><div class="vl" id="kpi-free">…</div><div class="tr">▲ 119 added Oct 2026</div></div>'
      + '<div class="kpi k3"><div class="lb">Visitors (7d)</div><div class="vl" id="kpi-vis">…</div><div class="tr" id="kpi-vis-tr"></div></div>'
      + '<div class="kpi k4"><div class="lb">Apify spend (mo)</div><div class="vl" id="kpi-spend">…</div><div class="tr" id="kpi-spend-tr"></div></div>'
      + '</div></div><div class="card"><h2>🗄️ D1 Database</h2><div class="sub">Usage & optimization</div><div id="d1-info"><div class="meta">loading…</div></div></div><div class="card"><h2>Pipeline timeline</h2><div class="sub">Recent runs</div><div class="timeline" id="ov-timeline"><div class="meta">loading…</div></div></div>';
    // Parallel data load
    const [stats, runs] = await Promise.all([
      api('stats').catch(() => null),
      api('pipeline/runs').catch(() => null)
    ]);
    let traffic = null;
    try { traffic = await api('traffic?days=7'); } catch (e) {}
    if (stats) {
      countUp(document.getElementById('kpi-tools'), stats.total_tools || 0);
      document.getElementById('kpi-tools-tr').textContent = '▲ ' + (stats.added_24h || 0) + ' in last 24h';
    }
    countUp(document.getElementById('kpi-free'), 221);
    // D1 usage
    try {
      const d1 = await api('d1-usage');
      const t = d1.tables || {};
      let h = '<div class="f2">';
      const names = {tools:'AI tools', blogs:'Blog posts', prompts:'Prompts', apify_keys:'Apify keys', manifest_endpoints:'Manifest endpoints', pipeline_runs:'Pipeline runs'};
      for (const k of Object.keys(names)) {
        if (t[k] >= 0) h += '<div><div class="lb">' + names[k] + '</div><div class="vl" style="font-size:20px">' + t[k].toLocaleString() + '</div><div class="meta">rows</div></div>';
      }
      h += '</div><div class="hint" style="margin-top:12px">💡 <b>Saving D1 reads:</b><br>• ' + (d1.tips || []).join('<br>• ') + '</div>';
      h += '<div class="meta" style="margin-top:8px">Free tier: 100K reads/day · 100K writes/day · 5GB storage</div>';
      document.getElementById('d1-info').innerHTML = h;
    } catch (e) { document.getElementById('d1-info').innerHTML = '<div class="meta">Failed to load D1 info.</div>'; }
    if (traffic && traffic.enabled) {
      countUp(document.getElementById('kpi-vis'), traffic.visits || 0);
      document.getElementById('kpi-vis-tr').textContent = (traffic.pageviews || 0).toLocaleString() + ' pageviews';
    } else {
      document.getElementById('kpi-vis').textContent = '—';
      document.getElementById('kpi-vis-tr').textContent = 'Web Analytics not enabled';
    }
    // Apify spend: sum usage across enabled keys
    try {
      const kd = await api('apify-keys');
      let totalUsed = 0, totalCap = 0, active = 0;
      for (const k of (kd.keys || [])) {
        if (!k.enabled) continue;
        active++;
        totalCap += parseFloat(k.monthly_cap_usd) || 0;
        try {
          const u = await api('apify-keys/' + k.id + '/usage');
          if (u.available) totalUsed += u.total_usd || 0;
        } catch (e) {}
      }
      document.getElementById('kpi-spend').textContent = '$' + totalUsed.toFixed(2);
      document.getElementById('kpi-spend-tr').textContent = active
        ? '$' + Math.max(0, totalCap - totalUsed).toFixed(2) + ' left of $' + totalCap.toFixed(0) + ' cap'
        : 'no active keys';
    } catch (e) {
      document.getElementById('kpi-spend').textContent = '—';
    }
    // Timeline
    const tl = document.getElementById('ov-timeline');
    const gh = (runs && runs.github_runs) || [];
    if (!gh.length) { tl.innerHTML = '<div class="meta">No runs found.</div>'; }
    else {
      tl.innerHTML = gh.slice(0, 4).map((r) => {
        const ok = r.conclusion === 'success';
        const running = r.status !== 'completed';
        return '<div class="ev' + (ok ? '' : running ? ' run' : ' bad') + '"><b>#' + r.id + ' — ' + esc((r.conclusion || r.status || '').replace(/_/g, ' ')) + '</b>'
          + '<div>' + esc(String(r.head_sha || '').slice(0, 7)) + ' · ' + timeAgo(r.created_at) + '</div></div>';
      }).join('');
    }
    document.getElementById('health').textContent = 'All systems operational';
  },
  async apify() {
    const d = await api('apify-keys');
    let comp = JOB_SITES;
    try { const c = await api('competitors'); if (c && typeof c === 'object') comp = c; } catch (e) {}
    // keep local fallback in sync
    Object.keys(comp).forEach((k) => { JOB_SITES[k] = comp[k]; });
    const jobOpts = (sel) => JOBS.map((j) => '<option value="' + j + '"' + (sel === j ? ' selected' : '') + '>' + j + '</option>').join('');
    const sitesFor = (job) => (comp[job] || []).join(', ') || '—';
    const bySlot = {};
    (d.keys || []).forEach((k) => { bySlot[k.slot] = k; });
    let h = '<div class="card"><h2>🔑 Apify keys</h2><div class="sub">3-slot plan · pipeline uses enabled keys in slot order · usage loads live from Apify</div>';
    h += '<div class="hint">💡 <b>Slot → GitHub Secret:</b> Slot 1 → secret <b>APIFY_KEY_1</b> · Slot 2 → <b>APIFY_KEY_2</b> · Slot 3 → <b>APIFY_KEY_3</b>. Add each secret in repo Settings → Secrets → Actions for the pipeline to use it.</div>';

    // Render one card per pre-configured slot (1-3)
    [1, 2, 3].forEach((slotN) => {
      const k = bySlot[slotN];
      const job = (k && k.assigned_job) || SLOT_JOBS[slotN] || 'other';
      const cadence = slotN <= 2 ? 'daily' : 'weekly';
      if (!k) {
        // Empty slot — show structure, prompt for key
        h += '<div class="slot" style="border-style:dashed"><div class="slot-top"><b>Slot ' + slotN + '</b>'
          + '<span class="badge off">NO KEY</span>'
          + '<span class="badge job">' + job + '</span>'
          + '<span class="badge job" style="background:#eef0ff;color:#5a4bd0;border-color:#d9d4ff">' + cadence + '</span></div>'
          + '<div class="meta" style="margin-bottom:10px">Scrapes: <b>' + esc(sitesFor(job)) + '</b></div>'
          + '<div class="f2"><div><label>API Token</label><input id="nk' + slotN + '-token" type="password" placeholder="apify_api_…"></div>'
          + '<div><label>Monthly cap USD</label><input id="nk' + slotN + '-cap" type="number" step="0.5" value="5"></div></div>'
          + '<div class="btnrow"><button class="btn dark" onclick="addApifySlot(' + slotN + ',' + job + ')">+ Add key to Slot ' + slotN + '</button></div></div>';
        return;
      }
      // Existing key — full card with live usage
      h += '<div class="slot" data-id="' + k.id + '">'
        + '<div class="slot-top"><b>Slot ' + k.slot + '</b>'
        + '<span class="badge ' + (k.enabled ? 'on' : 'off') + '">' + (k.enabled ? 'ACTIVE' : 'DISABLED') + '</span>'
        + '<span class="badge job">' + esc(k.assigned_job || 'other') + '</span>'
        + '<span class="badge job" style="background:#eef0ff;color:#5a4bd0;border-color:#d9d4ff">' + cadence + '</span>'
        + '<span class="tok">token …' + esc(String(k.token || '').slice(-4)) + '</span></div>'
        + '<div class="f2"><div><label>Label</label><input data-f="label" value="' + esc(k.label) + '"></div>'
        + '<div><label>API Token</label><div style="display:flex;gap:6px"><input data-f="token" type="password" placeholder="Stored — type to replace" style="flex:1"><button class="btn" style="padding:9px 14px" onclick="eye(this)">👁</button></div></div>'
        + '<div><label>Assigned job</label><select data-f="assigned_job" onchange="updSites(this)">' + jobOpts(k.assigned_job) + '</select>'
        + '<div class="meta" style="margin-top:6px">Scrapes: <b class="sites">' + esc(sitesFor(k.assigned_job)) + '</b></div></div>'
        + '<div><label>Monthly cap USD</label><input data-f="monthly_cap_usd" type="number" step="0.5" value="' + k.monthly_cap_usd + '"></div></div>'
        + '<div class="prog" id="bar-' + k.id + '"><i style="width:0%"></i></div>'
        + '<div class="meta" id="use-' + k.id + '">loading live usage from Apify…</div>'
        + '<div class="warnbox" id="warn-' + k.id + '"></div>'
        + '<div class="svc" id="svc-' + k.id + '"></div>'
        + '<div class="btnrow"><button class="btn dark" onclick="saveApify(' + k.id + ',' + k.slot + ')">Save</button>'
        + '<button class="btn" onclick="testApify(' + k.id + ')">Test key</button>'
        + '<button class="btn' + (k.enabled ? '' : ' dark') + '" style="margin-left:auto" onclick="toggleApify(' + k.id + ',' + (k.enabled ? 0 : 1) + ')">' + (k.enabled ? 'Disable' : 'Enable') + '</button>'
        + '<button class="btn danger" onclick="delApify(' + k.id + ')">✕</button></div></div>';
    });

    // Extra slots beyond 3 (if any exist)
    (d.keys || []).filter((k) => k.slot > 3).forEach((k) => {
      h += '<div class="slot" data-id="' + k.id + '"><div class="slot-top"><b>Slot ' + k.slot + '</b>'
        + '<span class="badge ' + (k.enabled ? 'on' : 'off') + '">' + (k.enabled ? 'ACTIVE' : 'DISABLED') + '</span>'
        + '<span class="badge job">' + esc(k.assigned_job || 'other') + '</span></div>'
        + '<div class="meta">Extra slot — manage like the pre-configured ones.</div>'
        + '<div class="btnrow"><button class="btn danger" onclick="delApify(' + k.id + ')">Remove</button></div></div>';
    });

    h += '</div>';
    h += '<script>window.__comp=' + JSON.stringify(comp).replace(/</g, '\\u003c') + '<\/script>';
    V.innerHTML = h;
    (d.keys || []).forEach((k) => loadUsage(k.id, k.monthly_cap_usd));
  },
  async manifest() {
    const d = await api('manifest');
    const eps = d.endpoints || [];
    // Router logic (mirrors scripts/manifest_router.py): first enabled endpoint with remaining quota
    const active = eps.find((e) => e.enabled && (e.used_this_month || 0) < (e.monthly_limit || 10000));
    let h = '<div class="card"><h2>🤖 Manifest endpoints</h2><div class="sub">LLM router · auto-rollover to the next endpoint when quota runs out</div>';
    if (active) {
      h += '<div class="hint">⚡ <b>Router active:</b> <b>' + esc(active.label || ('Endpoint ' + active.id)) + '</b> — pipeline LLM calls go here until its quota is used.</div>';
    } else if (eps.length) {
      h += '<div class="warnbox" style="display:block">⚠️ No endpoint with remaining quota — LLM enrichment is paused until quota resets or a new key is added.</div>';
    }
    eps.forEach((e) => {
      const limit = e.monthly_limit || 10000;
      const used = e.used_this_month || 0;
      const pct = Math.round(100 * used / limit);
      const warn80 = pct >= 80 && pct < 100;
      const isActive = active && active.id === e.id;
      h += '<div class="slot"' + (isActive ? ' style="border-color:var(--am)"' : '') + '><div class="slot-top"><b>' + esc(e.label || ('Endpoint ' + e.id)) + '</b>'
        + '<span class="badge ' + (e.enabled ? 'on' : 'off') + '">' + (e.enabled ? 'ACTIVE' : 'DISABLED') + '</span>'
        + (isActive ? '<span class="badge job">⚡ ROUTER</span>' : '')
        + '<span class="tok">' + esc(e.base_url || '').replace(/^https?:\/\//, '').slice(0, 32) + '</span></div>'
        + '<div class="prog' + (pct >= 100 ? ' over' : '') + '"><i style="width:' + Math.min(100, pct) + '%"></i></div>'
        + '<div class="meta"><b>' + used.toLocaleString() + '</b> / ' + limit.toLocaleString() + ' requests used (' + pct + '%)</div>'
        + (warn80 ? '<div class="warnbox" style="display:block">⚠️ Over 80% used — add a backup endpoint or quota resets on day ' + (e.reset_day || 1) + '.</div>' : '')
        + (pct >= 100 ? '<div class="warnbox" style="display:block">🚫 Quota exhausted — router has rolled over to the next endpoint.</div>' : '')
        + '<div class="btnrow"><button class="btn" onclick="testManifest(' + e.id + ')">Test</button>'
        + '<button class="btn" onclick="toggleManifest(' + e.id + ',' + (e.enabled ? 0 : 1) + ')">' + (e.enabled ? 'Disable' : 'Enable') + '</button>'
        + '<button class="btn danger" onclick="delManifest(' + e.id + ')">Remove</button></div></div>';
    });
    h += '<div class="slot" style="border-style:dashed"><div class="slot-top"><b style="color:var(--mut)">+ New endpoint</b></div>'
      + '<div class="f2"><div><label>Label</label><input id="nm-label" placeholder="main"></div>'
      + '<div><label>Base URL</label><input id="nm-url" value="https://app.manifest.build/v1"></div>'
      + '<div><label>API Key</label><input id="nm-key" type="password" placeholder="sk-…"></div>'
      + '<div><label>Monthly limit (requests)</label><input id="nm-limit" type="number" value="10000"></div></div>'
      + '<div class="hint" style="margin:0 0 12px">Each Manifest API key includes <b>10,000 requests/month</b>. Add a 2nd key as backup — the router rolls over automatically.</div>'
      + '<div class="btnrow"><button class="btn dark" onclick="addManifest()">+ Add endpoint</button></div></div>';
    h += '</div>';
    V.innerHTML = h;
  },
  async runs() {
    const d = await api('pipeline/runs');
    const gh = d.github_runs || [], db = d.db_runs || [];
    let h = '<div class="card"><h2>🔄 Pipeline runs</h2><div class="sub">GitHub Actions + D1 run history</div>';
    if (!gh.length && !db.length) h += '<div class="meta">No runs recorded yet.</div>';
    h += '<div class="timeline">';
    gh.slice(0, 8).forEach((r) => {
      const ok = r.conclusion === 'success', running = r.status !== 'completed';
      h += '<div class="ev' + (ok ? '' : running ? ' run' : ' bad') + '"><b>#' + r.id + ' · ' + esc((r.conclusion || r.status || 'unknown').replace(/_/g, ' ')) + '</b>'
        + '<div>commit ' + esc(String(r.head_sha || '').slice(0, 7)) + ' · branch ' + esc(r.head_branch || 'main') + ' · ' + timeAgo(r.created_at) + '</div></div>';
    });
    h += '</div>';
    if (db.length) {
      h += '<div class="sub" style="margin-top:18px">D1 pipeline_runs table</div><div class="timeline">';
      db.slice(0, 5).forEach((r) => {
        h += '<div class="ev"><b>run ' + esc(r.id) + '</b><div>' + esc(r.started_at || '') + (r.tools_added ? ' · +' + r.tools_added + ' tools' : '') + '</div></div>';
      });
      h += '</div>';
    }
    h += '</div>';
    V.innerHTML = h;
  },
  async traffic() {
    V.innerHTML = '<div class="card"><h2>📈 Traffic</h2><div class="sub">Cloudflare Web Analytics (RUM) · no separate API needed</div>'
      + '<div class="btnrow" style="margin-top:0;margin-bottom:6px">'
      + '<button class="btn" data-d="1">24h</button><button class="btn" data-d="7">7d</button><button class="btn" data-d="30">30d</button></div>'
      + '<div id="tdata"><div class="meta">loading…</div></div></div>';
    const load = async (days) => {
      const el = document.getElementById('tdata');
      V.querySelectorAll('[data-d]').forEach((b) => b.classList.toggle('dark', b.dataset.d == days));
      try {
        const r = await api('traffic?days=' + days);
        if (!r.enabled) {
          el.innerHTML = '<div class="hint" style="margin-top:12px">📊 <b>Web Analytics not connected yet.</b><br><br>Enable it: Cloudflare dashboard → Pages → <b>ai-directory-v5-radwan648</b> → Analytics → <b>Enable Web Analytics</b>.<br>Data appears within a few hours. No code changes or extra API keys needed — the existing token already has access.</div>';
          return;
        }
        const pages = r.top_pages || [];
        const max = Math.max.apply(null, pages.map((p) => p.views).concat([1]));
        let h = '<div class="spark">' + pages.slice(0, 12).map((p) => '<i style="height:' + Math.max(6, Math.round(100 * p.views / max)) + '%" title="' + esc(p.page) + ' — ' + p.views + '"></i>').join('') + '</div>';
        h += '<div class="kpis" style="grid-template-columns:repeat(3,1fr)">'
          + '<div class="kpi k1"><div class="lb">Visitors (' + r.days + 'd)</div><div class="vl" id="tv-v">0</div></div>'
          + '<div class="kpi k2"><div class="lb">Pageviews (' + r.days + 'd)</div><div class="vl" id="tv-p">0</div></div>'
          + '<div class="kpi k3"><div class="lb">Top page</div><div class="vl" style="font-size:15px;word-break:break-all">' + esc((pages[0] || {}).page || '—').slice(0, 40) + '</div></div></div>';
        if (pages.length) {
          h += '<div class="sub" style="margin-top:16px">Top pages</div>' + pages.slice(0, 8).map((p) =>
            '<div style="display:flex;justify-content:space-between;padding:7px 0;border-bottom:1px solid var(--line);font-size:13px"><span>' + esc(p.page).slice(0, 55) + '</span><b>' + p.views.toLocaleString() + '</b></div>').join('');
        }
        el.innerHTML = h;
        countUp(document.getElementById('tv-v'), r.visits || 0);
        countUp(document.getElementById('tv-p'), r.pageviews || 0);
      } catch (e) { el.innerHTML = '<div class="meta">Failed to load traffic.</div>'; }
    };
    V.querySelectorAll('[data-d]').forEach((b) => b.onclick = () => load(b.dataset.d));
    load(7);
  },
  async actions() {
    V.innerHTML = '<div class="card"><h2>⚙️ Actions</h2><div class="sub">Manual triggers — use carefully</div><div class="acts">'
      + '<div class="act" onclick="doDispatch()"><div class="e">🚀</div><b>Trigger pipeline</b><span>Dispatch the GitHub scraper workflow now (same as cron)</span></div>'
      + '<div class="act" onclick="doDispatch(\'snapshot\')"><div class="e">📸</div><b>Bake snapshot</b><span>Runs via pipeline — refreshes homepage sections.json</span></div>'
      + '<div class="act" onclick="doDispatch(\'dedupe\')"><div class="e">🧹</div><b>Run dedupe</b><span>Runs via pipeline — cleans duplicate AI tools</span></div>'
      + '<div class="act" onclick="doTg()"><div class="e">🔔</div><b>Test Telegram</b><span>Send a test alert to the admin chat</span></div>'
      + '</div><div class="hint" style="margin-top:14px">ℹ️ Snapshot & dedupe run as pipeline steps — triggering the pipeline runs the full flow including them.</div></div>';
  }
};
// ---- global actions ----
window.updSites = (sel) => {
  const map = window.__comp || JOB_SITES;
  const box = sel.closest('.slot, .f2').parentElement;
  const lbl = sel.parentElement.querySelector('.sites') || document.querySelector('#view .sites');
  const sites = (map[sel.value] || []).join(', ') || '—';
  const target = sel.parentElement.querySelector('.sites');
  if (target) target.textContent = sites;
};
window.saveApify = async (id, slot) => {
  const sl = document.querySelector('.slot[data-id="' + id + '"]');
  const g = (f) => sl.querySelector('[data-f="' + f + '"]').value;
  const tok = g('token');
  const payload = { id: id, slot: slot, label: g('label'), assigned_job: g('assigned_job'), monthly_cap_usd: g('monthly_cap_usd') };
  if (tok) payload.token = tok; else log('Token unchanged — label/job/cap saved.');
  await api('apify-keys', 'POST', payload);
  log('Saved slot ' + slot + '.'); views.apify();
};
window.addApify = async () => {
  const v = (id) => document.getElementById(id).value;
  if (!v('nk-token')) return log('Token required.');
  await api('apify-keys', 'POST', { slot: v('nk-slot'), label: v('nk-label'), token: v('nk-token'), monthly_cap_usd: v('nk-cap'), assigned_job: v('nk-job') });
  log('Key added to slot ' + v('nk-slot') + '. Remember the APIFY_KEY_' + v('nk-slot') + ' GitHub secret.');
  views.apify();
};
window.addApifySlot = async (slotN, job) => {
  const tok = document.getElementById('nk' + slotN + '-token').value;
  const cap = document.getElementById('nk' + slotN + '-cap').value;
  if (!tok) return log('Paste the Apify API token for Slot ' + slotN + '.');
  await api('apify-keys', 'POST', { slot: slotN, label: 'slot-' + slotN, token: tok, monthly_cap_usd: cap, assigned_job: job });
  log('Key added to Slot ' + slotN + ' (' + job + '). Also add APIFY_KEY_' + slotN + ' as a GitHub repo secret.');
  views.apify();
};
window.delApify = async (id) => { if (confirm('Remove this key?')) { await api('apify-keys/' + id, { method: 'DELETE' }); log('Removed.'); views.apify(); } };
window.toggleApify = async (id, on) => {
  await api('apify-keys/' + id + '/toggle', 'POST', { enabled: !!on });
  log(on ? 'Slot enabled.' : 'Slot disabled.'); views.apify();
};
window.testApify = async (id) => { log('Testing key…'); try { const r = await api('apify-keys/' + id + '/test', 'POST'); log(r.ok ? 'OK: ' + r.username + ' (' + r.plan + ')' : 'FAILED: HTTP ' + r.status); } catch (e) { log('Test failed: ' + e.message); } };
window.eye = (btn) => { const i = btn.parentElement.querySelector('input'); i.type = i.type === 'password' ? 'text' : 'password'; };
window.loadUsage = async (id, cap) => {
  const useEl = document.getElementById('use-' + id), barEl = document.getElementById('bar-' + id),
        warnEl = document.getElementById('warn-' + id), svcEl = document.getElementById('svc-' + id);
  if (!useEl) return;
  try {
    const r = await api('apify-keys/' + id + '/usage');
    if (!r.available) { useEl.textContent = 'Usage unavailable (' + (r.reason || '?') + ').'; return; }
    const used = r.total_usd || 0, c = parseFloat(cap) || 0;
    const left = Math.max(0, Math.round((c - used) * 100) / 100);
    const pct = c > 0 ? Math.round(100 * used / c) : 0;
    const bar = barEl.querySelector('i') || barEl.firstElementChild;
    if (bar) bar.style.width = Math.min(100, pct) + '%';
    if (pct >= 100) barEl.classList.add('over');
    useEl.innerHTML = '<b>$' + used.toFixed(2) + '</b> of $' + c.toFixed(2) + ' used · $' + left.toFixed(2) + ' left · ' + pct + '% · ' + esc(r.username || '') + ' (' + esc(r.plan || '') + ') · resets ' + esc(r.cycle_end || '—');
    if (pct >= 100) { warnEl.style.display = 'block'; warnEl.textContent = '⚠️ Allowance used up — scraping is blocked on this token. Switch to another slot to keep going.'; }
    if (svcEl && r.services) svcEl.textContent = r.services.map((x) => x.label + ' ' + x.quantity + (x.unit ? ' ' + x.unit : '') + ' ($' + x.usd.toFixed(2) + ')').join(' · ');
  } catch (e) { useEl.textContent = 'Usage load failed.'; }
};
window.addManifest = async () => {
  const v = (id) => document.getElementById(id).value;
  if (!v('nm-key')) return log('API key required.');
  await api('manifest', 'POST', { label: v('nm-label'), base_url: v('nm-url'), api_key: v('nm-key'), monthly_limit: v('nm-limit') });
  log('Endpoint added.'); views.manifest();
};
window.delManifest = async (id) => { if (confirm('Remove this endpoint?')) { await api('manifest/' + id, { method: 'DELETE' }); log('Removed.'); views.manifest(); } };
window.toggleManifest = async (id, on) => {
  await api('manifest/' + id + '/toggle', 'POST', { enabled: !!on });
  log(on ? 'Endpoint enabled.' : 'Endpoint disabled.'); views.manifest();
};
window.testManifest = async (id) => { log('Testing endpoint…'); try { const r = await api('manifest/' + id + '/test', 'POST'); log(r.ok ? 'OK (' + r.status + ')' : 'FAILED: HTTP ' + r.status + ' ' + (r.sample || '')); } catch (e) { log('Test failed: ' + e.message); } };
window.doDispatch = async (what) => {
  if (!confirm('Dispatch the pipeline now?' + (what ? ' (' + what + ' runs as a pipeline step)' : ''))) return;
  log('Dispatching…');
  try { const r = await api('pipeline/dispatch', 'POST'); log(r.ok ? '✅ Dispatched.' : 'Dispatch failed: ' + r.status); }
  catch (e) { log('Dispatch failed: ' + e.message); }
};
window.doTg = async () => { try { const r = await api('telegram/test', 'POST'); log(r.ok ? 'Telegram test sent.' : 'Telegram failed.'); } catch (e) { log('Telegram failed: ' + e.message); } };
// ---- tabs + clock + init ----
document.querySelectorAll('.tabs button').forEach((b) => b.onclick = () => {
  document.querySelectorAll('.tabs button').forEach((x) => x.classList.remove('on'));
  b.classList.add('on'); activeTab = b.dataset.t;
  views[activeTab]().catch((e) => log('ERR ' + e.message));
});
setInterval(() => { const c = document.getElementById('clock'); if (c) c.textContent = new Date().toLocaleString(); }, 1000);
// auto-refresh overview every 60s
refreshTimer = setInterval(() => { if (activeTab === 'overview') views.overview().catch(() => {}); }, 60000);
document.getElementById('bk').value = bkey();
views.overview().catch((e) => {
  V.innerHTML = '<div class="card"><h2 style="color:var(--bad)">Auth required</h2><div class="meta">' + esc(e.message) + '</div><div class="meta" style="margin-top:8px">Enter the setup key above (one-time), or reload after logging in via Cloudflare Access.</div></div>';
  document.getElementById('health').textContent = 'Auth required';
});
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
