/* AI Directory — front end. All content comes from the worker API; nothing is hardcoded. */
'use strict';

const SITE = 'https://ai-directory-v5-radwan648.pages.dev';

/* ============================ API ============================ */
const api = {
  async get(path) {
    const r = await fetch(path, { headers: { accept: 'application/json' } });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return r.json();
  },
  stats: () => api.get('/api/stats'),
  categories: () => api.get('/api/categories'),
  tools: (p) => api.get('/api/tools?' + new URLSearchParams(p)),
  newTools: (limit) => api.get('/api/tools/new?limit=' + limit),
  tool: (slug) => api.get('/api/tools/' + encodeURIComponent(slug)),
  prompts: (limit) => api.get('/api/prompts?limit=' + limit),
  blogs: (p) => api.get('/api/blogs?' + new URLSearchParams(p)),
  news: (limit) => api.get('/api/news?limit=' + limit),
  compare: (slugs) => api.get('/api/compare?slugs=' + slugs.map(encodeURIComponent).join(',')),
  copyPrompt: (id) => fetch('/api/prompts/copy/' + id, { method: 'POST' }).catch(() => {}),
};

/* ======================= small helpers ======================= */
const $ = (s, r) => (r || document).querySelector(s);
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const ls = {
  get(k, d) { try { const v = JSON.parse(localStorage.getItem(k)); return v == null ? d : v; } catch (e) { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* ignore */ } },
};
const num = (n) => Number(n || 0).toLocaleString('en-US');

const ICON = {
  image: '🎨', video: '🎬', coding: '💻', chat: '💬', writing: '✍️', audio: '🎵',
  research: '🔬', marketing: '📈', automation: '🤖', analytics: '📊', business: '💼',
  'open source': '🧩', 'ai assistant': '🪄', 'ai tools': '🧠', education: '🎓',
  finance: '💰', design: '🖌️', productivity: '⚡', '3d': '🧊', agents: '🤖',
};

const iconOf = (t) => ICON[String(t.category || '').toLowerCase()] || '🧠';
const priceOf = (t) => {
  const p = String(t.pricing || '').toLowerCase();
  return p === 'free' ? 'Free' : p === 'paid' ? 'Paid' : p === 'freemium' ? 'Freemium' : '—';
};
const descOf = (t) => String(t.short_desc || t.description || '').replace(/\s+/g, ' ').trim();
const domainOf = (u) => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch (e) { return ''; } };

function sourceOf(t) {
  const u = String(t.url || '').toLowerCase();
  if (u.includes('huggingface.co')) return 'HuggingFace';
  if (u.includes('producthunt')) return 'Product Hunt';
  if (u.includes('github.com')) return 'GitHub';
  if (u.includes('news.ycombinator')) return 'Hacker News';
  if (u.includes('theresanaiforthat')) return 'There\'s An AI For That';
  if (u.includes('toolify')) return 'Toolify';
  if (u.includes('futurepedia')) return 'Futurepedia';
  if (u.includes('topai.tools')) return 'TopAI.tools';
  if (u.includes('futuretools')) return 'FutureTools';
  if (u.includes('toolfk')) return 'ToolFK';
  if (u.includes('aixploria')) return 'Aixploria';
  if (u.includes('allthingsai')) return 'AllThingsAI';
  if (u.includes('insidr')) return 'Insidr';
  if (u.includes('trendshift')) return 'TrendShift';
  return domainOf(t.url) || 'Web';
}

/* created_at is stored as SQLite UTC "YYYY-MM-DD HH:MM:SS" */
function toDate(s) { return new Date(String(s || '').replace(' ', 'T') + 'Z'); }
function ago(s) {
  const d = toDate(s);
  if (isNaN(d)) return '';
  const m = Math.max(0, Math.round((Date.now() - d.getTime()) / 60000));
  if (m < 60) return m + 'm ago';
  if (m < 1440) return Math.floor(m / 60) + 'h ago';
  const days = Math.floor(m / 1440);
  return days === 1 ? 'yesterday' : days + 'd ago';
}
function day(s) {
  const d = toDate(s);
  return isNaN(d) ? '' : d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
}
const tagList = (t) => String(t.tags || '').split(',').map((x) => x.trim()).filter(Boolean);

/* ======================= state ======================= */
let CATS = [];
let STATS = null;
let FILTER = { status: 'all', cat: 'all', q: '' };
let CMP = ls.get('cmp', []);
let RV = ls.get('rv', []);
let PAGE = 1;
let LOADING = false;
let EXHAUSTED = false;
let savedY = 0;
let view = 'home';
const CACHE = new Map();

/* status tab -> worker query params */
const STATUS = [
  ['all', 'All'],
  ['new', 'New Today'],
  ['Free', 'Free'],
  ['Freemium', 'Freemium'],
  ['Paid', 'Paid'],
  ['open', 'Open Source'],
  ['featured', 'Featured'],
];
function statusParams(s) {
  if (s === 'new') return { tag: 'new' };
  if (s === 'Free') return { pricing: 'free' };
  if (s === 'Freemium') return { pricing: 'freemium' };
  if (s === 'Paid') return { pricing: 'paid' };
  if (s === 'open') return { category: 'Open Source' };
  if (s === 'featured') return { featured: '1' };
  return {};
}
function currentParams(page) {
  const p = Object.assign({ page: page, limit: 40 }, statusParams(FILTER.status));
  if (FILTER.cat !== 'all') p.category = FILTER.cat;
  if (FILTER.q) p.q = FILTER.q;
  return p;
}

