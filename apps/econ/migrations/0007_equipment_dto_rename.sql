-- Rewrite the stored unlocked-equipment DTOs onto the shape the client actually reads.
-- Rows written before this used `EquipmentModificationGuid`/`EquipmentPrefabName` (the
-- gift-drop's prefixed names, carried straight over at grant time) and had no
-- `Favorited`/`PlatformMask`. The live endpoint serves the unprefixed
-- `ModificationGuid`/`PrefabName` plus both of those, and the entries the client PUTs
-- back to `/api/equipment/v1/update` use the unprefixed names too — so an un-rewritten
-- row renders with a blank prefab and can never be favourited (the update matches on a
-- guid the row's `data` no longer spells the same way).
--
-- The `data` column is the DTO verbatim, so the fix is a JSON rewrite in place; the row
-- key (`equipment_modification_guid`) is unchanged. Guarded on the old key being
-- present, which also makes it a no-op on re-run.

UPDATE equipment
SET data = json_object(
    'ModificationGuid', json_extract(data, '$.EquipmentModificationGuid'),
    'PrefabName', json_extract(data, '$.EquipmentPrefabName'),
    'FriendlyName', json_extract(data, '$.FriendlyName'),
    'Tooltip', json_extract(data, '$.Tooltip'),
    'Rarity', json_extract(data, '$.Rarity'),
    'PlatformMask', -1,
    'Favorited', json('false')
  )
WHERE json_extract(data, '$.EquipmentModificationGuid') IS NOT NULL;
