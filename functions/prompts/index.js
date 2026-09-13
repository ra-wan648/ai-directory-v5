/**
 * Server-rendered prompt index at /prompts.
 *
 * sitemap.xml advertises /prompts but no function handled it, so it answered
 * 404 while the sitemap pointed at it.
 */

const WORKER = 'https://ai-directory-v5-worker.radwanislam648.workers.dev';
const SITE = 'https://ai-directory-v5-radwan648.pages.dev';

const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const oneLine = (s, n) => esc(String(s || '').replace(/\s+/g, ' ').slice(0, n));

export async function onRequest(context) {
  const url = new URL(context.request.url);
  const page = Math.max(1, parseInt(url.searchParams.get('page') || '1', 10));
  let list = [];
  let total = 0;
  try {
    const r = await fetch(`${WORKER}/api/prompts?limit=24&page=${page}`);
    if (r.ok) {
      const d = await r.json();
      list = d.prompts || [];
      total = d.total || 0;
    }
  } catch (e) { /* empty state below */ }

  const rows = list.map((p) => `<li style="padding:10px 0;border-bottom:1px solid var(--border,#eee)">
    <b>${esc(p.title || p.name)}</b>
    ${p.category ? `<span style="font-size:12px;opacity:.7"> · ${esc(p.category)}</span>` : ''}
    <div style="font-size:12px;opacity:.75">${oneLine(p.description || p.prompt, 160)}</div>
  </li>`).join('');

  const prev = page > 1 ? `<a href="/prompts?page=${page - 1}">← Newer</a>` : '';
  const next = list.length >= 24 ? `<a href="/prompts?page=${page + 1}">Older →</a>` : '';

  const html = `<!doctype html>
<html lang="en" data-theme="light">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>AI prompts library | AI Directory</title>
<meta name="description" content="A library of prompts for AI tools, with the tools each one works with.">
<link rel="canonical" href="${SITE}/prompts">
<link rel="stylesheet" href="/css/app.css">
</head>
<body>
<div class="wrap" style="max-width:820px;margin:0 auto;padding:28px 16px">
<nav style="font-size:12px;margin-bottom:16px"><a href="/">Home</a> › <span>Prompts</span></nav>
<h1 style="font-size:24px;margin:0 0 6px">Prompts</h1>
<p style="font-size:13px;opacity:.75;margin:0 0 20px">${total ? total.toLocaleString('en-US') : 'No'} prompts listed.</p>
${rows ? `<ul style="list-style:none;padding:0;margin:0">${rows}</ul>` : '<p style="font-size:13px">No prompts published yet.</p>'}
<p style="margin-top:22px;font-size:13px">${prev} ${next}</p>
<p style="margin-top:10px"><a href="/">← Back to the directory</a></p>
</div>
</body>
</html>`;

  return new Response(html, {
    status: 200,
    headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'public, max-age=1800' },
  });
}
