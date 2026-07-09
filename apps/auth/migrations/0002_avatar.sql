-- Store the player's avatar (set via the econ worker's /api/avatar/v2/set). It's
-- an opaque JSON payload that isn't queried, so a single nullable TEXT column on
-- the account row suffices. Kept in sync with SCHEMA_DDL in @repo/domain's accounts-db.ts.

ALTER TABLE accounts ADD COLUMN avatar TEXT;
