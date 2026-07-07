-- Refresh tokens (owned by the auth worker). Only a SHA-256 hash of each token is
-- stored, never the raw value. Single-use: redeeming deletes the row and a new
-- token is issued in its place (rotation). platform/platform_id are kept so the
-- access token can be re-minted on refresh. Kept in sync with REFRESH_SCHEMA_DDL
-- in src/refresh-db.ts.

CREATE TABLE IF NOT EXISTS refresh_tokens (
  token_hash TEXT PRIMARY KEY,
  account_id INTEGER NOT NULL,
  platform TEXT NOT NULL,
  platform_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
  );
CREATE INDEX IF NOT EXISTS idx_refresh_tokens_account ON refresh_tokens (account_id);
CREATE INDEX IF NOT EXISTS idx_refresh_tokens_expires ON refresh_tokens (expires_at);
