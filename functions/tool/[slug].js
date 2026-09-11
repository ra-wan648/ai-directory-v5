/**
 * Server-rendered tool page.
 * Real crawlable URL (/tool/<slug>) instead of the JS-only #tool/<slug> hash,
 * so search engines see the title, description, canonical and JSON-LD.
 */

const WORKER = 'https://ai-directory-v5-worker.radwanislam648.workers.dev';
const SITE = 'https://ai-directory-v5-radwan648.pages.dev';

const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const priceOf = (p) => { const v = String(p || '').toLowerCase(); return v === 'free' ? 'Free' : v === 'paid' ? 'Paid' : v === 'freemium' ? 'Freemium' : 'Unknown'; };
const descOf = (t) => String(t.short_desc || t.description || '').replace(/\s+/g, ' ').trim();

function sourceOf(t) {
  const u = String(t.url || '').toLowerCase();
  if (u.includes('huggingface.co')) return 'HuggingFace';
  if (u.includes('producthunt')) return 'Product Hunt';
  if (u.includes('github.com')) return 'GitHub';
  if (u.includes('news.ycombinator')) return 'Hacker News';
  return 'public sources';
}

function page({ title, description, canonical, body, jsonLd }) {
  return `<!doctype html>
<html lang="en" data-theme="light">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title>
<meta name="description" content="${esc(description)}">
<link rel="canonical" href="${esc(canonical)}">
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(description)}">
<meta property="og:type" content="website">
<link rel="stylesheet" href="/css/app.css">
${jsonLd ? `<script type="application/ld+json">${JSON.stringify(jsonLd)}</script>` : ''}
</head>
<body>
<div class="wrap" style="max-width:860px;margin:0 auto;padding:28px 16px">
${body}
</div>
</body>
</html>`;
}

export async function onRequest(context) {
  const slug = String(context.params.slug || '');
  let tool = null;
  try {
    const r = await fetch(`${WORKER}/api/tools/${encodeURIComponent(slug)}`);
    if (r.ok) tool = (await r.json()).tool;
  } catch (e) { /* fall through to 404 */ }

  if (!tool) {
    return new Response(page({
      title: 'Tool not found — AI Directory',
      description: 'That tool is not in the directory.',
      canonical: `${SITE}/tool/${encodeURIComponent(slug)}`,
      body: '<h1 style="font-size:20px">Tool not found</h1><p style="font-size:13px">That listing does not exist or has been removed.</p>'
        + '<p><a class="btn p" href="/">← Back to the directory</a></p>',
    }), { status: 404, headers: { 'content-type': 'text/html; charset=utf-8' } });
  }

  const name = tool.name;
  const cat = tool.category || 'AI tool';
  const price = priceOf(tool.pricing);
  const desc = descOf(tool).slice(0, 155) || `${name} is listed in the ${cat} category on AI Directory.`;
  const tags = String(tool.tags || '').split(',').map((x) => x.trim()).filter(Boolean);

  const body = `
<nav style="font-size:12px;margin-bottom:16px"><a href="/">Home</a> › <a href="/category/${encodeURIComponent(cat)}">${esc(cat)}</a> › <span>${esc(name)}</span></nav>
<h1 style="font-size:26px;margin:0 0 6px">${esc(name)}</h1>
<p style="font-size:13px;opacity:.75;margin:0 0 18px">${esc(cat)} · ${esc(price)} · collected from ${esc(sourceOf(tool))}</p>
<p><a class="btn p" href="${esc(tool.visit_url || tool.url || '#')}" target="_blank" rel="noopener">Visit ${esc(name)} ↗</a></p>
<h2 style="font-size:17px;margin-top:26px">What is ${esc(name)}?</h2>
<p style="font-size:14px;line-height:1.65">${esc(String(tool.description_full || tool.description || desc).replace(/\s+/g, ' ').slice(0, 1600))}</p>
${tags.length ? `<h2 style="font-size:17px">Tags</h2><p style="font-size:13px">${tags.map((t) => `<span class="tag">${esc(t)}</span>`).join(' ')}</p>` : ''}
<h2 style="font-size:17px">Pricing</h2>
<p style="font-size:14px">Listed as <b>${esc(price)}</b>. Pricing changes often — confirm on the official site.</p>
<h2 style="font-size:17px">Similar ${esc(cat)} tools</h2>
<div id="sim" style="font-size:13px">Loading…</div>
<script>
fetch("/api/tools?category=" + encodeURIComponent(${JSON.stringify(cat)}) + "&limit=7&sort=newest")
  .then(function(r){return r.json()})
  .then(function(d){
    var items=(d.tools||[]).filter(function(x){return x.slug!==${JSON.stringify(tool.slug)}}).slice(0,6);
    var el=document.getElementById("sim");
    el.innerHTML = items.length ? items.map(function(x){
      return '<a href="/tool/'+encodeURIComponent(x.slug)+'" style="display:block;padding:6px 0">'+String(x.name).replace(/[&<>"]/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]})+'</a>';
    }).join("") : "No similar tools found.";
  })
  .catch(function(){document.getElementById("sim").innerHTML="";});
</script>
<p style="margin-top:22px;font-size:12px;opacity:.7">Listings are collected automatically from public sources and refreshed daily. We do not take payment for placement.</p>
<p style="margin-top:10px"><a href="/">← Back to the directory</a></p>`;

  return new Response(page({
    title: `${name} — ${cat} AI tool | AI Directory`,
    description: desc,
    canonical: `${SITE}/tool/${encodeURIComponent(tool.slug)}`,
    body,
    jsonLd: {
      '@context': 'https://schema.org',
      '@type': 'SoftwareApplication',
      name: name,
      description: desc,
      applicationCategory: cat,
      url: tool.visit_url || tool.url || undefined,
      offers: { '@type': 'Offer', price: price === 'Free' ? '0' : undefined, priceCurrency: 'USD', description: price },
    },
  }), { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'public, max-age=600' } });
}
