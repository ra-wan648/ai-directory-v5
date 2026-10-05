# AI Directory v5 — Full Project Handover Context

> এই ফাইলটি অন্য AI/ডেভেলপারকে project handover দেওয়ার জন্য তৈরি। এটি current repository, deployed infrastructure, original 4-part plan, scraper implementation এবং latest live audit একসাথে ধরে। কোনো secret/API key এখানে রাখা যাবে না।

## 1. Project identity and intention

**Project:** AI Tools Directory v5

**মূল উদ্দেশ্য:**

একটি Toolify/Futurepedia/There’s An AI For That ধরনের AI tools discovery platform তৈরি করা, যেখানে visitor:

- বিভিন্ন AI tool search/browse করতে পারবে
- category, pricing, source, tag ও keyword দিয়ে filter করতে পারবে
- tool detail, related tools ও alternatives দেখতে পারবে
- দুই বা একাধিক tool compare করতে পারবে
- AI prompts copy/use করতে পারবে
- Reviews, tutorials ও AI news পড়তে পারবে
- নতুন tool submit করতে পারবে
- directory data প্রতিদিন/নিয়মিত public sources থেকে refresh হবে

**Business/product intent:**

- একটি বড়, searchable, SEO-friendly AI tools index
- public sources থেকে discovery, কিন্তু directory-তে official tool URL দেখানো
- content quality ও data integrity বজায় রাখা
- automation-এর মাধ্যমে manual workload কমানো
- Telegram approval-এর মাধ্যমে generated blogs/prompts/submissions publish করা
- UI dense, fast, minimal ও vanilla JavaScript ভিত্তিক রাখা

**Original cost goal:** Cloudflare Pages + Workers + D1 + GitHub Actions + Telegram Bot ব্যবহার করে low-cost/free-first architecture। Paid APIs/Apify/LLM ব্যবহার করলে quota ও cost guard রাখতে হবে।

## 2. Live production references

- **Live site:** https://ai-directory-v5-radwan648.pages.dev/
- **Canonical submit page:** https://ai-directory-v5-radwan648.pages.dev/submit/
- **Worker API:** https://ai-directory-v5-worker.radwanislam648.workers.dev/
- **GitHub repository:** https://github.com/ra-wan648/ai-directory-v5
- **D1 database name:** `ai-directory-db`
- **Cloudflare Pages project:** `ai-directory-v5-radwan648`
- **Latest verified repository commit:** `12d0505 refresh tools list and count cache keys`
- **Latest verified deploy workflow:** run `37250019752`, Worker and Pages jobs successful
- **Latest cleanup workflow:** run `37249899565`, successful

### Latest verified live state

- Published tools: **7,998**
- Published blogs: **874**
- Published prompts: **14**
- Canonical categories: **12**
- `/submit/`: works
- `/submit` without trailing slash: still returned 404 in public fetch; use `/submit/` as canonical URL
- Last cleanup pass hid **2** additional invalid rows after previous passes hid 67 and 56 rows. Cleanup is reversible because it uses `status='rejected'`.
- LLM backfill was intentionally run with `fill_max=0`; no new LLM calls were made in those cleanup runs.

## 3. Repository location and layout

Local working copy used during the last work:

```text
C:\Users\Radwan's PC\AccioWork\2026-10-04-22-21-41-476-4b8b606e\ai-directory-v5
```

Important directories/files:

```text
public/                         Static Pages site
public/index.html               Homepage
public/js/app.js                Homepage/client rendering
public/css/app.css              Main styling
public/tools/                   Browse/static page assets if present
public/submit/index.html        Submit page (canonical /submit/)
public/submit.html              No-slash fallback asset
public/_redirects               Pages routing rules
public/404.html                  Not-found page

functions/                      Cloudflare Pages Functions
functions/[[path]].js            Proxy for API/Worker routes
functions/tool/[slug].js         SSR tool detail route
functions/category/[slug].js     SSR category route
functions/tools/index.js          SSR browse route
functions/post/[slug].js          SSR blog post route
functions/submit/index.js         Source Pages Function submit route (Pages publish currently uses public/)

worker/worker.js                 Cloudflare Worker + D1 API
schema.sql                       Database schema and seed definitions
migrations/001_indexes.sql       Base indexes
migrations/002_unique_published_url.sql
migrations/003_views_ordering_indexes.sql

scripts/validate.py              Shared row/name/URL validator
scripts/apify_scraper.py         Apify directory scraper
scripts/fresh_data_pipeline.py   Free/API source pipeline
scripts/cleanup_junk.py           Reversible D1 quarantine
scripts/fix_categories.py         Taxonomy migration/reclassification
scripts/llm_fill.py               Optional LLM enrichment
scripts/telegram.py               Telegram helpers
scripts/telegram_stats.py         Telegram summary/pending stats
scripts/snapshot_sections.py       Homepage snapshot bake
scripts/snapshot_offline.py        Offline dataset bake
scripts/test_classification.py     Classification regression tests
scripts/test_taxonomy_order.py     Taxonomy regression test
scripts/lint_workflows.py          Workflow checker

.github/workflows/deploy.yml       Push -> Worker + Pages deploy
.github/workflows/pipeline.yml     Scheduled source pipeline
.github/workflows/backfill.yml     Manual cleanup/backfill workflow

docs/MASTER PLAN.txt               Consolidated original plan
docs/step 1.txt                    Original Part 1 plan
 docs/PART 2 — FRONTEND.txt        Original frontend plan
 docs/PART 3 — FRONTEND PART B.txt Original frontend Part B plan
 docs/PART 4 — AUTOMATION (Final Part).txt Original automation plan
 docs/contex.txt                   Original instructions/context
```