/* ======================= article / card markup ======================= */
const logoHTML = (t) => '<div class="logo">' + iconOf(t) + '</div>';

function cardHTML(t) {
  const featured = Number(t.featured) === 1;
  const price = priceOf(t);
  return '<article class="card" data-slug="' + esc(t.slug) + '" tabindex="0">'
    + (featured ? '<span class="ribbon"></span>' : '')
    + '<div class="ctop"><span class="up">' + esc((t.source ? sourceOf(t) : '')) + '</span>'
    + (featured ? '<span class="fbadge">★ FEATURED</span>' : '')
    + '<button class="cmp' + (CMP.includes(t.slug) ? ' on' : '') + '" data-cmp="' + esc(t.slug) + '" title="Add to compare" aria-label="Add to compare">⇄</button></div>'
    + '<div class="crow">' + logoHTML(t)
    + '<div class="cmeta"><h3>' + esc(t.name) + '</h3><span class="cat">' + esc(t.category || '') + '</span></div></div>'
    + '<p>' + esc(descOf(t).slice(0, 150)) + '</p>'
    + '<div class="tags"><span class="tag ' + price.toLowerCase() + '">' + price + '</span><span class="tag">' + esc(t.category || '') + '</span></div>'
    + '<span class="visit">Visit ↗</span></article>';
}

const skel = (n) => Array.from({ length: n }, () => '<div class="sk"><div class="skl a"></div><div class="skl b"></div><div class="skl c"></div><div class="skl d"></div></div>').join('');

/* ======================= boot ======================= */
async function boot() {
  paintStatic();
  themeInit();
  const params = new URLSearchParams(location.search);
  if (params.get('q')) FILTER.q = params.get('q').toLowerCase();
  if (params.get('cat')) FILTER.cat = params.get('cat');
  if (params.get('pricing')) FILTER.status = priceTabOf(params.get('pricing'));
  if (FILTER.q) { $('#hs').value = FILTER.q; $('#ns').value = FILTER.q; }

  route();
  loadStats();
  loadCategories();
  loadHome();
  paintRV();
  paintCmp();
}

function paintStatic() {
  $('#year').textContent = String(new Date().getFullYear());
  $('#minitools').innerHTML = MINI.map((m) => '<a href="https://www.toolfk.com" target="_blank" rel="noopener">🔧 ' + esc(m) + '</a>').join('');
}

/* The pipeline bakes /data/sections.json on every run. It is a plain static
   asset, so it still loads when D1 has hit its daily read limit - which is the
   only reason a visitor sees an empty section instead of tools. */
let SNAP = null;
async function snapshot() {
  if (SNAP) return SNAP;
  try {
    const r = await fetch('/data/sections.json', { cache: 'no-store' });
    SNAP = r.ok ? await r.json() : {};
  } catch (e) { SNAP = {}; }
  return SNAP;
}
function snapKey(q) {
  return Object.keys(q).sort().map((k) => k + '=' + q[k]).join('&');
}

async function loadStats() {
  try {
    STATS = await api.stats();
  } catch (e) {
    const snap = await snapshot();
    if (snap && snap.stats && snap.stats.total_tools) {
      STATS = snap.stats;
    } else {
      $('#heroStats').textContent = 'Live data unavailable';
      return;
    }
  }
  const t = num(STATS.total_tools);
  $('#bannerCount').textContent = t;
  $('#heroCount').textContent = t;
  $('#heroStats').innerHTML = t + '+ Tools &nbsp;•&nbsp; ' + num(STATS.total_categories) + ' Categories &nbsp;•&nbsp; Updated Daily';
  $('#footStat').textContent = t + ' tools indexed · ' + num(STATS.today_added) + ' added today';
}

async function loadCategories() {
  try {
    const d = await api.categories();
    // the API returns { category, tool_count }; "AI Tools" is a catch-all bucket, not a real category
    CATS = (d.categories || d.result || [])
      .map((c) => ({ name: c.category || c.name, tool_count: c.tool_count || 0 }))
      .filter((c) => c.name && c.name !== 'AI Tools');
  } catch (e) { CATS = []; }

  $('#pills').innerHTML = CATS.slice(0, 6).map((c) => '<button data-pill="' + esc(c.name) + '">' + (ICON[String(c.name).toLowerCase()] || '🧠') + ' ' + esc(c.name) + '</button>').join('');
  $('#fcat').innerHTML = CATS.slice(0, 6).map((c) => '<a href="#sections" data-pill="' + esc(c.name) + '">' + esc(c.name) + ' AI Tools</a>').join('');
  $('#hiddencats') && ($('#hiddencats').textContent = '');
  $('#catmenu').innerHTML = '<button class="full" data-c="all" role="menuitem">All categories</button>'
    + CATS.map((c) => '<button data-c="' + esc(c.name) + '" role="menuitem">' + (ICON[String(c.name).toLowerCase()] || '🧠') + ' ' + esc(c.name) + '</button>').join('');
  paintFilters();
}

/* ======================= home ======================= */
async function loadHome() {
  if (FILTER.status !== 'all' || FILTER.cat !== 'all' || FILTER.q) { renderFiltered(true); return; }
  renderSections();
  loadNewToday();
  loadExtras();
}

