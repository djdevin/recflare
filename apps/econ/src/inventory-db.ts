/**
 * Owned avatar items on the shared `recflare` D1 database — the items a player has
 * bought from a storefront. One row per (account, item): the item is granted at
 * purchase time (`POST /api/storefronts/v2/buyItem`) and read back by
 * `GET /api/avatar/v4/items`, which concatenates it with the default catalog.
 *
 * The item is keyed by its `AvatarItemDesc` (the gift-drop's item guid string), so
 * re-buying the same item upserts rather than piling up duplicate rows — you can own
 * an item once. `data` is the rendered avatar-item DTO, stored opaquely and served
 * back untouched; it matches the shape of the entries in default-avatar-items.json.
 *
 * This worker (`econ`) owns the table and its migration — see apps/econ/migrations/
 * 0004_inventory.sql. The gift box the purchase also creates lives in a separate table
 * (@repo/domain's received_gift); ownership does not depend on the box being opened.
 */

/** Schema DDL (mirror of migrations 0004_inventory.sql) — also builds the table in tests. */
export const INVENTORY_SCHEMA_DDL: string[] = [
	`CREATE TABLE IF NOT EXISTS inventory (
		account_id INTEGER NOT NULL,
		avatar_item_desc TEXT NOT NULL,
		data TEXT NOT NULL,
		PRIMARY KEY (account_id, avatar_item_desc)
	)`,
]

/**
 * A rendered avatar item, as `/api/avatar/v4/items` serves it (same shape as the
 * entries in default-avatar-items.json). `AvatarItemDesc` is the item's guid string
 * and the row's key.
 */
export interface AvatarItem extends Record<string, unknown> {
	AvatarItemType: number | null
	AvatarItemDesc: string
	PlatformMask: number
	FriendlyName: string
	Tooltip: string
	Rarity: number
}

/**
 * Grant an item into a player's inventory. Upserts on (account_id, avatar_item_desc):
 * owning an item is boolean, so re-buying it refreshes the stored DTO rather than
 * adding a second copy.
 */
export async function grantItem(
	db: D1Database,
	accountId: number,
	item: AvatarItem
): Promise<void> {
	await db
		.prepare(
			`INSERT INTO inventory (account_id, avatar_item_desc, data) VALUES (?1, ?2, ?3)
			 ON CONFLICT (account_id, avatar_item_desc) DO UPDATE SET data = ?3`
		)
		.bind(accountId, item.AvatarItemDesc, JSON.stringify(item))
		.run()
}

/** Every avatar item a player owns, ordered by item guid for a stable listing. */
export async function getInventory(db: D1Database, accountId: number): Promise<AvatarItem[]> {
	const { results } = await db
		.prepare('SELECT data FROM inventory WHERE account_id = ?1 ORDER BY avatar_item_desc')
		.bind(accountId)
		.all<{ data: string }>()
	return results.map((r) => JSON.parse(r.data) as AvatarItem)
}
