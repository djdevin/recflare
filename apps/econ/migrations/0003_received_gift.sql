-- Received gift boxes, owned by the `econ` worker. One row per box: a box is created
-- when a player buys a storefront item (`/api/storefronts/v2/buyItem`) and deleted when
-- the client opens it (`/api/avatar/v2/gifts/consume`, on the `api` worker). Opening is
-- cosmetic — the item is granted into the `inventory` table at purchase time, so a box
-- carries only its rendered content (`data`) for the gift list. Kept in sync with
-- RECEIVED_GIFT_SCHEMA_DDL in @repo/domain's gifts-db.ts.

CREATE TABLE IF NOT EXISTS received_gift (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id INTEGER NOT NULL,
  data TEXT NOT NULL,
  created_at TEXT NOT NULL
  );

CREATE INDEX IF NOT EXISTS idx_received_gift_account ON received_gift (account_id);
