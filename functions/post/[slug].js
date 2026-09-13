/**
 * Server-rendered article page at /post/<slug>.
 *
 * Every published blog is advertised at this path - 466 of them in sitemap.xml -
 * and the front end links here too (public/js/app.js), but no function handled
 * it, so all 466 returned 404 and search engines were fed a sitemap full of
 * dead URLs. The worker already serves the data at /api/blogs/:slug.
 */

const WORKER = 'https://ai-directory-v5-worker.radwanislam648.workers.dev';
const SITE = 'https://ai-directory-v5-radwan648.pages.dev';

const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function notFound() {
  return new Response(
    '<!doctype html><meta charset="utf-8"><title>Not found | AI Directory</title>'
    + '<p style="font-family:system-ui;padding:40px">No article with that slug. '
    + '<a href="/">Back to the directory</a></p>',
    { status: 404, headers: { 'content-type': 'text/html; charset=utf-8' } },
  );
}

export async function onRequest(context) {
  const slug = decodeURIComponent(String(context.params.slug || ''));
  let blog = null;
  try {
    const r = await fetch(`${WORKER}/api/blogs/${encodeURIComponent(slug)}`);
    if (r.ok) {
      const d = await r.json();
      blog = d.blog || null;
    }
  } catch (e) { /* fall through */ }

  if (!blog) return notFound();

  const title = blog.title || slug;
  const description = blog.meta_description || String(blog.content || '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 155);
  // content is authored HTML from our own database, so it is rendered as-is.
  const body = blog.content || '<p>This article has no body yet.</p>';
  const date = String(blog.published_at || blog.created_at || '').split(' ')[0];

  const html = `<!doctype html>
<html lang="en" data-theme="light">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)} | AI Directory</title>
<meta name="description" content="${esc(description)}">
<link rel="canonical" href="${SITE}/post/${encodeURIComponent(slug)}">
<meta property="og:type" content="article">
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(description)}">
<link rel="stylesheet" href="/css/app.css">
</head>
<body>
<div class="wrap" style="max-width:760px;margin:0 auto;padding:28px 16px">
<nav style="font-size:12px;margin-bottom:16px"><a href="/">Home</a> › <a href="/blog">Articles</a> › <span>${esc(title)}</span></nav>
<article>
<h1 style="font-size:26px;margin:0 0 8px">${esc(title)}</h1>
<p style="font-size:12px;opacity:.7;margin:0 0 20px">${date ? `Published ${esc(date)}` : ''}${blog.category ? ` · ${esc(blog.category)}` : ''}</p>
<div class="post-body">${body}</div>
</article>
<p style="margin-top:26px;font-size:12px;opacity:.7">Listings and articles are collected automatically from public sources.</p>
<p style="margin-top:10px"><a href="/">← Back to the directory</a></p>
</div>
</body>
</html>`;

  return new Response(html, {
    status: 200,
    headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'public, max-age=3600' },
  });
}
