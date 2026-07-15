-- A player's interaction with a saved image — one row per (player, image). Only
-- `cheered` for now; named generically so other per-user interactions (e.g.
-- favorited) can be added as columns later. Written by the `api` worker's cheer
-- endpoints (/api/images/v1/cheer, /api/images/v5/cheered/bulk), which also keeps
-- the image's denormalized CheerCount in sync from it. Generated from
-- src/images-db.ts (SCHEMA_DDL) — keep in sync.

CREATE TABLE IF NOT EXISTS image_interaction (
  player_id INTEGER NOT NULL,
  saved_image_id INTEGER NOT NULL,
  cheered INTEGER NOT NULL DEFAULT 0,
  created_at TEXT,
  PRIMARY KEY (player_id, saved_image_id)
  );
CREATE INDEX IF NOT EXISTS idx_image_interaction_image ON image_interaction (saved_image_id);
