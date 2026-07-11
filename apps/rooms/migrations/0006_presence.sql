-- Player presence — the room instance a player is currently in, plus the status
-- fields the match heartbeat echoes back. Stored as a JSON blob in `data` with
-- generated (virtual) columns for the fields we query on, the same pattern as the
-- rooms/room_instance tables. One row per account (unique `account_id`); writes
-- upsert via INSERT OR REPLACE. Rows carry an absolute `expires_at` (epoch
-- seconds) — reads filter expired rows out and a cleanup pass purges them.
-- Generated from packages/domain/src/presence-db.ts (PRESENCE_SCHEMA_DDL) — keep
-- in sync. Written by the match/auth workers, read by match/rooms.

CREATE TABLE IF NOT EXISTS presence (
  data TEXT NOT NULL,
  account_id INTEGER GENERATED ALWAYS AS (json_extract(data, '$.accountId')) VIRTUAL,
  room_instance_id INTEGER GENERATED ALWAYS AS (json_extract(data, '$.roomInstance.roomInstanceId')) VIRTUAL,
  room_id INTEGER GENERATED ALWAYS AS (json_extract(data, '$.roomInstance.roomId')) VIRTUAL,
  expires_at INTEGER GENERATED ALWAYS AS (json_extract(data, '$.expiresAt')) VIRTUAL
  );
CREATE UNIQUE INDEX IF NOT EXISTS idx_presence_account ON presence (account_id);
CREATE INDEX IF NOT EXISTS idx_presence_room_instance ON presence (room_instance_id);
CREATE INDEX IF NOT EXISTS idx_presence_expires ON presence (expires_at);
