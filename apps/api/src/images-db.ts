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
