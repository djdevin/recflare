/**
 * Read helpers for the shared `recflare` D1 database. The schema, migrations,
 * and seed are owned by the `rooms` worker (apps/rooms/src/rooms-db.ts +
 * migrations); this worker binds the same database read-only to resolve a room's
 * real scene/subroom when building a matchmake instance. Keep these queries in
 * sync with the rooms worker's.
 */

import { Accessibility, Role } from '@repo/domain'

/** A stored room — the parsed JSON blob (full client-facing room response). */
export type Room = Record<string, unknown>

interface RoomRow {
	data: string
}

const parseOne = (row: RoomRow | null): Room | null => (row ? (JSON.parse(row.data) as Room) : null)

export async function getRoomById(db: D1Database, roomId: number): Promise<Room | null> {
	return parseOne(
		await db.prepare('SELECT data FROM room WHERE room_id = ?1').bind(roomId).first<RoomRow>()
	)
}

export async function getRoomByName(db: D1Database, name: string): Promise<Room | null> {
	return parseOne(
		await db
			.prepare('SELECT data FROM room WHERE name_lower = ?1')
			.bind(name.toLowerCase())
			.first<RoomRow>()
	)
}

/** The seeded template dorm (RoomId 1) that personal dorms are cloned from. */
const DORM_TEMPLATE_ROOM_ID = 1

/** A player's username from the shared accounts table (for naming their dorm), or null. */
export async function getUsername(db: D1Database, accountId: number): Promise<string | null> {
	const row = await db
		.prepare('SELECT data FROM accounts WHERE account_id = ?1')
		.bind(accountId)
		.first<{ data: string }>()
	if (!row) return null
	const account = JSON.parse(row.data) as { username?: string }
	return typeof account.username === 'string' ? account.username : null
}

/** A player's personal dorm room (owned by them, IsDorm), or null if none yet. */
export async function getDormRoom(db: D1Database, accountId: number): Promise<Room | null> {
	return parseOne(
		await db
			.prepare('SELECT data FROM room WHERE creator_account_id = ?1 AND is_dorm = 1 LIMIT 1')
			.bind(accountId)
			.first<RoomRow>()
	)
}

/**
 * The player's personal dorm room, created on first access. Cloned from the
 * seeded template dorm (RoomId 1) but owned by the player and flagged IsDorm — so
 * matchmaking routes them into their own dorm and they can save it via the
 * owner-gated room-save. Idempotent: returns the existing dorm once created.
 *
 * NOTE: this is the one place the match worker writes to the rooms table (the
 * `rooms` worker otherwise owns the schema).
 */
export async function getOrCreateDormRoom(db: D1Database, accountId: number): Promise<Room> {
	const existing = await getDormRoom(db, accountId)
	if (existing) return existing

	const template = await getRoomById(db, DORM_TEMPLATE_ROOM_ID)
	const idRow = await db
		.prepare('SELECT COALESCE(MAX(room_id), 1) + 1 AS next FROM room')
		.first<{ next: number }>()
	const roomId = idRow?.next ?? 2

	// Reuse the template's subroom (scene/capacity), owned by the player, starting
	// from a clean save. Fall back to the base dorm scene if the template is absent.
	const templateSub =
		template && Array.isArray(template.SubRooms) && template.SubRooms.length > 0
			? (template.SubRooms[0] as Record<string, unknown>)
			: { SubRoomId: 1, UnitySceneId: '76d98498-60a1-430c-ab76-b54a29b7a163', MaxPlayers: 4 }

	// Named after the owner: `@<username>'s Dorm` (falls back to the account id).
	const username = (await getUsername(db, accountId)) ?? `Player${accountId}`

	const room: Room = {
		...(template ?? { Accessibility: Accessibility.Unlisted }),
		RoomId: roomId,
		Name: `@${username}'s Dorm`,
		CreatorAccountId: accountId,
		IsDorm: true,
		Roles: [{ AccountId: accountId, Role: Role.Owner, LastChangedByAccountId: null, InvitedRole: 0 }],
		SubRooms: [{ ...templateSub, CreatorAccountId: accountId }],
		CreatedAt: new Date().toISOString(),
	}
	await db.prepare('INSERT INTO room (data) VALUES (?1)').bind(JSON.stringify(room)).run()
	return room
}
