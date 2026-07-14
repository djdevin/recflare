-- Saved outfits, owned by the `econ` worker. One row per (account, slot): the client
-- posts an outfit with a `Slot` to /api/avatar/v3/saved/set, and re-saving that slot
-- overwrites it. The outfit is the client's own JSON payload, stored opaquely — we
-- never query inside it. Kept in sync with OUTFIT_SCHEMA_DDL in src/outfit-db.ts.

CREATE TABLE IF NOT EXISTS outfit (
  account_id INTEGER NOT NULL,
  set_id INTEGER NOT NULL,
  avatar TEXT NOT NULL,
  PRIMARY KEY (account_id, set_id)
  );
