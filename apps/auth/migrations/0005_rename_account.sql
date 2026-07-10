-- Rename the `accounts` table to `account`, matching the singular naming of the
-- other tables (`room`, `interaction`, `room_instance`, `image`, `club`). SQLite
-- carries the generated columns and the idx_accounts_* indexes over to the renamed
-- table automatically, so this is the whole change. SCHEMA_DDL in @repo/domain's
-- accounts-db.ts already creates `account`.

ALTER TABLE accounts RENAME TO account;
