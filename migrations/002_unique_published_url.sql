-- One published row per url.
--
-- The tools table only declares `slug TEXT UNIQUE`, and every insert used
-- `ON CONFLICT(slug) DO NOTHING`. The same product scraped twice under slightly
-- different names therefore became two rows: a run on 2026-09-13 found 873
-- published url groups with duplicates - 884 extra rows - including
-- runwayml.com three times and repairsh.../emergent.sh three times.
--
-- The index is partial on purpose. Only published rows must be unique, so a
-- rejected row never blocks the same url being published again later, and any
-- number of rejected rows may share a url.
--
-- IMPORTANT: this index turns a duplicate url into a constraint violation. Every
-- insert that writes tools must therefore use `INSERT OR IGNORE`, not
-- `ON CONFLICT(slug) DO NOTHING` - the latter only handles a slug clash and
-- would raise IntegrityError on a url clash, failing the whole nightly run.
-- Verified against a scratch SQLite database before being applied.
CREATE UNIQUE INDEX IF NOT EXISTS idx_tools_published_url
  ON tools(url)
  WHERE status = 'published' AND url IS NOT NULL AND TRIM(url) != '';
