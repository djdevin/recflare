-- Link accounts to their platform-native identity (e.g. a SteamID64 for platform 0)
-- and index it so /cachedlogin/forplatformid can look accounts up by platform id.
-- platformId lives in the JSON blob (stored as a string — a SteamID64 exceeds 2^53
-- and would lose precision as a number); this exposes it as an indexed generated
-- column. Kept in sync with SCHEMA_DDL in @repo/domain's accounts-db.ts.

ALTER TABLE accounts ADD COLUMN platform_id TEXT GENERATED ALWAYS AS (json_extract(data, '$.platformId')) VIRTUAL;
CREATE INDEX IF NOT EXISTS idx_accounts_platform_id ON accounts (platform_id);
