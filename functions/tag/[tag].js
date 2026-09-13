/**
 * Server-rendered listing at /tag/<tag>.
 *
 * The worker implements /tag/:tag, but the Pages proxy only forwards /api/*,
 * /og/* and a few exact paths, so the route 404'd for every visitor. The worker
 * endpoint is still the source: this page reads it server-side and renders HTML
 * so the tag pages are crawlable instead of returning raw JSON.
 */

const WORKER = 'https://ai-directory-v5-worker.radwanislam648.workers.dev';
const SITE = 'https://ai-directory-v5-radwan648.pages.dev';

const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const priceOf = (p) => { const v = String(p || '').toLowerCase(); return v === 'free' ? 'Free' : v === 'paid' ? 'Paid' : v === 'freemium' ? 'Freemium' : ''; };
const oneLine = (s, n) => esc(String(s || '').replace(/\s+/g, ' ').slice(0, n));

export async function onRequest(context) {
  const tag = decodeURIComponent(String(context.params.tag || ''));
  let tools = [];
  let total = 0;
  try {
    const r = await fetch(`${WORKER}/tag/${encodeURIComponent(tag)}?limit=60`);
    if (r.ok) {
      const d = await r.json();
      tools = d.tools || [];
      total = d.total || 0;
    }
  } catch (e) { /* empty state below */ }

  // Lowercase slugs read badly at the start of a title.
  const tagLabel = tag.charAt(0).toUpperCase() + tag.slice(1);
  const title = `${tagLabel} AI tools — ${total} listed | AI Directory`;
  const description = `AI tools tagged ${tag}: ${total} listings with pricing and links to each official site, refreshed daily.`;

  const rows = tools.map((t) => `<li style="padding:8px 0;border-bottom:1px solid var(--border,#eee)">
    <a href="/tool/${encodeURIComponent(t.slug)}"><b>${esc(t.name)}</b></a>
    <span style="font-size:12px;opacity:.7"> · ${esc(priceOf(t.pricing))}</span>
    <div style="font-size:12px;opacity:.75">${oneLine(t.short_desc || t.description, 150)}</div>
    <div style="font-size:12px"><a href="/alternatives/${encodeURIComponent(t.slug)}">alternatives</a></div>
  </li>`).join('');

  const html = `<!doctype html>
<html lang="en" data-theme="light">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title>
<meta name="description" content="${esc(description)}">
<link rel="canonical" href="${SITE}/tag/${encodeURIComponent(tag)}">
<link rel="stylesheet" href="/css/app.css">
</head>
<body>
<div class="wrap" style="max-width:860px;margin:0 auto;padding:28px 16px">
<nav style="font-size:12px;margin-bottom:16px"><a href="/">Home</a> › <span>${esc(tagLabel)}</span></nav>
<h1 style="font-size:24px;margin:0 0 6px">AI tools tagged ${esc(tag)}</h1>
<p style="font-size:13px;opacity:.75;margin:0 0 20px">${total ? total.toLocaleString('en-US') : 'No'} listings carry this tag, refreshed daily.</p>
${rows ? `<ul style="list-style:none;padding:0;margin:0">${rows}</ul>` : '<p style="font-size:13px">Nothing carries this tag yet.</p>'}
<p style="margin-top:22px;font-size:12px;opacity:.7">Listings are collected automatically from public sources.</p>
<p style="margin-top:10px"><a href="/">← Back to the directory</a></p>
</div>
</body>
</html>`;

  return new Response(html, {
    status: tools.length ? 200 : 404,
    headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'public, max-age=1800' },
  });
}
