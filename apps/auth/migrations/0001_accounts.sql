-- Accounts stored as a JSON blob with generated (virtual) columns for querying.
-- Generated from src/accounts-db.ts (SCHEMA_DDL) — keep in sync.

CREATE TABLE IF NOT EXISTS accounts (
  data TEXT NOT NULL,
  account_id INTEGER GENERATED ALWAYS AS (json_extract(data, '$.AccountId')) VIRTUAL,
  username_lower TEXT GENERATED ALWAYS AS (lower(json_extract(data, '$.Username'))) VIRTUAL
  );
CREATE UNIQUE INDEX IF NOT EXISTS idx_accounts_account_id ON accounts (account_id);
CREATE INDEX IF NOT EXISTS idx_accounts_username_lower ON accounts (username_lower);

-- Seed the system account (uid 0) and Coach (uid 1).
INSERT OR IGNORE INTO accounts (data) VALUES ('{"AccountId":0,"Username":"RecRoom","DisplayName":"Rec Room","ProfileImage":"DefaultProfileImage.jpg","IsJunior":false,"Platforms":0,"PersonalPronouns":0,"IdentityFlags":0,"CreatedAt":"2016-01-01T00:00:00Z"}');
INSERT OR IGNORE INTO accounts (data) VALUES ('{"AccountId":1,"Username":"Coach","DisplayName":"Coach","ProfileImage":"DefaultProfileImage.jpg","IsJunior":false,"Platforms":0,"PersonalPronouns":0,"IdentityFlags":0,"CreatedAt":"2016-01-01T00:00:00Z"}');