function renderSections() {
  $('#sections').innerHTML = SECTIONS.map((s, i) => '<section class="sec' + (s.alt ? ' alt' : '') + '" data-sec="' + i + '">'
    + '<div class="sechead"><span class="ic">' + s.ic + '</span><span class="t">' + esc(s.t) + '</span>'
    + '<span class="c" id="cnt' + i + '"></span><a class="all" href="#sections" data-sec-all="' + i + '">See all →</a></div>'
    + '<div class="grid" data-grid="' + i + '">' + skel(6) + '</div></section>').join('');
  lazySections();
}

let io = null;
function lazySections() {
  if (io) io.disconnect();
  io = new IntersectionObserver((entries) => {
    entries.forEach((e) => {
      if (!e.isIntersecting) return;
      const el = e.target;
      io.unobserve(el);
      const i = Number(el.dataset.sec);
      fillSection(SECTIONS[i], i, el);
    });
  }, { rootMargin: '500px 0px' });
  document.querySelectorAll('[data-sec]').forEach((s) => io.observe(s));
}

async function fillSection(cfg, i, el) {
  const grid = el.querySelector('.grid');
  const q = Object.assign({ limit: 6 }, cfg.q);
  const show = (tools, total, stale) => {
    const c = $('#cnt' + i);
    if (c) c.textContent = '· ' + num(total) + ' ' + (cfg.unit || 'tools');
    if (!tools.length) {
      grid.innerHTML = '<div class="colcard" style="grid-column:1/-1;text-align:center;padding:32px"><p style="color:var(--muted);font-size:13px">Nothing in this section yet.</p></div>';
      return;
    }
    grid.innerHTML = tools.map(cardHTML).join('') + (stale
      ? '<div class="colcard" style="grid-column:1/-1;padding:10px 14px"><p style="color:var(--muted);font-size:12px;margin:0">Showing the last saved copy \u2014 live data is unavailable right now.</p></div>'
      : '');
  };
  try {
    const d = await api.tools(q);
    show(d.tools || [], d.total, false);
  } catch (e) {
    // Almost always an exhausted D1 read quota. Use the copy the pipeline baked.
    const snap = await snapshot();
    const baked = ((snap && snap.sections) || {})[snapKey(q)];
    if (baked && baked.tools && baked.tools.length) {
      show(baked.tools, baked.total, true);
      return;
    }
    grid.innerHTML = '<div class="colcard" style="grid-column:1/-1;padding:24px"><p style="color:var(--muted);font-size:13px">Could not load this section.</p></div>';
  }
}

async function loadNewToday() {
  const box = $('#newtoday');
  box.innerHTML = '';
  try {
    const d = await api.newTools(8);
    const tools = d.tools || [];
    if (!tools.length) return;
    box.innerHTML = bentoHTML(tools, d.today || 0);
  } catch (e) { /* leave the strip out */ }
}

function bentoHTML(tools, today) {
  const lead = tools[0];
  const rest = tools.slice(1, 8);
  return '<div class="ntwrap"><div class="sechead"><span class="ic">✨</span><span class="t">New Today</span>'
    + '<span class="live"><i></i>LIVE</span><span class="c">· ' + num(today) + ' added in 24h</span>'
    + '<a class="all" href="#sections" data-sec-all="new">See all new →</a></div>'
    + '<div class="bento">'
    + '<article class="big" data-slug="' + esc(lead.slug) + '" tabindex="0">'
    + '<div class="lot"><span class="lbl">🏆 LATEST ADDITION</span><span style="font-size:11px;color:var(--soft)">' + esc(ago(lead.created_at)) + '</span></div>'
    + '<div class="brow">' + logoHTML(lead) + '<div><h3>' + esc(lead.name) + '</h3><div class="m">' + esc(lead.category || '') + ' · ' + priceOf(lead) + '</div></div></div>'
    + '<p>' + esc(descOf(lead).slice(0, 220)) + '</p>'
    + '<div class="bfoot"><span class="tag ' + priceOf(lead).toLowerCase() + '">' + priceOf(lead) + '</span>'
    + '<span class="tag">' + esc(sourceOf(lead)) + '</span></div></article>'
    + rest.map((t) => '<article class="mini" data-slug="' + esc(t.slug) + '" tabindex="0">'
      + '<div class="r1"><span class="nb">NEW</span><span class="ago">' + esc(ago(t.created_at)) + '</span></div>'
      + '<h4>' + iconOf(t) + ' ' + esc(t.name) + '</h4><span class="m">' + esc(t.category || '') + ' · ' + priceOf(t) + '</span></article>').join('')
    + '</div></div>';
}

