-- Club announcements — the club's noticeboard (`/announcements/club/:clubId`),
-- served newest first. Unlike the club itself this isn't a JSON blob: the Go model
-- is plain columns and nothing here is client-shaped beyond the fields themselves.
-- Owned by the `clubs` worker; generated from src/clubs-db.ts (SCHEMA_DDL) — keep
-- in sync.

CREATE TABLE IF NOT EXISTS club_announcement (
  announcement_id INTEGER PRIMARY KEY AUTOINCREMENT,
  club_id INTEGER NOT NULL,
  account_id INTEGER NOT NULL,
  title TEXT NOT NULL DEFAULT '',
  body TEXT NOT NULL DEFAULT '',
  image_name TEXT NOT NULL DEFAULT '',
  meta TEXT NOT NULL DEFAULT '',
  created_at TEXT
  );
CREATE INDEX IF NOT EXISTS idx_club_announcement_club ON club_announcement (club_id);
