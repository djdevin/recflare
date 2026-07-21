-- Drop the platform identity from refresh_tokens. A refreshed access token now takes
-- `platform`/`platform_id` from the account, which is where the bound identity lives —
-- the copy stored at issue time was redundant, and went stale if the account's
-- identity changed mid-session. Kept in sync with REFRESH_SCHEMA_DDL in
-- src/refresh-db.ts.

ALTER TABLE refresh_tokens DROP COLUMN platform;
ALTER TABLE refresh_tokens DROP COLUMN platform_id;
