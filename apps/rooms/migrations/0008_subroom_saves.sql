-- Room saves as first-class entities. A subroom POINTS at its saves by bare id — the
-- live/published one the loader downloads (`current_save_id`) and the creator's
-- unpublished one (`staged_save_id`, unused for now) — and `StagedSubRoomDataSaveId`
-- carries no subroom context, so a save id has to be globally unique to be resolvable.
-- Numbering saves per subroom (what the embedded `CurrentSave` did) makes every
-- subroom's first save id 1 and those pointers ambiguous. Same reasoning as 0007 for
-- SubRoomId. It also gives `GET …/subrooms/{id}/saves` real history to page over.
--
-- Generated from packages/domain/src/rooms-db.ts (SUBROOM_SCHEMA_DDL) — keep in sync.

CREATE TABLE IF NOT EXISTS subroom_save (
  sub_room_data_save_id INTEGER PRIMARY KEY AUTOINCREMENT,
  sub_room_id INTEGER NOT NULL,
  data TEXT NOT NULL
  );
CREATE INDEX IF NOT EXISTS idx_subroom_save_sub ON subroom_save (sub_room_id);

ALTER TABLE subroom ADD COLUMN current_save_id INTEGER;
ALTER TABLE subroom ADD COLUMN staged_save_id INTEGER;

-- Backfill 1: subrooms that already carry an embedded `CurrentSave` object. The two id
-- fields are dropped from the stored blob — the columns are authoritative and are
-- re-injected on read.
INSERT INTO subroom_save (sub_room_id, data)
  SELECT
    sub_room_id,
    json_remove(json_extract(data, '$.CurrentSave'), '$.SubRoomDataSaveId', '$.SubRoomId')
  FROM subroom
  WHERE json_extract(data, '$.CurrentSave') IS NOT NULL;

-- Backfill 2: subrooms saved before `CurrentSave` existed, whose blob key sits in the
-- flat `DataBlob`/`DataSavedAt`/`PersistenceVersion` fields. They hold real saved content
-- the client can't see (it reads only `CurrentSave`), so they become saves too rather
-- than reading as never-saved. Shape matches the reference's MapSave projection.
INSERT INTO subroom_save (sub_room_id, data)
  SELECT
    sub_room_id,
    json_object(
      'UnitySubAssets', json('[]'),
      'ReferencedUnityAssets', json('[]'),
      'DataBlob', json_extract(data, '$.DataBlob'),
      'ReferencedUnityAssetIds', json('[]'),
      'PersistenceVersion', COALESCE(json_extract(data, '$.PersistenceVersion'), 0),
      'OMVersion', 0,
      'UgcSubVersion', 0,
      'SavedByAccountId', json_extract(data, '$.CreatorAccountId'),
      'SavedOnPlatform', 0,
      'SavedOnDeviceClass', 0,
      'Description', '',
      'Tags', json('[]'),
      'ModerationState', 0,
      'CreatedAt', COALESCE(json_extract(data, '$.DataSavedAt'), '1970-01-01T00:00:00.000Z')
    )
  FROM subroom
  WHERE json_extract(data, '$.CurrentSave') IS NULL
    AND COALESCE(json_extract(data, '$.DataBlob'), '') <> '';

-- Point each subroom at the save just minted for it. At this moment a subroom has at
-- most one save row, so the correlated subquery is unambiguous.
UPDATE subroom SET current_save_id = (
  SELECT s.sub_room_data_save_id FROM subroom_save s WHERE s.sub_room_id = subroom.sub_room_id
  );

-- Single source of truth: the save now lives in `subroom_save`, and
-- `StagedSubRoomDataSaveId` is served from the `staged_save_id` column.
UPDATE subroom SET data = json_remove(data, '$.CurrentSave', '$.StagedSubRoomDataSaveId');