async function loadExtras() {
  const box = $('#extras');
  let news = [], prompts = [], blogs = [];
  const [n, p, b] = await Promise.allSettled([api.news(4), api.prompts(4), api.blogs({ limit: 4 })]);
  if (n.status === 'fulfilled') news = n.value.news || [];
  if (p.status === 'fulfilled') prompts = p.value.prompts || p.value.results || [];
  if (b.status === 'fulfilled') blogs = b.value.blogs || b.value.results || [];

  const catCols = CATS.slice(0, 4);
  box.innerHTML = ''
    + '<div class="marquee"><div class="mlbl">Sources we index from</div><div class="mtrack" id="mtrack"></div></div>'
    + '<section class="sec alt"><div class="sechead"><span class="ic">📚</span><span class="t">Browse by Category</span>'
      + '<span class="c">· ' + num(CATS.length) + ' categories</span></div>'
      + '<div class="cols4">' + catCols.map((c) => '<div class="colcard" id="catcol-' + esc(String(c.name).replace(/\s+/g, '-')) + '">'
        + '<h5>' + (ICON[String(c.name).toLowerCase()] || '🧠') + ' ' + esc(c.name) + '</h5><ol></ol></div>').join('') + '</div></section>'
    + (news.length ? '<section class="sec"><div class="sechead"><span class="ic">📰</span><span class="t">Latest News</span>'
      + '<span class="c">· ' + num(news.length) + ' recent</span><a class="all" href="#blog">All posts →</a></div>'
      + '<div class="cols4 news">' + news.map((x) => '<div class="colcard" data-blog="' + esc(x.slug) + '">'
        + '<div class="thumb" style="background:var(--amber-soft)">📰</div><div class="nbody"><span class="k">News</span>'
        + '<h5>' + esc(x.title) + '</h5><time>' + esc(day(x.published_at || x.created_at)) + '</time></div></div>').join('') + '</div></section>' : '')
    + (prompts.length ? '<section class="sec alt" id="prompts"><div class="sechead"><span class="ic">💬</span><span class="t">Prompts</span>'
      + '<span class="c">· ' + num(STATS ? STATS.total_prompts : prompts.length) + ' saved</span></div>'
      + '<div class="cols4">' + prompts.map((x) => '<div class="pcard" data-prompt-id="' + esc(x.id) + '"><h5>' + esc(x.title) + '</h5>'
        + '<div class="q">' + esc(String(x.prompt_text || '').slice(0, 220)) + '</div><div class="copy">⧉ Copy prompt</div></div>').join('') + '</div></section>' : '')
    + (blogs.length ? '<section class="sec" id="blog"><div class="sechead"><span class="ic">📝</span><span class="t">From the Blog</span>'
      + '<span class="c">· ' + num(STATS ? STATS.total_blogs : blogs.length) + ' posts</span></div>'
      + '<div class="cols4 news">' + blogs.map((x) => '<div class="colcard" data-blog="' + esc(x.slug) + '">'
        + '<div class="thumb" style="background:var(--amber-soft)">📝</div><div class="nbody"><span class="k">' + esc(x.category || 'post') + '</span>'
        + '<h5>' + esc(x.title) + '</h5><time>' + esc(day(x.published_at || x.created_at)) + '</time></div></div>').join('') + '</div></section>' : '')
    + '<section class="sec alt" id="news"><div class="sechead"><span class="ic">🧭</span><span class="t">Explore More</span></div>'
      + '<div class="expl">' + EXP.map(([e, n2, f]) => '<a href="#sections" data-quick="' + esc(f) + '"><span class="e">' + e + '</span>' + esc(n2) + '</a>').join('') + '</div></section>';

  const mt = $('#mtrack');
  if (mt) mt.innerHTML = [...SOURCES, ...SOURCES].map((s) => '<span>' + esc(s) + '</span>').join('');

  catCols.forEach(async (c) => {
    const el = $('#catcol-' + String(c.name).replace(/\s+/g, '-') + ' ol');
    if (!el) return;
    try {
      const d = await api.tools({ category: c.name, limit: 8, sort: 'newest' });
      el.innerHTML = (d.tools || []).map((t) => '<li data-slug="' + esc(t.slug) + '">' + esc(t.name) + ' ↗</li>').join('');
    } catch (e) { /* skip column */ }
  });
}

/* ======================= filtered results ======================= */
async function renderFiltered(reset) {
  const filtering = FILTER.status !== 'all' || FILTER.cat !== 'all' || !!FILTER.q;
  const chip = $('#rchip');
  chip.classList.toggle('on', filtering);
  if (!filtering) { loadHome(); return; }

  if (reset) { PAGE = 1; EXHAUSTED = false; }
  const wrap = $('#sections');
  if (PAGE === 1) {
    $('#newtoday').innerHTML = '';
    $('#extras').innerHTML = '';
    wrap.innerHTML = '<section class="sec"><div class="sechead"><span class="ic">🔎</span><span class="t">Results</span>'
      + '<span class="c" id="resCount">· searching…</span></div><div class="grid" id="resGrid">' + skel(6) + '</div></section>';
  }
  if (LOADING || EXHAUSTED) return;
  LOADING = true;
  try {
    const d = await api.tools(currentParams(PAGE));
    const tools = d.tools || [];
    const grid = $('#resGrid');
    if (!grid) return;
    if (PAGE === 1) {
      const rc = $('#resCount');
      if (rc) rc.textContent = '· ' + num(d.total) + ' tools';
      chip.innerHTML = '<b>' + num(d.total) + '</b> results<button id="reset" title="Clear filters">✕</button>';
      grid.innerHTML = tools.length ? tools.map(cardHTML).join('')
        : '<div class="colcard" style="grid-column:1/-1;text-align:center;padding:44px"><div style="font-size:26px">🫧</div>'
          + '<p style="color:var(--muted);font-size:13px">No tools match this filter.</p>'
          + '<button class="btn s" id="reset2">Reset filters</button></div>';
    } else {
      grid.insertAdjacentHTML('beforeend', tools.map(cardHTML).join(''));
    }
    if (tools.length < 40) EXHAUSTED = true;
  } catch (e) {
    const grid = $('#resGrid');
    if (grid && PAGE === 1) grid.innerHTML = '<div class="colcard" style="grid-column:1/-1;padding:24px"><p style="color:var(--muted);font-size:13px">Could not load results.</p></div>';
  } finally {
    LOADING = false;
  }
}

