-- Accounts stored as a JSON blob with generated (virtual) columns for querying.
-- Generated from @repo/domain's accounts-db.ts (SCHEMA_DDL) — keep in sync.

CREATE TABLE IF NOT EXISTS accounts (
  data TEXT NOT NULL,
  account_id INTEGER GENERATED ALWAYS AS (json_extract(data, '$.accountId')) VIRTUAL,
  username_lower TEXT GENERATED ALWAYS AS (lower(json_extract(data, '$.username'))) VIRTUAL
  );
CREATE UNIQUE INDEX IF NOT EXISTS idx_accounts_account_id ON accounts (account_id);
CREATE INDEX IF NOT EXISTS idx_accounts_username_lower ON accounts (username_lower);

-- Seed the system account (uid 0) and Coach (uid 1).
INSERT OR IGNORE INTO accounts (data) VALUES ('{"accountId":0,"username":"RecRoom","displayName":"Rec Room","profileImage":"DefaultProfileImage.jpg","isJunior":false,"platforms":0,"personalPronouns":0,"identityFlags":0,"createdAt":"2016-01-01T00:00:00Z"}');
INSERT OR IGNORE INTO accounts (data) VALUES ('{"accountId":1,"username":"Coach","displayName":"Coach","profileImage":"DefaultProfileImage.jpg","isJunior":false,"platforms":0,"personalPronouns":0,"identityFlags":0,"createdAt":"2016-01-01T00:00:00Z"}');