## 4. Technology architecture

| Layer | Current implementation |
|---|---|
| Frontend | Cloudflare Pages, static HTML/CSS, vanilla JS |
| Server-rendered pages | Cloudflare Pages Functions |
| API | Cloudflare Worker (`worker/worker.js`) |
| Database | Cloudflare D1, binding `DB` |
| Scheduled ingestion | GitHub Actions + Python scripts |
| Admin approval | Telegram webhook and inline callbacks |
| Deployment | GitHub Actions on push to `main` |
| Caching | Worker `caches.default`, stale fallback, versioned cache keys |
| Offline fallback | `public/data/sections.json` and `public/data/offline.json` generated by snapshot scripts |
| External scraper | Apify `apify/web-scraper`, multiple `APIFY_KEY_N` slots |
| Optional enrichment | Manifest/LLM API via `MANIFEST_API_KEY` |

`wrangler.toml` binds:

```toml
name = "ai-directory-v5-worker"
main = "worker/worker.js"
compatibility_date = "2024-01-01"

[[d1_databases]]
binding = "DB"
database_name = "ai-directory-db"
database_id = "ff26faf5-3c7c-445a-a249-6c96fedddfdc"

[vars]
ENVIRONMENT = "production"
SITE_URL = "https://ai-directory-v5-radwan648.pages.dev"
```

## 5. Database model

### `tools`

Core directory records:

- `id`, `name`, unique `slug`
- `description`, `short_desc`
- `category`
- `pricing`: current schema permits `free`, `freemium`, `paid`, or `NULL` for unverified pricing
- `url`, `logo_url`, `logo_type`
- `tags`, `compatible_tools`
- `views`, `votes`, `featured`, `tag`
- `status`: normally `published`, `rejected`, etc.
- `last_updated`, `created_at`
- enrichment columns: `description_full`, `features`, `pricing_detail`, `llm_filled`

### `blogs`

- `title`, unique `slug`, `content`
- `meta_description`, `focus_keyword`, `faq_schema`
- `category`, `tool_slug`
- `status` — intended flow is `pending` -> Telegram approve -> `published`
- `telegram_message_id`, `published_at`, `created_at`

### `prompts`

- `title`, unique `slug`, `prompt_text`, `description`
- `category`, `compatible_tools`, `preview_image_url`
- `copy_count`
- `status` — intended approval flow
- Telegram fields and timestamps

### Other tables

- `categories`: canonical category registry and counts
- `subscribers`: email subscribers
- `submitted_tools`: public submissions awaiting Telegram review

### Canonical taxonomy

Current intended 12-category set:

1. Assistants & Agents
2. Coding & Dev
3. Design & Art
4. Video & Animation
5. Voice & Sound
6. Writing & Content
7. Business & Productivity
8. Data & Automation
9. Education & Research
10. Finance
11. Health
12. Other

Legacy values such as `AI Tools`, `Coding`, `Image`, `Research`, `Writing`, `Video`, `Audio`, `Business`, `Automation`, `Analytics`, and `Chat` were mapped at API/runtime level and partly cleaned from D1. Continue checking for legacy values after every ingestion run.

## 6. Worker/API surface

Public read routes include:

```text
GET  /api/tools
GET  /api/tools/new
GET  /api/tools/trending
GET  /api/tools/featured
GET  /api/tools/:slug
GET  /api/search?q=
GET  /api/free-tools
GET  /api/compare?slugs=a,b,c,d
GET  /api/blogs
GET  /api/blogs/:slug
GET  /api/prompts
GET  /api/prompts/:slug
POST /api/prompts/copy/:id
GET  /api/categories
GET  /api/stats
GET  /api/news
GET  /sitemap.xml
GET  /rss.xml
GET  /robots.txt
GET  /og/tool/:slug
GET  /tag/:tag
GET  /alternatives/:slug
GET  /compare/:a/:b
```

