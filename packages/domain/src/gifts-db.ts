/**
 * Received gifts — the "gift boxes" a player is handed on the shared `recflare` D1.
 * A box is created when a player buys a storefront item (for themselves or as a
 * gift) and lingers until the client opens it. Opening is purely cosmetic: the item
 * itself is granted into the player's inventory at purchase time (see the `econ`
 * worker's inventory-db.ts), so consuming a box just deletes the row — there is
 * nothing left to grant.
 *
 * The `econ` worker owns the schema/migration (apps/econ/migrations/
 * 0003_received_gift.sql) and is the only writer: `POST /api/storefronts/v2/buyItem`
 * inserts a box and `GET /api/avatar/v2/gifts` lists a player's pending boxes. The
 * `api` worker only deletes, from `POST /api/avatar/v2/gifts/consume`. Both import
 * these helpers so the table name and row shape live in one place.
 *
 * One row per gift box. `data` is the box's rendered content as an opaque JSON blob
 * (the currency/avatar-item fields the client draws); `id` and `created_at` are
 * columns so a box can be listed and deleted by id without parsing the blob.
 */

/** Schema DDL (mirror of apps/econ/migrations/0003_received_gift.sql). */
export const RECEIVED_GIFT_SCHEMA_DDL: string[] = [
	`CREATE TABLE IF NOT EXISTS received_gift (
		id INTEGER PRIMARY KEY AUTOINCREMENT,
		account_id INTEGER NOT NULL,
		data TEXT NOT NULL,
		created_at TEXT NOT NULL
	)`,
	`CREATE INDEX IF NOT EXISTS idx_received_gift_account ON received_gift (account_id)`,
]

/**
 * The rendered content of a gift box, as the client draws it. Written verbatim by
 * `buyItem` from the storefront item's `GiftDrop`; never queried on. `Id` and
 * `CreatedAt` are NOT part of this — they come from the row (see {@link StoredGift}).
 */
export interface GiftContent extends Record<string, unknown> {
	ConsumableItemDesc: string
	ConsumableCount: number
	AvatarItemDesc: string
	AvatarItemType: number | null
	CurrencyType: number
	Currency: number
	Xp: number
	PackageType: number
	Message: string
	EquipmentPrefabName: string
	EquipmentModificationGuid: string
	GiftRarity: number
	Platform: number
	PlatformsToSpawnOn: number
	BalanceType: number | null
}

/** A stored gift box: its content plus the row's identity (`Id`, `CreatedAt`). */
export interface StoredGift extends GiftContent {
	Id: number
	CreatedAt: string
}

interface GiftRow {
	id: number
	data: string
	created_at: string
}

/**
 * Create a gift box for `accountId`, returning its assigned id and creation time so
 * the caller can echo the box back in the purchase response.
 */
export async function createGift(
	db: D1Database,
	accountId: number,
	content: GiftContent
): Promise<{ id: number; createdAt: string }> {
	const createdAt = new Date().toISOString()
	const row = await db
		.prepare(
			'INSERT INTO received_gift (account_id, data, created_at) VALUES (?1, ?2, ?3) RETURNING id'
		)
		.bind(accountId, JSON.stringify(content), createdAt)
		.first<{ id: number }>()
	// RETURNING always yields a row on a successful insert; the guard is for the types.
	return { id: row?.id ?? 0, createdAt }
}

/** A player's pending gift boxes, oldest first, with `Id`/`CreatedAt` merged in. */
export async function getPendingGifts(db: D1Database, accountId: number): Promise<StoredGift[]> {
	const { results } = await db
		.prepare('SELECT id, data, created_at FROM received_gift WHERE account_id = ?1 ORDER BY id')
		.bind(accountId)
		.all<GiftRow>()
	return results.map((r) => ({
		...(JSON.parse(r.data) as GiftContent),
		Id: r.id,
		CreatedAt: r.created_at,
	}))
}

/**
 * Delete (consume) a player's gift box by id. Returns false — changing nothing —
 * when the box doesn't exist or isn't theirs. The item was already granted at
 * purchase, so this only dismisses the box.
 */
export async function consumeGift(
	db: D1Database,
	accountId: number,
	giftId: number
): Promise<boolean> {
	const { meta } = await db
		.prepare('DELETE FROM received_gift WHERE id = ?1 AND account_id = ?2')
		.bind(giftId, accountId)
		.run()
	return meta.changes > 0
}
