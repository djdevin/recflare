/**
 * Owned equipment on the shared `recflare` D1 database — the equipment skins a player
 * has bought from a storefront (e.g. a "Bow Skin (Dryad Summer)"). One row per
 * (account, item): like avatar items, owning a piece of equipment is boolean, so the
 * skin is granted at purchase time (`POST /api/storefronts/v2/buyItem`, when the
 * gift-drop carries an `EquipmentModificationGuid`) and read back by
 * `GET /api/equipment/v2/getUnlocked`.
 *
 * The item is keyed by its `EquipmentModificationGuid` — the gift-drop's equipment guid
 * — so re-buying the same skin upserts rather than piling up duplicate rows (these
 * drops are flagged `Unique`). `data` is the rendered unlocked-equipment DTO, stored
 * opaquely and served back untouched.
 *
 * This worker (`econ`) owns the table and its migration — see apps/econ/migrations/
 * 0006_equipment.sql. The gift box the purchase also creates lives in a separate table
 * (@repo/domain's received_gift); ownership does not depend on the box being opened.
 */

/** Schema DDL (mirror of migrations 0006_equipment.sql) — also builds the table in tests. */
export const EQUIPMENT_SCHEMA_DDL: string[] = [
	`CREATE TABLE IF NOT EXISTS equipment (
		account_id INTEGER NOT NULL,
		equipment_modification_guid TEXT NOT NULL,
		data TEXT NOT NULL,
		PRIMARY KEY (account_id, equipment_modification_guid)
	)`,
]

/**
 * A rendered piece of unlocked equipment, as `/api/equipment/v2/getUnlocked` serves it.
 * `EquipmentModificationGuid` is the item's guid string and the row's key;
 * `EquipmentPrefabName` names the base equipment the modification applies to.
 */
export interface Equipment extends Record<string, unknown> {
	EquipmentModificationGuid: string
	EquipmentPrefabName: string
	FriendlyName: string
	Tooltip: string
	Rarity: number
}

/**
 * Grant a piece of equipment into a player's inventory. Upserts on
 * (account_id, equipment_modification_guid): owning equipment is boolean, so re-buying
 * it refreshes the stored DTO rather than adding a second copy.
 */
export async function grantEquipment(
	db: D1Database,
	accountId: number,
	equipment: Equipment
): Promise<void> {
	await db
		.prepare(
			`INSERT INTO equipment (account_id, equipment_modification_guid, data) VALUES (?1, ?2, ?3)
			 ON CONFLICT (account_id, equipment_modification_guid) DO UPDATE SET data = ?3`
		)
		.bind(accountId, equipment.EquipmentModificationGuid, JSON.stringify(equipment))
		.run()
}

/** Every piece of equipment a player owns, ordered by guid for a stable listing. */
export async function getEquipment(db: D1Database, accountId: number): Promise<Equipment[]> {
	const { results } = await db
		.prepare(
			'SELECT data FROM equipment WHERE account_id = ?1 ORDER BY equipment_modification_guid'
		)
		.bind(accountId)
		.all<{ data: string }>()
	return results.map((r) => JSON.parse(r.data) as Equipment)
}