Write routes:

```text
POST /api/subscribe
POST /api/submit-tool
POST /telegram-webhook
```

Internal routes require `X-Internal-Key` matching `env.INTERNAL_API_KEY`:

```text
POST /api/internal/add-tool
POST /api/internal/add-blog
POST /api/internal/add-prompt
POST /api/internal/bulk-insert
```

Important API rules:

- All public listing queries filter `status='published'`.
- Public submit records go to `submitted_tools` with `pending` status.
- Internal tool imports are validated before insertion.
- New blog ingestion is intended to be `pending`, not auto-published.
- Unknown pricing is `NULL`/unknown, never silently `free`.
- Category API normalizes legacy values at response time.
- Cache keys are versioned (`api-tools-v4`, `api-tools-count-v3`, `api-categories-v3`) to avoid stale old responses after data cleanup.

## 7. Scraper and ingestion system

There are two major ingestion families. Do not confuse discovery URLs with official product URLs.

### A. Apify directory scraper — `scripts/apify_scraper.py`

Purpose: crawl public AI directory websites through Apify and import discovered tool candidates.

Configured directory sources include:

- Toolify
- Futurepedia
- There’s An AI For That (TAAFT)
- All Things AI
- FutureTools
- TopAI.Tools
- AIXploria
- Insidr
- ToolFK
- Trendshift (currently cadence off in Apify because a free GitHub/source path exists elsewhere)

Important behavior:

- Uses `APIFY_KEY_1` through `APIFY_KEY_N` environment slots.
- `APIFY_KEY_SLOTS` defaults to 12.
- Keys are loaded dynamically; empty slots are skipped.
- Crawls are shallow to reduce Apify compute cost.
- Toolify and TAAFT are the main daily producers.
- Futurepedia, ToolFK, AIXploria, FutureTools, TopAI, AllThingsAI are weekly.
- Insidr is currently off.
- Trendshift Apify crawl is off because another source covers it.
- Key headroom is checked when possible and slots are weighted by remaining budget.
- Site assignments rotate by day to avoid exhausting one key.
- Existing published URLs are loaded from D1 before insert; if that read fails, scraper refuses to continue rather than inserting duplicates.
- New rows use `INSERT OR IGNORE` and unique URL/slug protection.
- Shared `validate.py` rejects invalid names, navigation fragments, article/news URLs, ad/affiliate redirects, directory URLs and URL-shaped names.
- New records are canonicalized to the 12-category taxonomy.
- Pricing is only saved as `free`, `freemium` or `paid` when explicitly available; otherwise `NULL`.

Potential risk to monitor:

- Directory cards can contain article headlines, advertisement cards, affiliate links or model pages that are not standalone tools.
- Every future scraper change must preserve URL-host validation and post-scrape rejection counts.

### B. Free/API source pipeline — `scripts/fresh_data_pipeline.py`

Sources described in the implementation:

1. Product Hunt GraphQL — top AI posts in recent period
2. Hugging Face models — download threshold and capped result count
3. Hugging Face Spaces — likes threshold and capped result count
4. GitHub search — AI tools/LLM topics and star threshold
5. Hacker News Algolia — point threshold
6. RSS feeds — TLDR AI, Ben’s Bites, The Rundown and related feeds

Pipeline responsibilities:

- Fetch candidate records from sources.
- Normalize URLs, names and slugs.
- Deduplicate against D1.
- Validate official URL/source type.
- Assign canonical category.
- Keep unknown pricing unverified.
- Insert tools in batches.
- Generate/insert blogs and prompts through the associated flow.
- Emit progress and counts.

Critical distinction:

- HN/RSS/news items are content candidates, not automatically tools.
- Product Hunt/Hugging Face/GitHub pages may be discovery pages; an official product URL must be resolved before publishing as a tool.
- Raw headline or raw redirect URL must never become a published tool record.

### C. Shared validator — `scripts/validate.py`

The validator is the single source of truth for both scraper and cleanup.

It contains:

- navigation/name blocklist
- markup/junk character rules
- sentence/headline detection
- generic domain detection
- news/media host blocklist
- social/aggregator blocklist
- ad/redirect/affiliate blocklist
- directory host blocklist
- Product Hunt redirect special case
- canonical category aliases
- `is_valid_name`, `is_valid_row`, `is_news_host`, `canonical_category`

