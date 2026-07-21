/**
 * Cross-worker *reads* of the image-metadata table. The `img` worker owns the schema
 * and the `api` worker handles uploads and writes (see apps/api/src/images-db.ts);
 * this is the read-only view other workers need when they store an image *name* but
 * have to serve the client the whole image record — the client deserializes those
 * into its `SavedImage` type, not into strings.
 *
 * Right now that's `clubs`, for a club's gallery images.
 */

/** A stored image record (the client-facing SavedImage shape). */
export interface SavedImage {
	Id: number
	Type: number
	Accessibility: number
	AccessibilityLocked: boolean
	ImageName: string
	Description: string | null
	PlayerId: number
	TaggedPlayerIds: number[]
	RoomId: number | null
	PlayerEventId: number | null
	CreatedAt: string
	CheerCount: number
	CommentCount: number
}

/** Build the `?1,?2,…` placeholder list for an `IN (…)` clause. */
const placeholders = (n: number): string =>
	Array.from({ length: n }, (_, i) => `?${i + 1}`).join(',')

/**
 * Look up image records by id, returned keyed by Id. Ids with no record (the image
 * was deleted since) are simply absent from the map.
 */
export async function getSavedImagesByIds(
	db: D1Database,
	ids: number[]
): Promise<Map<number, SavedImage>> {
	if (ids.length === 0) return new Map()
	const { results } = await db
		.prepare(`SELECT data FROM image WHERE id IN (${placeholders(ids.length)})`)
		.bind(...ids)
		.all<{ data: string }>()
	return new Map(
		results.map((r) => {
			const image = JSON.parse(r.data) as SavedImage
			return [image.Id, image]
		})
	)
}

/**
 * Look up a single image record by name (the R2 key), or null. Only for turning a
 * name a client sent into the image's id — store the id, never the name.
 */
export async function getSavedImageByName(
	db: D1Database,
	name: string
): Promise<SavedImage | null> {
	const row = await db
		.prepare('SELECT data FROM image WHERE image_name = ?1')
		.bind(name)
		.first<{ data: string }>()
	return row ? (JSON.parse(row.data) as SavedImage) : null
}
