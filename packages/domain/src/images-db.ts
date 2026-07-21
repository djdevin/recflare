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
 * Look up image records by name (the R2 key), returned keyed by ImageName. One query
 * for the whole set; names with no record are simply absent from the map.
 */
export async function getSavedImagesByNames(
	db: D1Database,
	names: string[]
): Promise<Map<string, SavedImage>> {
	if (names.length === 0) return new Map()
	const { results } = await db
		.prepare(`SELECT data FROM image WHERE image_name IN (${placeholders(names.length)})`)
		.bind(...names)
		.all<{ data: string }>()
	return new Map(
		results.map((r) => {
			const image = JSON.parse(r.data) as SavedImage
			return [image.ImageName, image]
		})
	)
}

/**
 * A minimal SavedImage for an image name with no metadata row — enough for the client
 * to render the picture. Uploads normally write a row first, so this only covers a
 * name that was set directly (or whose row was since deleted).
 */
export function placeholderSavedImage(imageName: string): SavedImage {
	return {
		Id: 0,
		Type: 1,
		Accessibility: 1,
		AccessibilityLocked: false,
		ImageName: imageName,
		Description: null,
		PlayerId: 0,
		TaggedPlayerIds: [],
		RoomId: null,
		PlayerEventId: null,
		CreatedAt: new Date(0).toISOString(),
		CheerCount: 0,
		CommentCount: 0,
	}
}
