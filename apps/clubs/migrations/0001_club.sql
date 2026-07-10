-- Club storage. A club is a single JSON blob in the `data` column (the
-- client-facing Club DTO); queryable fields are SQLite generated (virtual) columns
-- extracted from that JSON and indexed — the same JSON-blob pattern the
-- rooms/accounts tables use. Mirror of the Go/GORM `Club` model. Owned by the
-- `clubs` worker; generated from src/clubs-db.ts (SCHEMA_DDL) — keep in sync.
--
-- Membership lives in `club_member` (one row per club/account); the club's
-- MemberCount is denormalized and kept in sync from those rows.

CREATE TABLE IF NOT EXISTS club (
  data TEXT NOT NULL,
  club_id INTEGER GENERATED ALWAYS AS (json_extract(data, '$.ClubId')) VIRTUAL,
  name_lower TEXT GENERATED ALWAYS AS (lower(json_extract(data, '$.Name'))) VIRTUAL,
  category TEXT GENERATED ALWAYS AS (json_extract(data, '$.Category')) VIRTUAL,
  visibility INTEGER GENERATED ALWAYS AS (json_extract(data, '$.Visibility')) VIRTUAL,
  state INTEGER GENERATED ALWAYS AS (json_extract(data, '$.State')) VIRTUAL,
  creator_account_id INTEGER GENERATED ALWAYS AS (json_extract(data, '$.CreatorAccountId')) VIRTUAL
  );
CREATE UNIQUE INDEX IF NOT EXISTS idx_club_club_id ON club (club_id);
CREATE INDEX IF NOT EXISTS idx_club_name_lower ON club (name_lower);
CREATE INDEX IF NOT EXISTS idx_club_category ON club (category);
CREATE INDEX IF NOT EXISTS idx_club_creator ON club (creator_account_id);

-- `membership_type` (ClubMembershipType) encodes bans, pending request/invite
-- states, and role tiers in one field. Surrogate PK mirrors the Go model; the
-- UNIQUE (club_id, account_id) index enforces one membership per pair.
CREATE TABLE IF NOT EXISTS club_member (
  club_member_id INTEGER PRIMARY KEY AUTOINCREMENT,
  club_id INTEGER NOT NULL,
  account_id INTEGER NOT NULL,
  membership_type INTEGER NOT NULL DEFAULT 0,
  created_at TEXT
  );
CREATE UNIQUE INDEX IF NOT EXISTS idx_club_member_pair ON club_member (club_id, account_id);
CREATE INDEX IF NOT EXISTS idx_club_member_account ON club_member (account_id);
