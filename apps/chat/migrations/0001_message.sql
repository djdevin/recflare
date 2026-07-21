-- Chat messages, owned by the `chat` worker. One row per message posted to a thread;
-- columns rather than a JSON blob (mirroring the reference model), since every field is a
-- scalar the server reads: threads are listed newest-first by (chat_thread_id,
-- chat_message_id), and `time_sent` is carried for display only.
--
-- `chat_message_id` is server-assigned (AUTOINCREMENT) so ids are unique across every
-- thread, matching the client's expectation of a global message id. `contents` is the
-- client's envelope — `{"Type":0,"Version":1,"Data":"..."}` — stored verbatim as an
-- opaque string and served back untouched, so new message types need no schema change.
-- `moderation_state` is the ChatModerationState enum (0 = none). Kept in sync with
-- SCHEMA_DDL in src/message-db.ts.

CREATE TABLE IF NOT EXISTS message (
  chat_message_id INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_thread_id INTEGER NOT NULL,
  sender_player_id INTEGER NOT NULL,
  time_sent TEXT NOT NULL,
  contents TEXT NOT NULL,
  moderation_state INTEGER NOT NULL DEFAULT 0
  );
CREATE INDEX IF NOT EXISTS idx_message_thread ON message (chat_thread_id, chat_message_id);
CREATE INDEX IF NOT EXISTS idx_message_sender ON message (sender_player_id);
