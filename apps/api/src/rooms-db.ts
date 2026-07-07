/**
 * Read helpers for the shared `recflare` D1 database. The schema, migrations,
 * and seed are owned by the `rooms` worker (apps/rooms/src/rooms-db.ts +
 * migrations); this worker binds the same database read-only to resolve room
 * roles for the `/api/rooms/v1/verifyRole` endpoint. Keep these queries in sync
 * with the rooms worker's.
 */

/** A stored room — the parsed JSON blob (full client-facing room response). */
export type Room = Record<string, unknown>

interface RoomRow {
	data: string
}

const parseOne = (row: RoomRow | null): Room | null => (row ? (JSON.parse(row.data) as Room) : null)

export async function getRoomById(db: D1Database, roomId: number): Promise<Room | null> {
	return parseOne(
		await db.prepare('SELECT data FROM rooms WHERE room_id = ?1').bind(roomId).first<RoomRow>()
	)
}