function setupInfiniteScroll() {
  addEventListener('scroll', () => {
    if (view !== 'home') return;
    if (scrollY + innerHeight < document.body.scrollHeight - 900) return;
    if (FILTER.status === 'all' && FILTER.cat === 'all' && !FILTER.q) return;
    if (EXHAUSTED || LOADING) return;
    PAGE += 1;
    renderFiltered(false);
  }, { passive: true });
}

/* ======================= filters ======================= */
function paintFilters() {
  document.querySelectorAll('[data-s]').forEach((b) => b.classList.toggle('on', b.dataset.s === FILTER.status));
  document.querySelectorAll('[data-c]').forEach((b) => b.classList.toggle('on', b.dataset.c === FILTER.cat));
  const lbl = $('#catlabel');
  if (lbl) lbl.textContent = FILTER.cat === 'all' ? 'All categories' : (ICON[String(FILTER.cat).toLowerCase()] || '🧠') + ' ' + FILTER.cat;
  const cb = $('#catbtn');
  if (cb) cb.classList.toggle('on', FILTER.cat !== 'all');
}

function setFilter(k, v) {
  FILTER[k] = v;
  syncURL();
  paintFilters();
  renderFiltered(true);
  if (k !== 'q') {
    const y = $('#fbar').getBoundingClientRect().top + scrollY - 56;
    if (scrollY > y) scrollTo({ top: y, behavior: 'smooth' });
  }
}

function syncURL() {
  if (view !== 'home') return;
  const p = new URLSearchParams();
  if (FILTER.status !== 'all') p.set('status', FILTER.status);
  if (FILTER.cat !== 'all') p.set('cat', FILTER.cat);
  if (FILTER.q) p.set('q', FILTER.q);
  history.replaceState(history.state, '', p.toString() ? '?' + p : location.pathname);
}

function priceTabOf(pricing) {
  const p = String(pricing).toLowerCase();
  return p === 'free' ? 'Free' : p === 'freemium' ? 'Freemium' : p === 'paid' ? 'Paid' : 'all';
}

function setupFilters() {
  $('#ftabs').innerHTML = STATUS.map(([v, l]) => '<button class="tab" role="tab" data-s="' + v + '">' + l + '</button>').join('');
  $('#ftabs').onclick = (e) => { const b = e.target.closest('[data-s]'); if (b) setFilter('status', b.dataset.s); };
  $('#pills').onclick = (e) => { const b = e.target.closest('[data-pill]'); if (b) { goHome(); setFilter('cat', b.dataset.pill); } };

  const menu = $('#catmenu'), btn = $('#catbtn');
  btn.onclick = (e) => { e.stopPropagation(); toggleMenu(); };
  menu.onclick = (e) => { const b = e.target.closest('[data-c]'); if (b) { setFilter('cat', b.dataset.c); toggleMenu(false); btn.focus(); } };
  document.addEventListener('click', () => toggleMenu(false));
  paintFilters();
}
function toggleMenu(force) {
  const menu = $('#catmenu'), btn = $('#catbtn');
  const open = force === undefined ? !menu.classList.contains('open') : force;
  menu.classList.toggle('open', open);
  btn.setAttribute('aria-expanded', open);
  if (open) menu.querySelector('button').focus();
}

/* ======================= recently viewed ======================= */
function paintRV() {
  const box = $('#rvbox');
  if (!RV.length) { box.innerHTML = ''; return; }
  box.innerHTML = '<h4 class="mt">Recently viewed</h4>' + RV.slice(0, 6).map((s) => '<div class="rv" data-slug="' + esc(s.slug) + '"><span>' + esc(s.icon) + '</span><span class="n">' + esc(s.name) + '</span></div>').join('');
}
function pushRV(t) {
  RV = [{ slug: t.slug, name: t.name, icon: iconOf(t) }].concat(RV.filter((x) => x.slug !== t.slug)).slice(0, 6);
  ls.set('rv', RV);
  paintRV();
}

