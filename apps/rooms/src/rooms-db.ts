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
	// Per-player interaction state with a room (cheered/favorited + last visit).
	// One row per (player, room); cheer/favorite are toggled in place.
	`CREATE TABLE IF NOT EXISTS interaction (
		player_id INTEGER NOT NULL,
		room_id INTEGER NOT NULL,
		cheered INTEGER NOT NULL DEFAULT 0,
		favorited INTEGER NOT NULL DEFAULT 0,
		last_visited_at TEXT,
		PRIMARY KEY (player_id, room_id)
	)`,
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

/** A player's interaction state with a room. */
export interface Interaction {
	Cheered: boolean
	Favorited: boolean
}

interface InteractionRow {
	cheered: number
	favorited: number
}

const toInteraction = (row: InteractionRow | null): Interaction => ({
	Cheered: row?.cheered === 1,
	Favorited: row?.favorited === 1,
})

/** Read a player's interaction with a room (defaults to all-false if none). */
export async function getInteraction(
	db: D1Database,
	playerId: number,
	roomId: number
): Promise<Interaction> {
	return toInteraction(
		await db
			.prepare('SELECT cheered, favorited FROM interaction WHERE player_id = ?1 AND room_id = ?2')
			.bind(playerId, roomId)
			.first<InteractionRow>()
	)
}

/** Upsert+toggle a single boolean column, returning the resulting interaction. */
async function toggleInteraction(
	db: D1Database,
	playerId: number,
	roomId: number,
	column: 'cheered' | 'favorited'
): Promise<Interaction> {
	const now = new Date().toISOString()
	// First interaction defaults the toggled column to 1; subsequent calls flip it.
	return toInteraction(
		await db
			.prepare(
				`INSERT INTO interaction (player_id, room_id, ${column}, last_visited_at)
				 VALUES (?1, ?2, 1, ?3)
				 ON CONFLICT(player_id, room_id)
				 DO UPDATE SET ${column} = NOT ${column}, last_visited_at = ?3
				 RETURNING cheered, favorited`
			)
			.bind(playerId, roomId, now)
			.first<InteractionRow>()
	)
}

/** Toggle the player's cheer on a room, returning the resulting interaction. */
export async function toggleCheer(
	db: D1Database,
	playerId: number,
	roomId: number
): Promise<Interaction> {
	return toggleInteraction(db, playerId, roomId, 'cheered')
}

/** Toggle the player's favorite on a room, returning the resulting interaction. */
export async function toggleFavorite(
	db: D1Database,
	playerId: number,
	roomId: number
): Promise<Interaction> {
	return toggleInteraction(db, playerId, roomId, 'favorited')
}

/**
 * Search-tag aliases: a queried `#tag` also matches these stored tag names.
 * The client's pinned filters don't always match how rooms are tagged (e.g. it
 * searches `recroomoriginal`, but rooms are tagged `rro`).
 */
const TAG_ALIASES: Record<string, string[]> = {
	recroomoriginal: ['rro'],
}

/** True if the room carries any of the given (lowercased) tags. */
function roomHasAnyTag(room: Room, tags: Set<string>): boolean {
	const roomTags = room.Tags
	if (!Array.isArray(roomTags)) return false
	return roomTags.some((t) => {
		const value = (t as Record<string, unknown> | null)?.Tag
		return typeof value === 'string' && tags.has(value.toLowerCase())
	})
}

/**
 * Search public, non-dorm rooms. The query is split into terms (space/`+`):
 * `#tag` terms match the room's Tags; plain terms match the room name
 * (substring). All terms must match. Returns a paginated `{ Results, TotalResults }`.
 * The dataset is small, so this filters in memory rather than in SQL.
 */
export async function searchRooms(
	db: D1Database,
	query: string,
	skip: number,
	take: number
): Promise<{ Results: Room[]; TotalResults: number }> {
	const q = query.trim().toLowerCase()
	if (q === '') return { Results: [], TotalResults: 0 }
	const terms = q.split(/[\s+]+/).filter(Boolean)

	const { results } = await db.prepare('SELECT data FROM rooms').all<RoomRow>()
	let rooms = parseAll(results).filter((r) => r.IsDorm !== true && r.Accessibility === 1)

	for (const term of terms) {
		if (term.startsWith('#')) {
			const tag = term.slice(1)
			const accepted = new Set([tag, ...(TAG_ALIASES[tag] ?? [])])
			rooms = rooms.filter((r) => roomHasAnyTag(r, accepted))
		} else {
			rooms = rooms.filter((r) => typeof r.Name === 'string' && r.Name.toLowerCase().includes(term))
		}
	}

	return { Results: rooms.slice(skip, skip + take), TotalResults: rooms.length }
}
