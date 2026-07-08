/**
 * Image-metadata storage on the shared `recflare` D1 database. Each image is a
 * single JSON blob in the `data` column; queryable fields (Id, ImageName,
 * PlayerId, RoomId) are SQLite generated (virtual) columns extracted from that
 * JSON — the same JSON-blob pattern the rooms/accounts tables use.
 *
 * Mirror of `apps/img/src/images-db.ts` — the `img` worker owns the schema and
 * migration; this worker (which handles uploads + reads) keeps a copy in sync.
 */

/** Schema DDL (mirror of migrations/0001_image.sql, sans any seed rows). */
export const SCHEMA_DDL: string[] = [
	`CREATE TABLE IF NOT EXISTS image (
		data TEXT NOT NULL,
		id INTEGER GENERATED ALWAYS AS (json_extract(data, '$.Id')) VIRTUAL,
		image_name TEXT GENERATED ALWAYS AS (json_extract(data, '$.ImageName')) VIRTUAL,
		player_id INTEGER GENERATED ALWAYS AS (json_extract(data, '$.PlayerId')) VIRTUAL,
		room_id INTEGER GENERATED ALWAYS AS (json_extract(data, '$.RoomId')) VIRTUAL
	)`,
	`CREATE UNIQUE INDEX IF NOT EXISTS idx_image_id ON image (id)`,
	`CREATE INDEX IF NOT EXISTS idx_image_image_name ON image (image_name)`,
	`CREATE INDEX IF NOT EXISTS idx_image_player_id ON image (player_id)`,
	`CREATE INDEX IF NOT EXISTS idx_image_room_id ON image (room_id)`,
]

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

interface ImageRow {
	data: string
}

/** Fields supplied at upload time (from `imgMeta`); everything else defaults. */
export interface NewImage {
	imageName: string
	playerId: number
	type?: number
	accessibility?: number
	roomId?: number | null
	description?: string | null
	taggedPlayerIds?: number[]
	playerEventId?: number | null
}

/** Insert a new image record for an upload, returning the stored row. */
export async function createImage(db: D1Database, input: NewImage): Promise<SavedImage> {
	// Sequential id: one past the current max (the table starts empty).
	const row = await db
		.prepare('SELECT COALESCE(MAX(id), 0) + 1 AS next FROM image')
		.first<{ next: number }>()
	const image: SavedImage = {
		Id: row?.next ?? 1,
		Type: input.type ?? 1,
		Accessibility: input.accessibility ?? 1,
		AccessibilityLocked: false,
		ImageName: input.imageName,
		Description: input.description ?? null,
		PlayerId: input.playerId,
		TaggedPlayerIds: input.taggedPlayerIds ?? [],
		RoomId: input.roomId ?? null,
		PlayerEventId: input.playerEventId ?? null,
		CreatedAt: new Date().toISOString(),
		CheerCount: 0,
		CommentCount: 0,
	}
	await db.prepare('INSERT INTO image (data) VALUES (?1)').bind(JSON.stringify(image)).run()
	return image
}

/** Look up an image record by its ImageName (the R2 key / filename), or null. */
export async function getImageByName(db: D1Database, name: string): Promise<SavedImage | null> {
	const row = await db
		.prepare('SELECT data FROM image WHERE image_name = ?1')
		.bind(name)
		.first<ImageRow>()
	return row ? (JSON.parse(row.data) as SavedImage) : null
}

/**
 * The public images taken in a room, for the room's photo feed. Only publicly
 * accessible images (Accessibility === 1) are returned. `filter` narrows by
 * `SavedImageType` (0 = all types); `sort` orders the feed — `1` puts the most
 * cheered first (ties broken by newest), anything else is newest-first. Paginated
 * via skip/take; returns a bare array of SavedImage. The per-room set is small, so
 * the room_id index does the lookup and filtering/sorting happens in memory.
 *
 * NOTE: the exact `sort`/`filter` enum values are best guesses — the client sends
 * `sort=1&filter=1`, and this treats them as most-cheered / ShareCamera.
 */
export async function getImagesByRoom(
	db: D1Database,
	roomId: number,
	sort: number,
	filter: number,
	skip: number,
	take: number
): Promise<SavedImage[]> {
	const { results } = await db
		.prepare('SELECT data FROM image WHERE room_id = ?1')
		.bind(roomId)
		.all<ImageRow>()
	let images = results
		.map((r) => JSON.parse(r.data) as SavedImage)
		.filter((img) => img.Accessibility === 1)

	if (filter > 0) images = images.filter((img) => img.Type === filter)

	images.sort(
		sort === 1 ? (a, b) => b.CheerCount - a.CheerCount || newestFirst(a, b) : newestFirst
	)

	return images.slice(skip, skip + take)
}

/** Newest-first order: most recent CreatedAt, ties broken by higher Id. */
const newestFirst = (a: SavedImage, b: SavedImage) =>
	b.CreatedAt.localeCompare(a.CreatedAt) || b.Id - a.Id

