-- Rooms stored as a JSON blob with generated (virtual) columns for querying.
-- Generated from src/rooms-db.ts (SCHEMA_DDL + DORM_ROOM) — keep in sync.

CREATE TABLE IF NOT EXISTS rooms (
  data TEXT NOT NULL,
  room_id INTEGER GENERATED ALWAYS AS (json_extract(data, '$.RoomId')) VIRTUAL,
  name TEXT GENERATED ALWAYS AS (json_extract(data, '$.Name')) VIRTUAL,
  name_lower TEXT GENERATED ALWAYS AS (lower(json_extract(data, '$.Name'))) VIRTUAL,
  creator_account_id INTEGER GENERATED ALWAYS AS (json_extract(data, '$.CreatorAccountId')) VIRTUAL,
  is_dorm INTEGER GENERATED ALWAYS AS (json_extract(data, '$.IsDorm')) VIRTUAL
  );
CREATE UNIQUE INDEX IF NOT EXISTS idx_rooms_room_id ON rooms (room_id);
CREATE INDEX IF NOT EXISTS idx_rooms_name_lower ON rooms (name_lower);
CREATE INDEX IF NOT EXISTS idx_rooms_creator ON rooms (creator_account_id);

-- Seed the default dorm (RoomId 1).
INSERT OR IGNORE INTO rooms (data) VALUES ('{"RoomId":1,"Name":"DormRoom","Description":"Your private room","CreatorAccountId":1,"ImageName":"DefaultRoomImage.jpg","State":0,"Accessibility":0,"SupportsLevelVoting":false,"IsRRO":false,"IsDorm":true,"CloningAllowed":false,"SupportsVRLow":true,"SupportsQuest2":true,"SupportsMobile":true,"SupportsScreens":true,"SupportsWalkVR":true,"SupportsTeleportVR":true,"SupportsJuniors":true,"MinLevel":0,"WarningMask":0,"CustomWarning":null,"DisableMicAutoMute":false,"DisableRoomComments":false,"EncryptVoiceChat":false,"CreatedAt":"2026-01-18T02:31:37.6171131","Stats":{"CheerCount":0,"FavoriteCount":0,"VisitorCount":1,"VisitCount":1},"SubRooms":[{"SubRoomId":1,"Name":"","DataBlob":"","IsSandbox":false,"MaxPlayers":4,"Accessibility":0,"UnitySceneId":"76d98498-60a1-430c-ab76-b54a29b7a163","DataSavedAt":"2026-01-18T02:31:37.6171131"}],"Roles":[],"LoadScreens":[],"PromoImages":[],"PromoExternalContent":[],"Tags":[]}');