/* ======================= tool page ======================= */
function toolHTML(t) {
  const price = priceOf(t);
  const tags = tagList(t);
  const d = descOf(t);
  const body = String(t.description_full || t.description || d).replace(/\s+/g, ' ').trim();
  const inCmp = CMP.includes(t.slug);
  const alt = [];
  return '<div class="crumb"><a href="/" data-home="1">Home</a> › <a href="#sections" data-c="' + esc(t.category || '') + '">' + esc(t.category || '') + '</a> › <span>' + esc(t.name) + '</span></div>'
    + '<div class="pgrid"><div class="pmain">'
    + '<div class="phead">' + logoHTML(t) + '<div><h1>' + esc(t.name) + '</h1>'
    + '<div class="pmeta">' + esc(t.category || '') + ' · ' + price + ' · added ' + esc(day(t.created_at)) + ' · source: ' + esc(sourceOf(t)) + '</div></div></div>'
    + '<div class="pact">'
    + '<a class="btn p" href="' + esc(t.visit_url || t.url || '#') + '" target="_blank" rel="noopener">Visit ' + esc(t.name) + ' ↗</a>'
    + '<button class="btn s' + (inCmp ? ' on' : '') + '" data-cmp="' + esc(t.slug) + '">⇄ ' + (inCmp ? 'In compare' : 'Add to compare') + '</button>'
    + '<button class="btn s" onclick="navigator.clipboard&&navigator.clipboard.writeText(location.href);this.textContent=\'✓ Link copied\'">⧉ Share</button></div>'
    + '<p class="aff">We do not take payment for listings. This page links to the official site — check pricing there.</p>'
    + '<div class="pbody">'
    + '<h2>What is ' + esc(t.name) + '?</h2><p>' + esc(body.slice(0, 1400)) + '</p>'
    + (tags.length ? '<h2>Tags</h2><p>' + tags.map((x) => '<span class="tag">' + esc(x) + '</span>').join(' ') + '</p>' : '')
    + '<h2>Pricing</h2><p>' + (price === 'Free' ? 'Listed as free to use. Pricing changes often — confirm on the official site.'
      : price === 'Freemium' ? 'Listed as freemium: a free tier with paid plans for higher limits.' : 'Listed as a paid product.') + '</p>'
    + '<h2>FAQ</h2>'
    + '<details class="faq"><summary>Is ' + esc(t.name) + ' free?</summary><p>' + (price === 'Free' ? 'It is listed as free.' : price === 'Freemium' ? 'There is a free tier with limits, plus paid plans.' : 'No — it is listed as a paid product.') + '</p></details>'
    + '<details class="faq"><summary>Where was this listing collected from?</summary><p>From ' + esc(sourceOf(t)) + '. Listings are collected automatically and refreshed daily, so verify details on the official site.</p></details>'
    + '<details class="faq"><summary>How are listings ordered?</summary><p>Currently by the date they were added. We do not yet collect a real popularity signal such as GitHub stars, so no engagement ranking is shown.</p></details>'
    + '</div></div>'
    + '<aside class="pside">'
    + '<div class="colcard"><h5>ℹ️ Quick facts</h5><div class="facts">'
    + 'Category: <b>' + esc(t.category || '—') + '</b><br>Pricing: <b>' + price + '</b><br>'
    + 'Added: <b>' + esc(day(t.created_at)) + '</b><br>Source: <b>' + esc(sourceOf(t)) + '</b><br>'
    + 'Domain: <b>' + esc(domainOf(t.url) || '—') + '</b></div></div>'
    + '<div class="colcard" id="simbox"><h5>🔗 Similar tools</h5><div id="simlist">' + skel(3) + '</div></div>'
    + '</aside></div>';
}

async function fillSimilar(t) {
  const box = $('#simlist');
  if (!box) return;
  try {
    const d = await api.tools({ category: t.category, limit: 7, sort: 'newest' });
    const sim = (d.tools || []).filter((x) => x.slug !== t.slug).slice(0, 6);
    box.innerHTML = sim.length ? sim.map((x) => '<div class="simrow" data-slug="' + esc(x.slug) + '">' + logoHTML(x)
      + '<div style="min-width:0"><b>' + esc(x.name) + '</b><small>' + priceOf(x) + '</small></div></div>').join('')
      : '<p style="color:var(--muted);font-size:12px">No similar tools found.</p>';
  } catch (e) { box.innerHTML = ''; }
}

async function openTool(slug, fromPop) {
  if (view === 'home') savedY = scrollY;
  showView('tool');
  $('#page').innerHTML = '<div class="crumb"><a href="/" data-home="1">Home</a> › <span>Loading…</span></div>' + skel(4);
  try {
    const d = CACHE.has(slug) ? CACHE.get(slug) : await api.tool(slug);
    const t = d.tool || d;
    CACHE.set(slug, d);
    $('#page').innerHTML = toolHTML(t);
    document.title = t.name + ' — ' + (t.category || 'AI tool') + ' | AI Directory';
    fillSimilar(t);
    pushRV(t);
    window.__lastTool = t;
  } catch (e) {
    $('#page').innerHTML = '<div class="colcard" style="text-align:center;padding:48px"><div style="font-size:28px">🤖</div>'
      + '<h2 style="font-size:18px">That tool could not be loaded</h2>'
      + '<p style="color:var(--muted);font-size:13px">It may have been removed, or the slug is wrong.</p>'
      + '<a class="btn p" href="/">← Back to the directory</a></div>';
  }
  if (!fromPop) history.pushState({ tool: slug }, '', '#tool/' + slug);
  scrollTo({ top: 0, behavior: 'auto' });
}

/* ======================= compare ======================= */
function toggleCmp(slug) {
  if (CMP.includes(slug)) CMP = CMP.filter((s) => s !== slug);
  else {
    if (CMP.length >= 4) { alert('You can compare up to 4 tools.'); return; }
    CMP.push(slug);
  }
  ls.set('cmp', CMP);
  paintCmp();
  document.querySelectorAll('[data-cmp]').forEach((b) => {
    if (b.classList.contains('btn')) b.classList.toggle('on', CMP.includes(b.dataset.cmp));
    if (b.classList.contains('cmp')) b.classList.toggle('on', CMP.includes(b.dataset.cmp));
  });
  if (view === 'compare') openCompare(true);
}

