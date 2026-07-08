-- Friendship / relationship storage. Unlike the JSON-blob tables in this shared
-- database, a relationship is genuinely columnar, so it gets a normal relational
-- table (mirror of the Go/GORM `Relationship` model). Owned by the `api` worker;
-- generated from src/relationships-db.ts (SCHEMA_DDL) — keep in sync.
--
-- Exactly one row exists per unordered pair of players: the initiator is the
-- `requester`, the other is the `target`. `relationship_type` is stored from the
-- requester's point of view (0 None, 1 FriendRequestSent, 2 FriendRequestReceived,
-- 3 Friend); the target's projection flips Sent<->Received.

CREATE TABLE IF NOT EXISTS relationship (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  requester_id INTEGER NOT NULL,
  target_id INTEGER NOT NULL,
  relationship_type INTEGER NOT NULL DEFAULT 0,
  requester_favorited INTEGER NOT NULL DEFAULT 0,
  requester_ignored INTEGER NOT NULL DEFAULT 0,
  requester_muted INTEGER NOT NULL DEFAULT 0,
  target_favorited INTEGER NOT NULL DEFAULT 0,
  target_ignored INTEGER NOT NULL DEFAULT 0,
  target_muted INTEGER NOT NULL DEFAULT 0
  );
CREATE UNIQUE INDEX IF NOT EXISTS idx_relationship ON relationship (requester_id, target_id);
CREATE INDEX IF NOT EXISTS idx_relationship_target ON relationship (target_id);
