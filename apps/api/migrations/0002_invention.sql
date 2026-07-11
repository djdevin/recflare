-- Saved-invention metadata storage. Like the image/rooms/accounts tables in this
-- shared database, an invention is a single JSON blob in the `data` column, with
-- queryable fields (Id, CreatorPlayerId) exposed as SQLite generated (virtual)
-- columns extracted from that JSON. Owned by the `api` worker; generated from
-- src/inventions-db.ts (SCHEMA_DDL) — keep in sync.
--
-- The invention's data file is uploaded separately through the `storage` worker
-- (under the `invention/` prefix) and referenced here by `CurrentVersion.BlobName`;
-- only the metadata lives in this table. The DTO mirrors Rec Room's PascalCase
-- `RRInvention` shape.

CREATE TABLE IF NOT EXISTS invention (
  data TEXT NOT NULL,
  id INTEGER GENERATED ALWAYS AS (json_extract(data, '$.InventionId')) VIRTUAL,
  creator_player_id INTEGER GENERATED ALWAYS AS (json_extract(data, '$.CreatorPlayerId')) VIRTUAL
  );
CREATE UNIQUE INDEX IF NOT EXISTS idx_invention_id ON invention (id);
CREATE INDEX IF NOT EXISTS idx_invention_creator ON invention (creator_player_id);