function paintCmp() {
  const tray = $('#tray');
  tray.classList.toggle('on', CMP.length > 0);
  document.body.classList.toggle('has-tray', CMP.length > 0);
  $('#trayin').innerHTML = CMP.map((s) => '<span class="tchip"><span class="logo">' + (RV.find((x) => x.slug === s) ? esc(RV.find((x) => x.slug === s).icon) : '🧠') + '</span>' + esc(s)
    + '<button data-cmp="' + esc(s) + '" aria-label="Remove">✕</button></span>').join('')
    + Array.from({ length: Math.max(0, 2 - CMP.length) }, () => '<span class="tslot">＋</span>').join('')
    + '<span class="go"><button class="clr" id="cmpclear">Clear</button>'
    + '<button class="btn p" id="cmpgo"' + (CMP.length < 2 ? ' disabled style="opacity:.5"' : '') + '>Compare ' + CMP.length + ' tools →</button></span>';
}

async function openCompare(fromPop) {
  if (CMP.length < 2) return;
  if (view === 'home') savedY = scrollY;
  showView('compare');
  $('#page').innerHTML = '<div class="crumb"><a href="/" data-home="1">Home</a> › <span>Compare</span></div>' + skel(3);
  try {
    const d = await api.compare(CMP);
    const ts = d.tools || [];
    const row = (label, fn) => '<tr><th>' + label + '</th>' + ts.map((t) => '<td>' + fn(t) + '</td>').join('') + '</tr>';
    $('#page').innerHTML = '<div class="crumb"><a href="/" data-home="1">Home</a> › <span>Compare</span></div>'
      + '<h1 style="font-size:22px;margin:0 0 14px">Compare ' + ts.map((t) => esc(t.name)).join(' vs ') + '</h1>'
      + '<div class="ctable"><table class="cmpt"><thead><tr><th></th>'
      + ts.map((t) => '<th><div class="chead">' + logoHTML(t) + '<b>' + esc(t.name) + '</b></div></th>').join('')
      + '</tr></thead><tbody>'
      + row('Category', (t) => esc(t.category || '—'))
      + row('Pricing', (t) => '<span class="tag ' + priceOf(t).toLowerCase() + '">' + priceOf(t) + '</span>')
      + row('Source', (t) => esc(sourceOf(t)))
      + row('Added', (t) => esc(day(t.created_at)))
      + row('Domain', (t) => esc(domainOf(t.url) || '—'))
      + row('Summary', (t) => esc(descOf(t).slice(0, 180)))
      + row('', (t) => '<a class="btn p" href="' + esc(t.visit_url || t.url || '#') + '" target="_blank" rel="noopener">Visit ↗</a>')
      + '</tbody></table></div>';
    document.title = 'Compare ' + ts.map((t) => t.name).join(' vs ') + ' | AI Directory';
  } catch (e) {
    $('#page').innerHTML = '<div class="colcard" style="padding:32px"><p style="font-size:13px">Could not load the comparison.</p></div>';
  }
  if (!fromPop) history.pushState({ cmp: 1 }, '', '#compare/' + CMP.join('-vs-'));
  scrollTo({ top: 0, behavior: 'auto' });
}

/* ======================= view switching / routing ======================= */
function showView(v) {
  view = v;
  const home = v === 'home';
  $('#hero').classList.toggle('hide', !home);
  $('#fbar').classList.toggle('hide', !home);
  $('#layout').classList.toggle('hide', !home);
  $('#page').classList.toggle('on', !home);
}
function goHome(fromPop) {
  if (view === 'home') return;
  showView('home');
  $('#page').innerHTML = '';
  document.title = 'AI Directory — AI tools, ranked and updated daily';
  if (!fromPop && location.hash) history.pushState({}, '', location.pathname + location.search);
  scrollTo({ top: savedY, behavior: 'auto' });
}
function route(fromPop) {
  const h = location.hash;
  if (h.startsWith('#tool/')) openTool(h.slice(6), true);
  else if (h.startsWith('#compare/')) openCompare(true);
  else goHome(true);
}