When adding a new bad source:

1. Add the domain/pattern to `validate.py`.
2. Run classification tests.
3. Run `cleanup_junk.py --dry-run` or the manual backfill workflow.
4. Inspect examples before applying.
5. Apply soft rejection; never permanently delete scraped rows without backup/review.

### D. LLM enrichment — `scripts/llm_fill.py`

Purpose:

- Fill missing long description
- Generate features
- Add pricing detail only when clearly supported
- Mark `llm_filled`

Rules:

- LLM output is enrichment, not verification evidence.
- Do not let LLM invent pricing or official URL.
- Keep `MANIFEST_API_KEY` out of code/logs.
- Use `LLM_FILL_MAX` and `LLM_FILL_WORKERS` to control spend/concurrency.
- Recent cleanup runs used `fill_max=0`, so no enrichment calls were made.

## 8. Telegram approval flow

Telegram is the admin control plane.

Expected flow:

1. Tool submission/blog/prompt is inserted as `pending`.
2. Worker or script sends Telegram notification with inline buttons.
3. Admin clicks approve/reject.
4. `/telegram-webhook` validates admin identity.
5. Approval publishes or transfers the record.
6. Rejection removes/quarantines the pending record as designed.
7. Callback receives answer and message text is updated.

Expected callback families:

```text
approve_blog_<id>
reject_blog_<id>
approve_prompt_<id>
reject_prompt_<id>
approve_tool_<id>
reject_tool_<id>
```

Do not publish generated blogs/prompts directly from ingestion. The current code has been patched toward pending blog insertion, but future work must verify this end-to-end with a real Telegram test.

## 9. GitHub Actions and deployment

### Deploy workflow

`.github/workflows/deploy.yml` runs on push to `main` and does:

1. Checkout
2. Setup Node
3. `wrangler deploy` Worker
4. Smoke test/warm Worker API cache
5. Publish `public/` to Cloudflare Pages project `ai-directory-v5-radwan648`

Required repository secrets:

```text
CF_API_TOKEN
CF_ACCOUNT_ID
```

### Scheduled pipeline

`.github/workflows/pipeline.yml` currently schedules one run on six days per week at cron `0 2 * * 0,1,3,4,5,6`.

Main stages:

1. Install Python dependencies
2. Lint workflow files
3. Apply D1 indexes
4. Warm public cache
5. Fix/reconcile categories
6. Bake homepage snapshot
7. Bake offline dataset
8. Hide junk rows
9. Delete synthetic tools
10. Run Apify scraper
11. Run fresh data pipeline
12. Optional LLM enrichment
13. Send Telegram stats
14. Commit heartbeat and generated snapshots
15. Push heartbeat, which can trigger deployment

### Manual backfill workflow

`.github/workflows/backfill.yml` accepts:

- `fill_max`
- `workers`
- `cleanup`

It applies indexes, runs reversible junk cleanup, optionally runs LLM fill and sends Telegram stats.

For safe cleanup only, use:

```text
fill_max=0
workers=1
cleanup=true
```

This still invokes `llm_fill.py`, but with zero outstanding work; it produced `processed=0 written=0 failed=0` in the recent runs.

### Important workflow limitation

An attempted change to `.github/workflows/backfill.yml` was not pushed because the GitHub OAuth token lacked the `workflow` scope. The current repository workflow remains the pre-existing version. If editing workflow files is necessary, reauthorize GitHub with the `workflow` scope or use repository settings/token with that scope. Never paste a token into chat.

## 10. Required secrets and safety

Never include actual values in a handover file or chat.

Worker/Cloudflare secrets:

```text
CF_API_TOKEN
CF_ACCOUNT_ID
INTERNAL_API_KEY
TELEGRAM_BOT_TOKEN
ADMIN_TELEGRAM_ID
```

Pipeline secrets:

```text
APIFY_KEY_1 ... APIFY_KEY_N
PRODUCT_HUNT_KEY
PRODUCT_HUNT_SECRET
SERPAPI_KEY
GH_SEARCH_TOKEN
MANIFEST_API_KEY
TELEGRAM_BOT_TOKEN
ADMIN_TELEGRAM_ID
```

Security rules:

- Never ask the user to paste API keys in chat.
- Use GitHub Actions secrets, Cloudflare secrets or connected account authorization.
- Internal routes require `X-Internal-Key`.
- Validate Telegram admin ID before callbacks.
- Sanitize blog/LLM/RSS HTML before `innerHTML` or SSR output.
- Never expose D1 ID + bearer token combination as a credential.
- Use reversible `status='rejected'` cleanup instead of destructive delete.

