/**
 * The browse page — /tools.
 *
 * Modelled on how beyondtools.io arranges its tools: one page where search,
 * category facets, a price facet, a source facet, a live count and a paginated
 * grid all live together, with the homepage acting only as an entry point.
 *
 * Every control writes to the query string, so a filtered view is a real URL
 * that can be shared, bookmarked and crawled:
 *   /tools?category=Coding&pricing=free&sort=views&page=2
 *
 * The page is server-rendered from the worker's /api/tools, which already
 * supports all eleven filters, so no backend change was needed. When that call
 * fails - in practice an exhausted D1 read quota - the page rebuilds the same
 * answer from /data/offline.json, the static dataset the pipeline bakes, so the
 * listing is never blank.
 */

const WORKER = 'https://ai-directory-v5-worker.radwanislam648.workers.dev';
const SITE = 'https://ai-directory-v5-radwan648.pages.dev';
const PER_PAGE = 40;

const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const oneLine = (s, n) => esc(String(s || '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, n));
const priceOf = (p) => { const v = String(p || '').toLowerCase(); return v === 'free' ? 'Free' : v === 'paid' ? 'Paid' : v === 'freemium' ? 'Freemium' : ''; };
const hostOf = (u) => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch (e) { return ''; } };
const num = (n) => Number(n || 0).toLocaleString('en-US');

const PRICES = ['', 'free', 'freemium', 'paid'];
const SORTS = [['newest', 'Newest'], ['views', 'Most viewed'], ['name', 'A–Z']];
const SOURCES = [['', 'Any source'], ['producthunt', 'Product Hunt'], ['huggingface', 'HuggingFace'], ['github', 'GitHub'], ['hackernews', 'Hacker News']];

function favicon(t) {
  const host = hostOf(t.url);
  if (!host) return '';
  return 'https://www.google.com/s2/favicons?domain=' + encodeURIComponent(host) + '&sz=64';
}

function card(t) {
  const price = priceOf(t.pricing);
  const host = hostOf(t.url);
  const slug = encodeURIComponent(t.slug || '');
  return `<article class="card" data-slug="${esc(t.slug || '')}">
    <div class="card-top">
      <img class="card-logo" src="${esc(t.logo_url || favicon(t))}" alt="" loading="lazy" width="28" height="28"
           onerror="this.style.visibility='hidden'">
      <div>
        <h3><a href="/tool/${slug}">${esc(t.name)}</a></h3>
        <p class="card-meta">${esc(t.category || 'Uncategorised')}${host ? ' · ' + esc(host) : ''}</p>
      </div>
      ${price ? `<span class="badge badge-${esc(price.toLowerCase())}">${esc(price)}</span>` : ''}
    </div>
    <p class="card-desc">${oneLine(t.short_desc || t.description, 130)}</p>
    <div class="card-actions">
      <a class="btn-visit" href="${esc(t.url || '#')}" rel="nofollow noopener" target="_blank">Visit →</a>
      <a class="btn-quiet" href="/alternatives/${slug}">Alternatives</a>
      <a class="btn-quiet" href="/compare/${slug}">Compare</a>
    </div>
  </article>`;
}

/** Build a /tools URL from the current filters, overriding some of them. */
function link(params, over) {
  const next = new URLSearchParams();
  for (const [k, v] of params) if (v !== '' && k !== 'page') next.set(k, v);
  for (const [k, v] of Object.entries(over || {})) {
    if (v === '' || v == null) next.delete(k);
    else next.set(k, v);
  }
  const s = next.toString();
  return '/tools' + (s ? '?' + s : '');
}

function chip(params, key, value, label, active) {
  return `<a class="facet${active ? ' is-on' : ''}" href="${esc(link(params, { [key]: value, page: '' }))}">${esc(label)}</a>`;
}

/** Same answer as the worker's, rebuilt from the baked dataset. */
async function fromSnapshot(context, params) {
  let snap;
  try {
    const r = await fetch(new URL('/data/offline.json', context.request.url));
    if (!r.ok) return null;
    snap = await r.json();
  } catch (e) { return null; }
  if (!snap || !Array.isArray(snap.tools)) return null;

  const eq = (a, b) => String(a || '').toLowerCase() === String(b || '').toLowerCase();
  let list = snap.tools.slice();
  const g = (k) => (params.get(k) || '').trim();
  if (g('category')) list = list.filter((t) => eq(t.category, g('category')));
  if (g('pricing')) list = list.filter((t) => eq(t.pricing, g('pricing')));
  if (g('featured') === '1') list = list.filter((t) => Number(t.featured) === 1);
  if (g('q')) {
    const need = g('q').toLowerCase();
    list = list.filter((t) => (String(t.name || '') + ' ' + (t.short_desc || '') + ' ' + (t.category || '')).toLowerCase().includes(need));
  }
  if (g('days')) {
    const since = Date.now() - Number(g('days')) * 864e5;
    list = list.filter((t) => new Date(String(t.created_at || '').replace(' ', 'T') + 'Z').getTime() >= since);
  }
  const sort = g('sort') || 'newest';
  if (sort === 'views') list.sort((a, b) => (b.views || 0) - (a.views || 0));
  else if (sort === 'name') list.sort((a, b) => String(a.name).localeCompare(String(b.name)));
  else list.sort((a, b) => String(b.created_at || '').localeCompare(String(a.created_at || '')));

  const page = Math.max(1, parseInt(g('page') || '1', 10));
  return { tools: list.slice((page - 1) * PER_PAGE, page * PER_PAGE), total: list.length, offline: true };
}

export async function onRequest(context) {
  const params = new URL(context.request.url).searchParams;
  const page = Math.max(1, parseInt(params.get('page') || '1', 10));
  const sort = params.get('sort') || 'newest';
  const category = params.get('category') || '';
  const pricing = params.get('pricing') || '';
  const source = params.get('source') || '';
  const q = params.get('q') || '';

  const api = new URLSearchParams();
  api.set('limit', String(PER_PAGE));
  api.set('page', String(page));
  api.set('sort', sort);
  for (const k of ['category', 'pricing', 'source', 'tag']) if (params.get(k)) api.set(k, params.get(k));
  if (q) api.set('q', q);
  if (params.get('featured')) api.set('featured', params.get('featured'));
  if (params.get('days')) api.set('days', params.get('days'));

  let data = null;
  try {
    const r = await fetch(`${WORKER}/api/tools?${api.toString()}`);
    if (r.ok) data = await r.json();
  } catch (e) { /* fall through to the baked copy */ }
  if (!data || !Array.isArray(data.tools)) data = await fromSnapshot(context, params);
  if (!data) data = { tools: [], total: 0, unavailable: true };

  let cats = [];
  try {
    const r = await fetch(`${WORKER}/api/categories`);
    if (r.ok) cats = (await r.json()).categories || [];
  } catch (e) { /* categories are optional decoration here */ }

  const total = data.total || 0;
  const pages = Math.max(1, Math.ceil(total / PER_PAGE));
  const bits = [];
  if (category) bits.push(category);
  if (pricing) bits.push(priceOf(pricing));
  if (source) bits.push(source);
  if (q) bits.push(`“${q}”`);
  const heading = bits.length ? `AI tools: ${bits.join(' · ')}` : 'All AI tools';
  const title = `${heading} — ${num(total)} listed | AI Directory`;
  const description = `${num(total)} AI tools${bits.length ? ' matching ' + bits.join(', ') : ''}, with pricing, category and a link to each official site. Page ${page} of ${pages}.`;
  const canonical = SITE + link(params, {});

  const shown = data.tools || [];
  const grid = shown.length ? shown.map(card).join('') : '<p class="empty">Nothing matches those filters yet. Try clearing one.</p>';

  const catChips = [
    chip(params, 'category', '', 'All categories', !category),
    ...cats.slice(0, 14).map((c) => chip(params, 'category', c.name, `${c.name}`, category === c.name)),
  ].join('');
  const priceChips = PRICES.map((p) => chip(params, 'pricing', p, p ? priceOf(p) : 'All prices', pricing === p)).join('');
  const sortOpts = SORTS.map(([v, l]) => `<option value="${esc(v)}"${sort === v ? ' selected' : ''}>${esc(l)}</option>`).join('');
  const srcOpts = SOURCES.map(([v, l]) => `<option value="${esc(v)}"${source === v ? ' selected' : ''}>${esc(l)}</option>`).join('');
  const prev = page > 1 ? `<a class="page" href="${esc(link(params, { page: String(page - 1) }))}">← Previous</a>` : '<span></span>';
  const next = page < pages ? `<a class="page" href="${esc(link(params, { page: String(page + 1) }))}">Next →</a>` : '<span></span>';

  const jsonld = JSON.stringify({
    '@context': 'https://schema.org', '@type': 'ItemList',
    name: heading, numberOfItems: total,
    itemListElement: shown.slice(0, 40).map((t, i) => ({
      '@type': 'ListItem', position: (page - 1) * PER_PAGE + i + 1,
      item: { '@type': 'SoftwareApplication', name: t.name, applicationCategory: t.category || undefined, url: t.url || undefined },
    })),
  });

  const html = `<!doctype html>
<html lang="en" data-theme="light">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title>
<meta name="description" content="${esc(description)}">
<link rel="canonical" href="${esc(canonical)}">
<meta property="og:title" content="${esc(heading)}">
<meta property="og:description" content="${esc(description)}">
<link rel="stylesheet" href="/css/app.css">
<style>
  .browse{max-width:1120px;margin:0 auto;padding:24px 16px}
  .bar{display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin:12px 0}
  .bar form{display:flex;gap:6px;flex:1 1 260px}
  .bar input,.bar select{padding:8px 10px;border:1px solid var(--border,#ddd);border-radius:8px;font:inherit;font-size:13px;background:var(--bg,#fff);color:inherit}
  .bar input{flex:1}
  .facets{display:flex;gap:6px;flex-wrap:wrap;margin:6px 0}
  .facet{font-size:12px;padding:5px 10px;border:1px solid var(--border,#ddd);border-radius:999px;text-decoration:none;color:inherit;white-space:nowrap}
  .facet.is-on{background:var(--fg,#111);color:var(--bg,#fff);border-color:var(--fg,#111)}
  .count{font-size:12px;opacity:.7;margin:10px 0}
  .results{display:grid;grid-template-columns:repeat(auto-fill,minmax(250px,1fr));gap:12px}
  .card{border:1px solid var(--border,#eee);border-radius:12px;padding:12px;display:flex;flex-direction:column;gap:8px}
  .card-top{display:flex;gap:9px;align-items:flex-start}
  .card-logo{border-radius:6px;flex:none;background:var(--border,#f0f0f0)}
  .card h3{margin:0;font-size:14px;line-height:1.25}
  .card h3 a{text-decoration:none;color:inherit}
  .card-meta{margin:2px 0 0;font-size:11px;opacity:.65}
  .card-desc{margin:0;font-size:12px;opacity:.8;line-height:1.4}
  .card-actions{display:flex;gap:8px;flex-wrap:wrap;margin-top:auto;font-size:12px}
  .btn-visit{padding:5px 10px;border-radius:7px;background:var(--fg,#111);color:var(--bg,#fff);text-decoration:none}
  .btn-quiet{opacity:.7;text-decoration:none;align-self:center}
  .badge{font-size:10px;padding:2px 7px;border-radius:999px;border:1px solid var(--border,#ddd);white-space:nowrap}
  .badge-free{border-color:#3fa96a;color:#3fa96a}
  .pager{display:flex;justify-content:space-between;align-items:center;margin:20px 0;font-size:13px}
  .page{padding:6px 12px;border:1px solid var(--border,#ddd);border-radius:8px;text-decoration:none;color:inherit}
  .empty{padding:28px;text-align:center;font-size:13px;opacity:.7}
  .note{font-size:12px;opacity:.65;margin:0 0 8px}
</style>
<script type="application/ld+json">${jsonld}</script>
</head>
<body>
<div class="browse">
<nav style="font-size:12px;margin-bottom:14px"><a href="/">Home</a> › <span>All tools</span></nav>
<h1 style="font-size:24px;margin:0 0 4px">${esc(heading)}</h1>
<p style="font-size:13px;opacity:.75;margin:0">${esc(description)}</p>
${data.offline ? '<p class="note">Showing the last saved copy — live data is unavailable right now.</p>' : ''}

<div class="bar">
  <form action="/tools" method="get" role="search">
    ${category ? `<input type="hidden" name="category" value="${esc(category)}">` : ''}
    ${pricing ? `<input type="hidden" name="pricing" value="${esc(pricing)}">` : ''}
    <input type="search" name="q" value="${esc(q)}" placeholder="Search ${num(total)} tools…" aria-label="Search tools">
    <button class="page" type="submit">Search</button>
  </form>
  <form action="/tools" method="get">
    ${category ? `<input type="hidden" name="category" value="${esc(category)}">` : ''}
    ${pricing ? `<input type="hidden" name="pricing" value="${esc(pricing)}">` : ''}
    ${q ? `<input type="hidden" name="q" value="${esc(q)}">` : ''}
    <select name="sort" onchange="this.form.submit()" aria-label="Sort">${sortOpts}</select>
    <select name="source" onchange="this.form.submit()" aria-label="Source">${srcOpts}</select>
    <noscript><button class="page" type="submit">Apply</button></noscript>
  </form>
</div>

<div class="facets">${priceChips}</div>
<div class="facets">${catChips}${cats.length > 14 ? `<a class="facet" href="/">more…</a>` : ''}</div>

<p class="count">${num(total)} tool${total === 1 ? '' : 's'} · page ${page} of ${pages}</p>
<div class="results">${grid}</div>
<div class="pager">${prev}<span>Page ${page} of ${pages}</span>${next}</div>

<p style="font-size:13px;margin-top:18px">Can’t find a tool? <a href="/">Tell us about it</a>.</p>
<p style="margin-top:10px;font-size:12px;opacity:.7"><a href="/">← Back to the directory</a></p>
</div>
</body>
</html>`;

  return new Response(html, {
    status: 200,
    headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'public, max-age=1800' },
  });
}
