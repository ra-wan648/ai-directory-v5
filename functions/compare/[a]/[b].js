/**
 * Server-rendered comparison page at /compare/<a>/<b>.
 *
 * The worker has served /compare/:a/:b all along, but the Pages proxy only
 * forwards /api/*, /og/* and a few exact paths, so the route 404'd for every
 * visitor. Rendering it here makes it a crawlable page rather than raw JSON.
 */

const WORKER = 'https://ai-directory-v5-worker.radwanislam648.workers.dev';
const SITE = 'https://ai-directory-v5-radwan648.pages.dev';

const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const priceOf = (p) => { const v = String(p || '').toLowerCase(); return v === 'free' ? 'Free' : v === 'paid' ? 'Paid' : v === 'freemium' ? 'Freemium' : (p ? esc(p) : '—'); };
const oneLine = (s, n) => esc(String(s || '').replace(/\s+/g, ' ').slice(0, n));

function notFound(msg) {
  return new Response(
    `<!doctype html><meta charset="utf-8"><title>Not found | AI Directory</title>`
    + `<p style="font-family:system-ui;padding:40px">${esc(msg)} `
    + `<a href="/">Back to the directory</a></p>`,
    { status: 404, headers: { 'content-type': 'text/html; charset=utf-8' } },
  );
}

export async function onRequest(context) {
  const a = decodeURIComponent(String(context.params.a || ''));
  const b = decodeURIComponent(String(context.params.b || ''));
  if (!a || !b) return notFound('Two tools are needed to compare.');

  let tool1 = null;
  let tool2 = null;
  try {
    const r = await fetch(`${WORKER}/compare/${encodeURIComponent(a)}/${encodeURIComponent(b)}`);
    if (r.ok) {
      const d = await r.json();
      tool1 = d.tool1 || null;
      tool2 = d.tool2 || null;
    }
  } catch (e) { /* fall through */ }

  if (!tool1 || !tool2) return notFound('One or both of those tools were not found.');

  const t1 = tool1.name || a;
  const t2 = tool2.name || b;
  const title = `${t1} vs ${t2} — comparison | AI Directory`;
  const description = `Compare ${t1} and ${t2}: category, pricing, features and links to each official site.`;

  const row = (label, v1, v2) => `<tr>
    <th style="text-align:left;padding:8px 10px;font-weight:600;vertical-align:top;width:150px">${esc(label)}</th>
    <td style="padding:8px 10px;vertical-align:top">${v1}</td>
    <td style="padding:8px 10px;vertical-align:top">${v2}</td>
  </tr>`;

  const features = (t) => {
    let f = t.features;
    if (typeof f === 'string') { try { f = JSON.parse(f); } catch (e) { f = []; } }
    return Array.isArray(f) && f.length ? esc(f.slice(0, 6).join(', ')) : '—';
  };

  const head = (t, slug) => `<a href="/tool/${encodeURIComponent(slug)}"><b>${esc(t.name)}</b></a>`;

  const html = `<!doctype html>
<html lang="en" data-theme="light">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title>
<meta name="description" content="${esc(description)}">
<link rel="canonical" href="${SITE}/compare/${encodeURIComponent(a)}/${encodeURIComponent(b)}">
<link rel="stylesheet" href="/css/app.css">
</head>
<body>
<div class="wrap" style="max-width:880px;margin:0 auto;padding:28px 16px">
<nav style="font-size:12px;margin-bottom:16px"><a href="/">Home</a> › <span>Compare</span></nav>
<h1 style="font-size:24px;margin:0 0 6px">${esc(t1)} vs ${esc(t2)}</h1>
<p style="font-size:13px;opacity:.75;margin:0 0 20px">Side-by-side view of the two listings. Pricing and features are as recorded in the directory.</p>
<table style="width:100%;border-collapse:collapse;font-size:13px">
<thead><tr>
<th style="text-align:left;padding:8px 10px;border-bottom:2px solid var(--border,#ddd)">Field</th>
<th style="text-align:left;padding:8px 10px;border-bottom:2px solid var(--border,#ddd)">${head(tool1, a)}</th>
<th style="text-align:left;padding:8px 10px;border-bottom:2px solid var(--border,#ddd)">${head(tool2, b)}</th>
</tr></thead>
<tbody>
${row('Category', esc(tool1.category || '—'), esc(tool2.category || '—'))}
${row('Pricing', priceOf(tool1.pricing), priceOf(tool2.pricing))}
${row('Summary', oneLine(tool1.short_desc || tool1.description, 200), oneLine(tool2.short_desc || tool2.description, 200))}
${row('Features', features(tool1), features(tool2))}
${row('Website', `<a href="${esc(tool1.url || '#')}" rel="nofollow noopener" target="_blank">${esc(t1)}</a>`, `<a href="${esc(tool2.url || '#')}" rel="nofollow noopener" target="_blank">${esc(t2)}</a>`)}
${row('Alternatives', `<a href="/alternatives/${encodeURIComponent(a)}">${esc(t1)} alternatives</a>`, `<a href="/alternatives/${encodeURIComponent(b)}">${esc(t2)} alternatives</a>`)}
</tbody>
</table>
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
