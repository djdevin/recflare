/**
 * Saved outfits on the shared `recflare` D1 database — the outfit slots a player
 * saves from the avatar screen (`POST /api/avatar/v3/saved/set`) and loads back from
 * `GET /api/avatar/v3/saved`.
 *
 * One row per (account, slot). The outfit itself is stored as the opaque JSON payload
 * the client posted: we never query inside it, and its fields (OutfitSelectionsV2,
 * FaceFeatures, …) are themselves JSON-in-a-string produced by the client's own
 * serializer. Round-tripping it verbatim is both the simplest and the safest thing —
 * re-encoding risks changing a payload the client has to parse back.
 *
 * The `econ` worker owns this table and its migration (apps/econ/migrations/
 * 0002_outfit.sql).
 */

/** Schema DDL (mirror of migrations 0002_outfit.sql) — also used to build the table in tests. */
export const OUTFIT_SCHEMA_DDL: string[] = [
	`CREATE TABLE IF NOT EXISTS outfit (
		account_id INTEGER NOT NULL,
		set_id INTEGER NOT NULL,
		avatar TEXT NOT NULL,
		PRIMARY KEY (account_id, set_id)
	)`,
]

/**
 * A saved outfit, as the client posts it. `Slot` is the outfit slot it occupies (the
 * `set_id` column) — saving to a slot the player already used overwrites it, which is
 * exactly what the avatar screen's "save over this outfit" does. The rest of the
 * payload (PreviewImageName, OutfitSelections, FaceFeatures, SkinColor, HairColor,
 * CustomAvatarItems, …) is stored and served back untouched.
 */
export interface Outfit extends Record<string, unknown> {
	Slot: number
}

/** Every outfit a player has saved, ordered by slot. */
export async function getOutfits(db: D1Database, accountId: number): Promise<Outfit[]> {
	const { results } = await db
		.prepare('SELECT avatar FROM outfit WHERE account_id = ?1 ORDER BY set_id')
		.bind(accountId)
		.all<{ avatar: string }>()
	return results.map((r) => JSON.parse(r.avatar) as Outfit)
}

/**
 * Save an outfit into one of the player's slots, replacing whatever was there. The
 * upsert is keyed on (account_id, set_id), so re-saving a slot overwrites rather than
 * accumulating duplicate rows for it.
 */
export async function setOutfit(db: D1Database, accountId: number, outfit: Outfit): Promise<void> {
	await db
		.prepare(
			`INSERT INTO outfit (account_id, set_id, avatar) VALUES (?1, ?2, ?3)
			 ON CONFLICT (account_id, set_id) DO UPDATE SET avatar = ?3`
		)
		.bind(accountId, outfit.Slot, JSON.stringify(outfit))
		.run()
}
