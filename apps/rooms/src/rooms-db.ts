/**
 * Room storage on D1. Each room is a single JSON blob in the `data` column;
 * queryable fields (RoomId, Name, CreatorAccountId, IsDorm) are SQLite
 * generated (virtual) columns extracted from that JSON and indexed. This keeps
 * the room shape flexible while still allowing fast lookups by id/name/creator.
 *
 * `SCHEMA_DDL` mirrors `migrations/0001_init.sql`; the room data is seeded from
 * `static/ImportRooms.json` by `migrations/0002_import_rooms.sql`. Tests apply
 * `SCHEMA_DDL` then seed the imported rooms directly.
 */

/** Schema DDL (mirror of migrations/0001_init.sql, sans the seed INSERT). */
export const SCHEMA_DDL: string[] = [
	`CREATE TABLE IF NOT EXISTS rooms (
		data TEXT NOT NULL,
		room_id INTEGER GENERATED ALWAYS AS (json_extract(data, '$.RoomId')) VIRTUAL,
		name TEXT GENERATED ALWAYS AS (json_extract(data, '$.Name')) VIRTUAL,
		name_lower TEXT GENERATED ALWAYS AS (lower(json_extract(data, '$.Name'))) VIRTUAL,
		creator_account_id INTEGER GENERATED ALWAYS AS (json_extract(data, '$.CreatorAccountId')) VIRTUAL,
		is_dorm INTEGER GENERATED ALWAYS AS (json_extract(data, '$.IsDorm')) VIRTUAL
	)`,
	`CREATE UNIQUE INDEX IF NOT EXISTS idx_rooms_room_id ON rooms (room_id)`,
	`CREATE INDEX IF NOT EXISTS idx_rooms_name_lower ON rooms (name_lower)`,
	`CREATE INDEX IF NOT EXISTS idx_rooms_creator ON rooms (creator_account_id)`,
]

/** A stored room — the parsed JSON blob (full client-facing room response). */
export type Room = Record<string, unknown>

interface RoomRow {
	data: string
}

const parseOne = (row: RoomRow | null): Room | null => (row ? (JSON.parse(row.data) as Room) : null)
const parseAll = (rows: RoomRow[]): Room[] => rows.map((r) => JSON.parse(r.data) as Room)

/** Look up a single room by its RoomId. */
export async function getRoomById(db: D1Database, roomId: number): Promise<Room | null> {
	return parseOne(
		await db.prepare('SELECT data FROM rooms WHERE room_id = ?1').bind(roomId).first<RoomRow>()
	)
}

/** Look up a single room by name (case-insensitive exact match). */
export async function getRoomByName(db: D1Database, name: string): Promise<Room | null> {
	return parseOne(
		await db
			.prepare('SELECT data FROM rooms WHERE name_lower = ?1')
			.bind(name.toLowerCase())
			.first<RoomRow>()
	)
}

/** Look up multiple rooms by RoomId. */
export async function getRoomsByIds(db: D1Database, ids: number[]): Promise<Room[]> {
	if (ids.length === 0) return []
	const placeholders = ids.map((_, i) => `?${i + 1}`).join(',')
	const { results } = await db
		.prepare(`SELECT data FROM rooms WHERE room_id IN (${placeholders})`)
		.bind(...ids)
		.all<RoomRow>()
	return parseAll(results)
}

/** All rooms created by an account (e.g. their dorm). */
export async function getRoomsByCreator(db: D1Database, accountId: number): Promise<Room[]> {
	const { results } = await db
		.prepare('SELECT data FROM rooms WHERE creator_account_id = ?1')
		.bind(accountId)
		.all<RoomRow>()
	return parseAll(results)
}