/**
 * The public images a player has taken — their photo list, newest first.
 * Paginated via skip/take; returns a bare array of SavedImage. Uses the
 * player_id index; the per-player set is small, so filtering/sorting is in memory.
 */
export async function getImagesByPlayer(
	db: D1Database,
	playerId: number,
	sort: number,
	skip: number,
	take: number
): Promise<SavedImage[]> {
	const { results } = await db
		.prepare('SELECT data FROM image WHERE player_id = ?1')
		.bind(playerId)
		.all<ImageRow>()
	return results
		.map((r) => JSON.parse(r.data) as SavedImage)
		.filter((img) => img.Accessibility === 1)
		.sort(sort === 1 ? (a, b) => b.CheerCount - a.CheerCount || newestFirst(a, b) : newestFirst)
		.slice(skip, skip + take)
}

/** Default number of recent images the slideshow feed returns. */
export const SLIDESHOW_LIMIT = 130

/** The slideshow projection of an image — creator username + room name joined in. */
export interface SlideshowImage {
	SavedImageId: number
	ImageName: string
	Username: string
	RoomName: string | null
	RoomId: number | null
	SavedImageType: number
	PlayerEventId: number | null
	Accessibility: number
	PlayerIds: number[]
}

/** Build the `?1,?2,…` placeholder list for an `IN (…)` clause. */
const placeholders = (n: number): string =>
	Array.from({ length: n }, (_, i) => `?${i + 1}`).join(',')

/** Map account ids → username, resolved from the shared accounts table. */
async function getUsernames(db: D1Database, ids: number[]): Promise<Map<number, string>> {
	if (ids.length === 0) return new Map()
	const { results } = await db
		.prepare(
			`SELECT account_id AS id, json_extract(data, '$.username') AS username
			 FROM accounts WHERE account_id IN (${placeholders(ids.length)})`
		)
		.bind(...ids)
		.all<{ id: number; username: string }>()
	return new Map(results.map((r) => [r.id, r.username]))
}

/** Map room ids → room name, resolved from the shared rooms table. */
async function getRoomNames(db: D1Database, ids: number[]): Promise<Map<number, string>> {
	if (ids.length === 0) return new Map()
	const { results } = await db
		.prepare(
			`SELECT room_id AS id, json_extract(data, '$.Name') AS name
			 FROM room WHERE room_id IN (${placeholders(ids.length)})`
		)
		.bind(...ids)
		.all<{ id: number; name: string }>()
	return new Map(results.map((r) => [r.id, r.name]))
}

/**
 * The global slideshow feed — the most recent publicly-listable images across all
 * rooms (Accessibility 0 or 1), newest first, capped at `limit`. Each row is joined
 * to its creator's username and (if any) its room's name. Returns the projected
 * SlideshowImage shape. Usernames/room names are resolved in two batched lookups to
 * avoid an N+1 across the (at most `limit`) images.
 */
export async function getSlideshowImages(
	db: D1Database,
	limit = SLIDESHOW_LIMIT
): Promise<SlideshowImage[]> {
	const { results } = await db
		.prepare(
			`SELECT data FROM image
			 WHERE json_extract(data, '$.Accessibility') IN (0, 1)
			 ORDER BY id DESC LIMIT ?1`
		)
		.bind(limit)
		.all<ImageRow>()
	const images = results.map((r) => JSON.parse(r.data) as SavedImage)

	const roomIds = [...new Set(images.map((i) => i.RoomId).filter((v): v is number => v != null))]
	const usernames = await getUsernames(db, [...new Set(images.map((i) => i.PlayerId))])
	const roomNames = await getRoomNames(db, roomIds)

	return images.map((img) => ({
		SavedImageId: img.Id,
		ImageName: img.ImageName,
		// Fall back to the synthesized "Player<id>" name for accounts not in the table.
		Username: usernames.get(img.PlayerId) ?? `Player${img.PlayerId}`,
		RoomName: img.RoomId != null ? (roomNames.get(img.RoomId) ?? null) : null,
		RoomId: img.RoomId,
		SavedImageType: img.Type,
		PlayerEventId: img.PlayerEventId,
		Accessibility: img.Accessibility,
		PlayerIds: img.TaggedPlayerIds,
	}))
}

/**
 * A player's photo feed — the public images they took plus the ones they're
 * tagged in (TaggedPlayerIds). Newest first, paginated via skip/take; returns a
 * bare array of SavedImage. The tagged-in match uses json_each over the stored
 * TaggedPlayerIds array (there's no index for it).
 */
export async function getPlayerFeed(
	db: D1Database,
	playerId: number,
	skip: number,
	take: number
): Promise<SavedImage[]> {
	const { results } = await db
		.prepare(
			`SELECT data FROM image
			 WHERE player_id = ?1
			    OR EXISTS (SELECT 1 FROM json_each(image.data, '$.TaggedPlayerIds') WHERE value = ?1)`
		)
		.bind(playerId)
		.all<ImageRow>()
	return results
		.map((r) => JSON.parse(r.data) as SavedImage)
		.filter((img) => img.Accessibility === 1)
		.sort(newestFirst)
		.slice(skip, skip + take)
}