/* ======================= events ======================= */
function setupEvents() {
  document.addEventListener('click', (e) => {
    const quick = e.target.closest('[data-quick]');
    if (quick) { goHome(); setFilter('status', quick.dataset.quick); return; }
    const secAll = e.target.closest('[data-sec-all]');
    if (secAll) {
      const k = secAll.dataset.secAll;
      goHome();
      if (k === 'new') setFilter('status', 'new');
      else { const s = SECTIONS[Number(k)]; if (s && s.pill) setFilter(s.pill[0], s.pill[1]); else setFilter('status', 'all'); }
      return;
    }
    const nav = e.target.closest('[data-nav]');
    if (nav) { goHome(); const [k, v] = nav.dataset.nav.split(':'); if (k === 'all') setFilter('status', 'all'); else setFilter(k, v); return; }
    if (e.target.closest('[data-home]')) { e.preventDefault(); goHome(); return; }
    if (e.target.id === 'reset' || e.target.id === 'reset2') {
      FILTER = { status: 'all', cat: 'all', q: '' };
      $('#hs').value = ''; $('#ns').value = '';
      syncURL(); paintFilters(); renderFiltered(true); return;
    }
    if (e.target.id === 'cmpclear') { CMP = []; ls.set('cmp', CMP); paintCmp(); goHome(); return; }
    if (e.target.id === 'cmpgo') { openCompare(); return; }
    const cb = e.target.closest('[data-cmp]');
    if (cb) { e.preventDefault(); e.stopPropagation(); toggleCmp(cb.dataset.cmp); return; }
    const blog = e.target.closest('[data-blog]');
    if (blog) { const t = window.__lastTool; location.href = '/post/' + encodeURIComponent(blog.dataset.blog); return; }
    const pc = e.target.closest('.pcard');
    if (pc) {
      const q = pc.querySelector('.q');
      if (q) {
        navigator.clipboard && navigator.clipboard.writeText(q.textContent);
        api.copyPrompt(pc.dataset.promptId);
        const c = pc.querySelector('.copy');
        if (c) { c.textContent = '✓ Copied'; setTimeout(() => { c.textContent = '⧉ Copy prompt'; }, 2000); }
      }
      return;
    }
    const c = e.target.closest('[data-slug]');
    if (c) { e.preventDefault(); openTool(c.dataset.slug); }
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { toggleMenu(false); if (view !== 'home') goHome(); }
    if (e.key === '/' && !/INPUT|TEXTAREA/.test(document.activeElement.tagName)) {
      e.preventDefault();
      (document.body.classList.contains('hero-gone') ? $('#ns') : $('#hs')).focus();
    }
    if (e.key === 'Enter') { const c = document.activeElement.closest && document.activeElement.closest('[data-slug]'); if (c) openTool(c.dataset.slug); }
    const menu = $('#catmenu');
    if (menu.classList.contains('open') && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
      e.preventDefault();
      const items = [...menu.querySelectorAll('button')];
      let i = items.indexOf(document.activeElement);
      i = e.key === 'ArrowDown' ? (i + 1) % items.length : (i <= 0 ? items.length - 1 : i - 1);
      items[i].focus();
    }
  });

  addEventListener('popstate', () => route(true));

  addEventListener('scroll', () => $('#nav').classList.toggle('stuck', scrollY > 90), { passive: true });
  new IntersectionObserver(([e]) => document.body.classList.toggle('hero-gone', !e.isIntersecting),
    { rootMargin: '-56px 0px 0px 0px', threshold: 0 }).observe($('#hsearch'));

  let tm;
  const onSearch = (v) => {
    clearTimeout(tm);
    tm = setTimeout(() => {
      FILTER.q = v.trim().toLowerCase();
      if (view !== 'home') goHome();
      syncURL();
      renderFiltered(true);
    }, 250);
  };
  $('#hs').oninput = (e) => { $('#ns').value = e.target.value; onSearch(e.target.value); };
  $('#ns').oninput = (e) => { $('#hs').value = e.target.value; onSearch(e.target.value); };

  addEventListener('mouseover', (e) => {
    const c = e.target.closest('[data-slug]');
    if (!c || CACHE.has(c.dataset.slug)) return;
    clearTimeout(window.__hv);
    window.__hv = setTimeout(async () => { try { CACHE.set(c.dataset.slug, await api.tool(c.dataset.slug)); } catch (err) { /* ignore */ } }, 220);
  });

  setupInfiniteScroll();
}

/* ======================= theme ======================= */
function themeInit() {
  const root = document.documentElement, tgl = $('#tgl');
  const saved = ls.get('theme', null);
  if (saved === 'dark' || saved === 'light') root.dataset.theme = saved;
  tgl.textContent = root.dataset.theme === 'dark' ? '☀️' : '🌙';
  tgl.onclick = () => {
    root.dataset.theme = root.dataset.theme === 'dark' ? 'light' : 'dark';
    tgl.textContent = root.dataset.theme === 'dark' ? '☀️' : '🌙';
    ls.set('theme', root.dataset.theme);
  };
}

/* ======================= content constants ======================= */
const MINI = ['JSON Formatter', 'Base64 Encoder', 'QR Generator', 'Image Compressor', 'Word Counter', 'Color Picker', 'Regex Tester', 'Markdown Editor', 'URL Shortener', 'Timestamp Tool', 'Diff Checker', 'Hash Generator'];
const SOURCES = ['Toolify', 'Futurepedia', "There's An AI For That", 'TopAI.tools', 'Aixploria', 'AllThingsAI', 'Insidr', 'ToolFK', 'FutureTools', 'TrendShift', 'Product Hunt', 'HuggingFace', 'GitHub', 'Hacker News'];
const EXP = [
  ['🆓', 'Free Tools', 'Free'], ['🆕', 'New Today', 'new'],
  ['⭐', 'Featured', 'featured'], ['🧩', 'Open Source', 'open'],
  ['🤗', 'HuggingFace', 'all'], ['🚀', 'Product Hunt', 'all'],
  ['🎓', 'Coding', 'all'], ['💬', 'Chat', 'all'],
  ['🎨', 'Image', 'all'], ['🎵', 'Audio', 'all'],
  ['📊', 'Analytics', 'all'], ['🤖', 'Automation', 'all'],
];
const SECTIONS = [
  { ic: '🆕', t: 'New This Week', q: { sort: 'newest', days: 7 }, unit: 'added this week', pill: ['status', 'new'] },
  { ic: '⭐', t: 'Featured', q: { featured: '1' }, unit: 'picks', alt: 1, pill: ['status', 'featured'] },
  { ic: '🆓', t: 'Free Tools', q: { pricing: 'free' }, unit: 'tools', pill: ['status', 'Free'] },
  { ic: '🧩', t: 'Open Source', q: { category: 'Open Source' }, unit: 'projects', alt: 1, pill: ['status', 'open'] },
  { ic: '🤗', t: 'HuggingFace Models', q: { source: 'huggingface' }, unit: 'models' },
  { ic: '🚀', t: 'On Product Hunt', q: { source: 'producthunt' }, unit: 'launches', alt: 1 },
];

/* ======================= go ======================= */
setupFilters();
setupEvents();
boot();
