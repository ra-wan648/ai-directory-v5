-- 001_indexes.sql — index the columns the site actually queries on.
--
-- Why this exists: D1's free tier bills by ROWS READ (5,000,000/day on Workers
-- Free), and on 12 Sep 2026 the account hit that ceiling. The pipeline was not
-- the cause - it reads ~108k rows a day, about 2% of the allowance. The cause
-- was worker/worker.js: every listing request ran a COUNT(*) over the whole
-- filtered table and then a `SELECT *` for the page, and `tools` had no index
-- on a single one of the filtered/sorted columns (schema.sql created none; the
-- only index was the implicit one behind `slug UNIQUE`). With 12,326 published
-- tools that is a full table scan per request, twice - a few hundred page views
-- could exhaust the day on their own.
--
-- These are additive. Nothing is dropped, no query changes, and the same
-- requests get faster. Every statement is IF NOT EXISTS so the migration is
-- safe to re-run on every pipeline pass.
--
-- The shapes below are taken one-for-one from worker/worker.js:
--   WHERE status = 'published'                          ORDER BY created_at DESC
--   WHERE status = 'published' AND created_at > datetime('now','-24 hours')
--   WHERE status = 'published' AND created_at > datetime('now','-7 days')
--   WHERE status = 'published' AND pricing = 'free'
--   WHERE status = 'published' AND category = ?
--   WHERE featured = 1 AND status = 'published'
--   ORDER BY votes DESC, views DESC, created_at DESC

CREATE INDEX IF NOT EXISTS idx_tools_status_created
  ON tools(status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_tools_status_category
  ON tools(status, category, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_tools_status_pricing
  ON tools(status, pricing, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_tools_featured
  ON tools(featured, status, created_at DESC);

-- "Top" / trending listings sort on three columns at once.
CREATE INDEX IF NOT EXISTS idx_tools_status_ranking
  ON tools(status, votes DESC, views DESC, created_at DESC);

-- Lookup by slug already has an index via the UNIQUE constraint; this one is
-- for the pipeline's own duplicate checks on url.
CREATE INDEX IF NOT EXISTS idx_tools_url
  ON tools(url);

CREATE INDEX IF NOT EXISTS idx_tools_category
  ON tools(category);

-- Tool pages and the sitemap pull by slug; the blog list sorts by publish date.
CREATE INDEX IF NOT EXISTS idx_blogs_status_published
  ON blogs(status, published_at DESC);
