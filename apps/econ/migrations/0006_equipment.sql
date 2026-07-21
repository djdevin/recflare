-- Owned equipment, owned by the `econ` worker. Like avatar items (own-once, one row
-- per (account, item)) rather than consumables (which stack): equipment is a boolean
-- unlock keyed by its `EquipmentModificationGuid` (the gift-drop's equipment guid), so
-- re-buying the same skin is a no-op rather than a duplicate row. Granted at purchase
-- time by `/api/storefronts/v2/buyItem` (when the gift-drop carries an
-- `EquipmentModificationGuid`) and read back by `/api/equipment/v2/getUnlocked`; `data`
-- is the rendered unlocked-equipment DTO. Kept in sync with EQUIPMENT_SCHEMA_DDL in
-- src/equipment-db.ts.

CREATE TABLE IF NOT EXISTS equipment (
  account_id INTEGER NOT NULL,
  equipment_modification_guid TEXT NOT NULL,
  data TEXT NOT NULL,
  PRIMARY KEY (account_id, equipment_modification_guid)
  );
