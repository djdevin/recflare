-- Rename the `rooms` table to `room`, matching the singular naming of the other
-- tables (`interaction`, `room_instance`). SQLite carries the generated columns
-- and the idx_rooms_* indexes over to the renamed table automatically, so this
-- is the whole change. SCHEMA_DDL in src/rooms-db.ts already creates `room`.

ALTER TABLE rooms RENAME TO room;
