-- Index the ORDER BY views DESC queries.
--
-- 001_indexes.sql covered status, category, pricing, featured and the votes/
-- views ranking as a group. It missed the queries that sort by `views` alone
-- inside a filter, and those are the expensive ones:
--
--   related / alternatives   WHERE category = ? AND slug != ? AND status = 'published'
--                            ORDER BY views DESC LIMIT 6
--   free tools               WHERE status = 'published' AND pricing = 'free'
--                            ORDER BY views DESC LIMIT 30
--
-- With no index carrying `views`, SQLite has to read every row that matches the
-- filter and sort them before it can take the first six. "AI Tools" holds 4,294
-- of the 7,812 published rows, so each tool page view and each alternatives page
-- view read roughly 4,300 rows - twice per request, because apiToolsSlug runs
-- both the related and the reviews query. D1 reported 7,739,381 rows read on
-- 13 Sep against a 5,000,000/day free-tier ceiling; 001_indexes.sql already
-- established that the pipeline accounts for only ~108k of that.
--
-- With an index that carries the ordering, SQLite walks it in order and stops
-- after LIMIT, so the same query reads single digits. Additive and IF NOT
-- EXISTS, so this is safe to re-run on every pipeline pass.

CREATE INDEX IF NOT EXISTS idx_tools_status_category_views
  ON tools(status, category, views DESC);

CREATE INDEX IF NOT EXISTS idx_tools_status_pricing_views
  ON tools(status, pricing, views DESC);

-- Any listing that sorts by views with no other filter.
CREATE INDEX IF NOT EXISTS idx_tools_status_views
  ON tools(status, views DESC);
