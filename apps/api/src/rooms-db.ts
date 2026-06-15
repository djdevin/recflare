/**
 * Read helpers for the shared `rec-rooms` D1 database. The schema, migrations,
 * and seed are owned by the `rooms` worker (apps/rooms/src/rooms-db.ts +
 * migrations); this worker binds the same database read-only for its
 * `/roomserver/rooms/*` endpoints. Keep these queries in sync with the rooms
 * worker's.
 */

/** A stored room — the parsed JSON blob (full client-facing room response). */
export type Room = Record<string, unknown>

interface RoomRow {
	data: string
}

const parseOne = (row: RoomRow | null): Room | null => (row ? (JSON.parse(row.data) as Room) : null)
const parseAll = (rows: RoomRow[]): Room[] => rows.map((r) => JSON.parse(r.data) as Room)

export async function getRoomById(db: D1Database, roomId: number): Promise<Room | null> {
	return parseOne(
		await db.prepare('SELECT data FROM rooms WHERE room_id = ?1').bind(roomId).first<RoomRow>()
	)
}

export async function getRoomByName(db: D1Database, name: string): Promise<Room | null> {
	return parseOne(
		await db
			.prepare('SELECT data FROM rooms WHERE name_lower = ?1')
			.bind(name.toLowerCase())
			.first<RoomRow>()
	)
}

export async function getRoomsByIds(db: D1Database, ids: number[]): Promise<Room[]> {
	if (ids.length === 0) return []
	const placeholders = ids.map((_, i) => `?${i + 1}`).join(',')
	const { results } = await db
		.prepare(`SELECT data FROM rooms WHERE room_id IN (${placeholders})`)
		.bind(...ids)
		.all<RoomRow>()
	return parseAll(results)
}

export async function getRoomsByCreator(db: D1Database, accountId: number): Promise<Room[]> {
	const { results } = await db
		.prepare('SELECT data FROM rooms WHERE creator_account_id = ?1')
		.bind(accountId)
		.all<RoomRow>()
	return parseAll(results)
}