## 11. Current known issues / next work

### High priority

1. **Canonical no-slash submit route:** `/submit/` works; `/submit` still returned 404 in public fetch. Keep `/submit/` in all navigation/canonical URLs or fix Pages routing with a verified route rule.
2. **Data quality:** Existing published rows are much cleaner, but every future pipeline run must report rejected/inserted/updated/duplicate counts. Continue reviewing article/model/affiliate edge cases.
3. **Pricing evidence:** Existing `free` rows may still be unverified. Add evidence/source fields before presenting pricing as fact.
4. **Category database migration:** Runtime API normalization is active, but the D1 table may still contain legacy category values. Run `fix_categories.py --apply` on a fresh quota and verify counts.
5. **Blog approval:** Test an actual generated blog from ingestion through Telegram approve/reject and public publication.

### Medium priority

6. Add explicit source fields: `source_name`, `source_type`, `source_url`, `official_url`, `verification_status`.
7. Improve tool detail page with real tags, quick facts, pros/cons, reviews/tutorials and complete JSON-LD.
8. Add quality thresholds to pipeline so a suspicious batch cannot automatically deploy.
9. Fix workflow lint false positives and improve shell/YAML validation.
10. Update README and original plan docs to reflect current scripts (`apify_scraper.py`, `fresh_data_pipeline.py`, snapshots, cleanup).

### Lower priority

11. Replace newest-as-trending with real metrics: views, GitHub stars, Product Hunt votes, downloads and time decay.
12. Improve logo handling; current UI often uses category emoji/favicons.
13. Improve sitemap/index quality so rejected, thin and low-quality content never enters SEO routes.
14. Add automated API contract tests and post-deploy route smoke tests for `/submit/`, `/tools`, `/blog`, `/prompts`, sitemap and robots.
15. UI redesign is intentionally postponed until backend/data/automation quality is stable.

## 12. Verification commands for the next AI

From repository root:

```powershell
python -m py_compile scripts/validate.py scripts/fresh_data_pipeline.py scripts/apify_scraper.py scripts/cleanup_junk.py scripts/fix_categories.py
node --check worker/worker.js
node --check functions/tools/index.js
node --check functions/post/[slug].js
node --check functions/submit/index.js
node --check public/js/app.js
python scripts/test_classification.py
python scripts/test_taxonomy_order.py
git diff --check
```

Read-only live checks:

```text
https://ai-directory-v5-radwan648.pages.dev/
https://ai-directory-v5-radwan648.pages.dev/tools
https://ai-directory-v5-radwan648.pages.dev/submit/
https://ai-directory-v5-worker.radwanislam648.workers.dev/api/stats
https://ai-directory-v5-worker.radwanislam648.workers.dev/api/categories
https://ai-directory-v5-worker.radwanislam648.workers.dev/api/tools?limit=3
```

Before any production write:

1. Read the relevant source and workflow.
2. Run local syntax/regression checks.
3. Inspect cleanup dry-run examples.
4. Avoid LLM spend unless explicitly required.
5. Commit with a clear message.
6. Push only after user-authorized scope is clear.
7. Watch the GitHub Actions deploy run.
8. Verify live routes and API responses.
9. Report exact commit, workflow run and unresolved limitations.

## 13. Handover instruction to another AI

Start by reading this file and then inspect, in order:

1. `README.md`
2. `wrangler.toml`
3. `worker/worker.js`
4. `scripts/validate.py`
5. `scripts/cleanup_junk.py`
6. `scripts/apify_scraper.py`
7. `scripts/fresh_data_pipeline.py`
8. `.github/workflows/deploy.yml`
9. `.github/workflows/pipeline.yml`
10. `.github/workflows/backfill.yml`

Do not start a redesign. First preserve the current architecture and improve data quality, source verification, approval safety and deploy reliability. Never assume a large tool count means a high-quality directory. Treat every scraped row as untrusted until its name, official URL, source type, description and pricing evidence pass validation.

## 14. Change history from the latest implementation session

Relevant commits pushed to `main`:

```text
1ddbde6 fix data quality submission and pipeline safety
18bf89e fix static submit route and normalize tool categories
fdf96ed fix submit routing and refresh category cache
4e4c022 tighten junk host cleanup and submit aliases
946bd5a add submit fallback and block affiliate redirects
134f008 redirect submit route to canonical slash URL
12d0505 refresh tools list and count cache keys
```

The project is live and deployable. The next phase should focus on source/official URL separation, pricing verification, blog approval end-to-end testing, category D1 reconciliation and the remaining `/submit` no-slash routing behavior—not visual redesign.
