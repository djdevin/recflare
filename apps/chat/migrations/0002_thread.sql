-- Chat threads and their membership, owned by the `chat` worker.
--
-- A thread is a conversation — a DM pair, a group chat, or a system thread. Membership
-- in `thread_member` is the authorization gate: a player may read or post to a thread
-- only if they hold a row here, and the same rows render the `playerIds` array the
-- client shows. There is deliberately no FK to accounts, here or on
-- `message.sender_player_id`: that table belongs to the `auth` worker, and a thread
-- outlives the accounts in it.
--
-- `latest_message_id` is denormalized onto the thread so the thread list renders from
-- one indexed row per thread instead of a per-thread MAX() over `message`; it also
-- orders that list (message ids being monotonic, newest thread = highest id). Kept in
-- sync on every insert — see touchThread in src/thread-db.ts.
--
-- The per-viewer fields live on the membership row, not the thread: two players in one
-- DM have independent read positions, snoozes, and favorites. Kept in sync with
-- THREAD_SCHEMA_DDL in src/thread-db.ts.

CREATE TABLE IF NOT EXISTS message_thread (
  chat_thread_id INTEGER PRIMARY KEY AUTOINCREMENT,
  -- Null for DMs and unnamed groups; the client falls back to rendering the members.
  chat_thread_name TEXT,
  latest_message_id INTEGER,
  created_at TEXT NOT NULL
  );
CREATE INDEX IF NOT EXISTS idx_message_thread_latest ON message_thread (latest_message_id);

CREATE TABLE IF NOT EXISTS thread_member (
  chat_thread_id INTEGER NOT NULL,
  player_id INTEGER NOT NULL,
  last_read_message_id INTEGER,
  snoozed_until TEXT,
  is_favorited INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (chat_thread_id, player_id)
  );
-- The thread-list query is "every thread this player is in", so player_id leads.
CREATE INDEX IF NOT EXISTS idx_thread_member_player ON thread_member (player_id);
