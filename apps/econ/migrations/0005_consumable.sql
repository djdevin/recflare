-- Owned consumables, owned by the `econ` worker. Unlike avatar items (own-once, one
-- row per (account, item)), consumables stack: each purchase inserts a fresh instance
-- row carrying its own id, count and created_at. Granted at purchase time by
-- `/api/storefronts/v2/buyItem` (when the gift-drop carries a `ConsumableItemDesc`) and
-- read back by `/api/consumables/v2/getUnlocked`, which groups a player's rows by
-- `consumable_item_desc` into the client's unlocked-consumable DTO (its `Ids`/`CreatedAts`
-- are these per-instance columns; `Count` their sum). Kept in sync with
-- CONSUMABLE_SCHEMA_DDL in src/consumables-db.ts.

CREATE TABLE IF NOT EXISTS consumable (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id INTEGER NOT NULL,
  consumable_item_desc TEXT NOT NULL,
  count INTEGER NOT NULL,
  created_at TEXT NOT NULL
  );

CREATE INDEX IF NOT EXISTS idx_consumable_account ON consumable (account_id);
