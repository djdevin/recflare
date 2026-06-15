-- Per-player interaction state with a room (cheered/favorited + last visit).
-- One row per (player, room); cheer/favorite are toggled in place.
CREATE TABLE IF NOT EXISTS interaction (
	player_id INTEGER NOT NULL,
	room_id INTEGER NOT NULL,
	cheered INTEGER NOT NULL DEFAULT 0,
	favorited INTEGER NOT NULL DEFAULT 0,
	last_visited_at TEXT,
	PRIMARY KEY (player_id, room_id)
);
