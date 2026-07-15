-- Owned avatar items, owned by the `econ` worker. One row per (account, item): the
-- items a player has bought from a storefront. Granted at purchase time by
-- `/api/storefronts/v2/buyItem` and read back by `/api/avatar/v4/items`, where they are
-- concatenated with the default catalog. The item is keyed by its `AvatarItemDesc` (the
-- gift-drop's item guid string) so re-buying the same item is a no-op rather than a
-- duplicate row; `data` is the rendered avatar-item DTO. Kept in sync with
-- INVENTORY_SCHEMA_DDL in src/inventory-db.ts.

CREATE TABLE IF NOT EXISTS inventory (
  account_id INTEGER NOT NULL,
  avatar_item_desc TEXT NOT NULL,
  data TEXT NOT NULL,
  PRIMARY KEY (account_id, avatar_item_desc)
  );
