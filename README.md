# AI Directory v5

An index of AI tools collected from public directories and APIs, refreshed daily.

**Live:** https://ai-directory-v5-radwan648.pages.dev
**API:** https://ai-directory-v5-worker.radwanislam648.workers.dev

## Stack

| Layer | What |
|---|---|
| Front end | Cloudflare Pages — static HTML/CSS, vanilla JS (`public/`) |
| Server routes | Pages Functions — API proxy + server-rendered `/tool/<slug>` and `/category/<name>` (`functions/`) |
| API | Cloudflare Worker, ~32 routes (`worker/worker.js`) |
| Database | Cloudflare D1, database `ai-directory-db` |
| Pipeline | GitHub Actions, six nightly runs a week (`scripts/`, `.github/workflows/pipeline.yml`) |
| Deploy | GitHub Actions on push to `main` (`.github/workflows/deploy.yml`) |
| Admin approval | Telegram bot (`/telegram-webhook`) |

The D1 database is shared with the previous project, so all existing rows carry over.
No data migration was required.

## Layout

```
public/            static site (index.html, css/app.css, js/app.js, _redirects, 404.html)
functions/         Pages Functions
  [[path]].js        proxies /api/*, /og/*, /sitemap.xml, /rss.xml, /robots.txt, /telegram-webhook
  tool/[slug].js     server-rendered tool page (crawlable)
  category/[slug].js server-rendered category listing
worker/worker.js   API worker
scripts/           scrapers, LLM enrichment, Telegram, pipeline entry points
docs/              original planning documents
legacy/            the old Flask alternative backend, kept for reference only
```

## API

```
GET  /api/tools            category, pricing, q, sort (newest|views|votes|name), tag,
                           source (producthunt|huggingface|github|hackernews),
                           featured=1, days=N, page, limit
GET  /api/tools/new        ?limit=  -> { tools, total, today }
GET  /api/tools/trending   ?limit=
GET  /api/tools/featured   ?limit=
GET  /api/tools/:slug
GET  /api/search           ?q=
GET  /api/free-tools
GET  /api/compare          ?slugs=a,b,c,d   (2-4 tools; legacy ?a=&b= still works)
GET  /api/news             ?limit=  (blogs where category = 'news')
GET  /api/blogs  /api/blogs/:slug
GET  /api/prompts  /api/prompts/:slug   POST /api/prompts/copy/:id
GET  /api/categories  /api/stats
POST /api/subscribe  /api/submit-tool
GET  /sitemap.xml  /rss.xml  /robots.txt  /og/tool/:slug
POST /telegram-webhook
POST /api/internal/*       requires the X-Internal-Key header
```

## Deploy

Both targets deploy automatically on push to `main`. Required repository secrets:
`CF_API_TOKEN`, `CF_ACCOUNT_ID`.

Manual:

```bash
export CLOUDFLARE_API_TOKEN=... CLOUDFLARE_ACCOUNT_ID=...
npx wrangler deploy                                             # worker
npx wrangler pages deploy public --project-name ai-directory-v5-radwan648 --branch main
```

## Known constraints

- `views` and `votes` in the tools table are all zero, so there is no real popularity
  signal. `/api/tools/trending` therefore returns the newest tools from the last 7 days
  and the UI does not display a rating. Swap the `ORDER BY` in `worker.js` once a real
  signal (GitHub stars, Product Hunt upvotes) is collected.
- Listings include some news articles and Show HN posts that are not products; they are
  collected as-is from the upstream sources.
- Tool logos render as category emoji. Favicons would require mirroring images to R2.
- `source` is derived from the stored URL at query time, so it works for new rows
  without a migration.

## Secrets used by the worker

Set with `wrangler secret put <NAME>` (never commit them):

`INTERNAL_API_KEY`, `TELEGRAM_BOT_TOKEN`, `ADMIN_TELEGRAM_ID`
