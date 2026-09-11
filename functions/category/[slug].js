/**
 * Server-rendered category page — a crawlable listing at /category/<name>.
 */

const WORKER = 'https://ai-directory-v5-worker.radwanislam648.workers.dev';
const SITE = 'https://ai-directory-v5-radwan648.pages.dev';

const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const priceOf = (p) => { const v = String(p || '').toLowerCase(); return v === 'free' ? 'Free' : v === 'paid' ? 'Paid' : v === 'freemium' ? 'Freemium' : ''; };

export async function onRequest(context) {
  const cat = decodeURIComponent(String(context.params.slug || ''));
  let tools = [];
  let total = 0;
  try {
    const r = await fetch(`${WORKER}/api/tools?category=${encodeURIComponent(cat)}&limit=60&sort=newest`);
    if (r.ok) { const d = await r.json(); tools = d.tools || []; total = d.total || 0; }
  } catch (e) { /* empty state below */ }

  const title = `${cat} AI tools — ${total} listed | AI Directory`;
  const description = `Browse ${total} ${cat} AI tools collected from public sources, with pricing and links to each official site.`;

  const rows = tools.map((t) => `<li style="padding:7px 0;border-bottom:1px solid var(--border,#eee)">
    <a href="/tool/${encodeURIComponent(t.slug)}"><b>${esc(t.name)}</b></a>
    <span style="font-size:12px;opacity:.7"> · ${esc(priceOf(t.pricing))}</span>
    <div style="font-size:12px;opacity:.75">${esc(String(t.short_desc || t.description || '').replace(/\s+/g, ' ').slice(0, 140))}</div>
  </li>`).join('');

  const html = `<!doctype html>
<html lang="en" data-theme="light">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title>
<meta name="description" content="${esc(description)}">
<link rel="canonical" href="${SITE}/category/${encodeURIComponent(cat)}">
<link rel="stylesheet" href="/css/app.css">
</head>
<body>
<div class="wrap" style="max-width:860px;margin:0 auto;padding:28px 16px">
<nav style="font-size:12px;margin-bottom:16px"><a href="/">Home</a> › <span>${esc(cat)}</span></nav>
<h1 style="font-size:24px;margin:0 0 6px">${esc(cat)} AI tools</h1>
<p style="font-size:13px;opacity:.75;margin:0 0 20px">${total ? total.toLocaleString('en-US') : 'No'} listings in this category, refreshed daily.</p>
${rows ? `<ul style="list-style:none;padding:0;margin:0">${rows}</ul>` : '<p style="font-size:13px">Nothing listed in this category yet.</p>'}
<p style="margin-top:22px;font-size:12px;opacity:.7">Listings are collected automatically from public sources.</p>
<p style="margin-top:10px"><a href="/">← Back to the directory</a></p>
</div>
</body>
</html>`;

  return new Response(html, {
    status: tools.length ? 200 : 404,
    headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'public, max-age=600' },
  });
}
