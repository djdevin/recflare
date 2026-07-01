-- Image metadata stored as a JSON blob with generated (virtual) columns for
-- querying. Written by the `api` worker on upload (/api/images/v4/uploadsaved)
-- and read back via /api/images/v6. Generated from src/images-db.ts (SCHEMA_DDL)
-- — keep in sync.

CREATE TABLE IF NOT EXISTS image (
  data TEXT NOT NULL,
  id INTEGER GENERATED ALWAYS AS (json_extract(data, '$.Id')) VIRTUAL,
  image_name TEXT GENERATED ALWAYS AS (json_extract(data, '$.ImageName')) VIRTUAL,
  player_id INTEGER GENERATED ALWAYS AS (json_extract(data, '$.PlayerId')) VIRTUAL,
  room_id INTEGER GENERATED ALWAYS AS (json_extract(data, '$.RoomId')) VIRTUAL
  );
CREATE UNIQUE INDEX IF NOT EXISTS idx_image_id ON image (id);
CREATE INDEX IF NOT EXISTS idx_image_image_name ON image (image_name);
CREATE INDEX IF NOT EXISTS idx_image_player_id ON image (player_id);
CREATE INDEX IF NOT EXISTS idx_image_room_id ON image (room_id);
