-- Room instances — live sessions of a room. Stored as a JSON blob in `data` with
-- generated (virtual) columns for every field (snake_case, per the C# `[Column]`
-- names), the same pattern as the rooms/accounts tables. `id` (roomInstanceId) is
-- a sequential key held in the blob. Generated from src/room-instance-db.ts
-- (SCHEMA_DDL) — keep in sync. Written/read by the match worker.

CREATE TABLE IF NOT EXISTS room_instance (
  data TEXT NOT NULL,
  id INTEGER GENERATED ALWAYS AS (json_extract(data, '$.roomInstanceId')) VIRTUAL,
  owner_account_id INTEGER GENERATED ALWAYS AS (json_extract(data, '$.ownerAccountId')) VIRTUAL,
  room_id INTEGER GENERATED ALWAYS AS (json_extract(data, '$.roomId')) VIRTUAL,
  sub_room_id INTEGER GENERATED ALWAYS AS (json_extract(data, '$.subRoomId')) VIRTUAL,
  location TEXT GENERATED ALWAYS AS (json_extract(data, '$.location')) VIRTUAL,
  data_blob TEXT GENERATED ALWAYS AS (json_extract(data, '$.dataBlob')) VIRTUAL,
  event_id INTEGER GENERATED ALWAYS AS (json_extract(data, '$.eventId')) VIRTUAL,
  photon_region_id TEXT GENERATED ALWAYS AS (json_extract(data, '$.photonRegionId')) VIRTUAL,
  photon_room_id TEXT GENERATED ALWAYS AS (json_extract(data, '$.photonRoomId')) VIRTUAL,
  name TEXT GENERATED ALWAYS AS (json_extract(data, '$.name')) VIRTUAL,
  max_capacity INTEGER GENERATED ALWAYS AS (json_extract(data, '$.maxCapacity')) VIRTUAL,
  is_full INTEGER GENERATED ALWAYS AS (json_extract(data, '$.isFull')) VIRTUAL,
  is_private INTEGER GENERATED ALWAYS AS (json_extract(data, '$.isPrivate')) VIRTUAL,
  is_in_progress INTEGER GENERATED ALWAYS AS (json_extract(data, '$.isInProgress')) VIRTUAL,
  room_code TEXT GENERATED ALWAYS AS (json_extract(data, '$.roomCode')) VIRTUAL,
  room_instance_type INTEGER GENERATED ALWAYS AS (json_extract(data, '$.roomInstanceType')) VIRTUAL,
  club_id INTEGER GENERATED ALWAYS AS (json_extract(data, '$.clubId')) VIRTUAL,
  encrypt_voice_chat INTEGER GENERATED ALWAYS AS (json_extract(data, '$.EncryptVoiceChat')) VIRTUAL,
  matchmaking_policy INTEGER GENERATED ALWAYS AS (json_extract(data, '$.matchmakingPolicy')) VIRTUAL,
  allow_new_users INTEGER GENERATED ALWAYS AS (json_extract(data, '$.allowNewUsers')) VIRTUAL,
  join_disabled INTEGER GENERATED ALWAYS AS (json_extract(data, '$.joinDisabled')) VIRTUAL,
  created_at TEXT GENERATED ALWAYS AS (json_extract(data, '$.createdAt')) VIRTUAL
  );
CREATE UNIQUE INDEX IF NOT EXISTS idx_room_instance_id ON room_instance (id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_room_instance_photon_room_id ON room_instance (photon_room_id);
CREATE INDEX IF NOT EXISTS idx_room_instance_room_id ON room_instance (room_id);
