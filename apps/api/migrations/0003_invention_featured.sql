-- Break `IsFeatured` out of the invention JSON blob into a queryable generated
-- column, so the featured feed (`/api/inventions/v1/featured`) filters in SQL on
-- an index instead of parsing every published invention in memory. Generated from
-- src/inventions-db.ts (SCHEMA_DDL) — keep in sync.
--
-- SQLite allows ALTER TABLE ADD COLUMN only for VIRTUAL generated columns (a
-- STORED one would need rewriting existing rows), which is what we want anyway:
-- the value stays derived from `data`, so nothing can drift out of sync with it.
-- json_extract of a JSON `true` is 1, so the column reads 1/0.

ALTER TABLE invention
  ADD COLUMN is_featured INTEGER GENERATED ALWAYS AS (json_extract(data, '$.IsFeatured')) VIRTUAL;
CREATE INDEX IF NOT EXISTS idx_invention_featured ON invention (is_featured);
