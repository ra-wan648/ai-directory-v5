/**
 * Server-rendered "alternatives to X" page at /alternatives/<slug>.
 *
 * The worker has served this data at /alternatives/:slug all along, but the
 * Pages proxy (functions/[[path]].js) only forwards /api/*, /og/* and a few
 * exact paths, so the route was unreachable from the public site and every
 * request 404'd. A page function is the right home for it: the data is read
 * server-side and rendered as HTML, so it is crawlable instead of raw JSON.
 */

const WORKER = 'https://ai-directory-v5-worker.radwanislam648.workers.dev';
const SITE = 'https://ai-directory-v5-radwan648.pages.dev';

const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const priceOf = (p) => { const v = String(p || '').toLowerCase(); return v === 'free' ? 'Free' : v === 'paid' ? 'Paid' : v === 'freemium' ? 'Freemium' : ''; };
const oneLine = (s, n) => esc(String(s || '').replace(/\s+/g, ' ').slice(0, n));

export async function onRequest(context) {
  const slug = decodeURIComponent(String(context.params.slug || ''));
  let tool = null;
  let alts = [];
  try {
    const r = await fetch(`${WORKER}/alternatives/${encodeURIComponent(slug)}`);
    if (r.ok) {
      const d = await r.json();
      tool = d.tool || null;
      alts = d.alternatives || [];
    }
  } catch (e) { /* fall through to the empty state */ }

  if (!tool) {
    return new Response(
      '<!doctype html><meta charset="utf-8"><title>Not found | AI Directory</title>'
      + '<p style="font-family:system-ui;padding:40px">No tool with that slug. '
      + '<a href="/">Back to the directory</a></p>',
      { status: 404, headers: { 'content-type': 'text/html; charset=utf-8' } },
    );
  }

  const name = tool.name || slug;
  const cat = tool.category || 'AI';
  // The category is often already "AI Tools", which read as "similar AI Tools
  // tools" in the title.
  const catLabel = /tool/i.test(cat) ? cat : `${cat} tools`;
  const title = `${name} alternatives — ${alts.length} ${catLabel} to consider | AI Directory`;
  const description = `Alternatives to ${name} in ${cat}: ${alts.slice(0, 6).map((t) => t.name).join(', ') || 'none listed yet'}. Compare pricing and links.`;

  const rows = alts.map((t) => `<li style="padding:8px 0;border-bottom:1px solid var(--border,#eee)">
    <a href="/tool/${encodeURIComponent(t.slug)}"><b>${esc(t.name)}</b></a>
    <span style="font-size:12px;opacity:.7"> · ${esc(priceOf(t.pricing))}</span>
    <div style="font-size:12px;opacity:.75">${oneLine(t.short_desc || t.description, 150)}</div>
    <div style="font-size:12px"><a href="/alternatives/${encodeURIComponent(t.slug)}">${esc(t.name)} alternatives</a></div>
  </li>`).join('');

  const html = `<!doctype html>
<html lang="en" data-theme="light">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title>
<meta name="description" content="${esc(description)}">
<link rel="canonical" href="${SITE}/alternatives/${encodeURIComponent(slug)}">
<link rel="stylesheet" href="/css/app.css">
</head>
<body>
<div class="wrap" style="max-width:860px;margin:0 auto;padding:28px 16px">
<nav style="font-size:12px;margin-bottom:16px"><a href="/">Home</a> › <a href="/tool/${encodeURIComponent(slug)}">${esc(name)}</a> › <span>Alternatives</span></nav>
<h1 style="font-size:24px;margin:0 0 6px">${esc(name)} alternatives</h1>
<p style="font-size:13px;opacity:.75;margin:0 0 6px">${oneLine(tool.short_desc || tool.description, 220)}</p>
<p style="font-size:13px;opacity:.75;margin:0 0 20px">${alts.length} other ${esc(cat)} tools listed. <a href="${esc(tool.url || '#')}" rel="nofollow noopener" target="_blank">Visit ${esc(name)}</a>.</p>
${rows ? `<ul style="list-style:none;padding:0;margin:0">${rows}</ul>` : '<p style="font-size:13px">No alternatives listed yet.</p>'}
<p style="margin-top:22px;font-size:12px;opacity:.7">Listings are collected automatically from public sources.</p>
<p style="margin-top:10px"><a href="/">← Back to the directory</a></p>
</div>
</body>
</html>`;

  return new Response(html, {
    status: 200,
    headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'public, max-age=3600' },
  });
}
