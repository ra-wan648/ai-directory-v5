/**
 * Proxy worker routes through the Pages domain so the front end can call
 * same-origin paths like /api/tools with no CORS and no hardcoded worker URL.
 *
 * Note: Pages `_redirects` cannot proxy to a different zone, which is why the
 * old project's /api/* calls silently 404'd. This function replaces that.
 */

const WORKER = 'https://ai-directory-v5-worker.radwanislam648.workers.dev';

const PATH_PREFIXES = ['/api/', '/og/', '/telegram-webhook'];
const EXACT_PATHS = ['/sitemap.xml', '/rss.xml', '/robots.txt'];

function isWorkerRoute(pathname) {
  if (EXACT_PATHS.includes(pathname)) return true;
  return PATH_PREFIXES.some((p) => pathname === p.slice(0, -1) || pathname.startsWith(p));
}

export async function onRequest(context) {
  const { request, next } = context;
  const url = new URL(request.url);

  if (!isWorkerRoute(url.pathname)) return next();

  const init = {
    method: request.method,
    headers: {},
    redirect: 'manual',
  };

  const contentType = request.headers.get('content-type');
  if (contentType) init.headers['content-type'] = contentType;
  const internalKey = request.headers.get('x-internal-key');
  if (internalKey) init.headers['x-internal-key'] = internalKey;

  if (request.method !== 'GET' && request.method !== 'HEAD') {
    init.body = await request.arrayBuffer();
  }

  let upstream;
  try {
    upstream = await fetch(WORKER + url.pathname + url.search, init);
  } catch (e) {
    return new Response(JSON.stringify({ error: 'Upstream unavailable' }), {
      status: 502,
      headers: { 'content-type': 'application/json' },
    });
  }

  // Only forward the headers we want; copying them all can double-encode the body.
  const headers = new Headers();
  const upstreamType = upstream.headers.get('content-type');
  if (upstreamType) headers.set('content-type', upstreamType);
  const cacheControl = upstream.headers.get('cache-control');
  if (cacheControl) headers.set('cache-control', cacheControl);

  return new Response(upstream.body, { status: upstream.status, headers });
}
