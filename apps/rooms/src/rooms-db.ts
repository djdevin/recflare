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

/** A room role assignment (the client's RoomRole shape). */
interface RoomRole {
	AccountId: number
	Role: number
	LastChangedByAccountId: number | null
	InvitedRole: number
}

/** Owner role value (max byte) — the room creator's tier. */
const ROLE_OWNER = 255

/**
 * Clone an existing room into a new one owned by `accountId`. Copies the source
 * room's content (scene/subrooms/settings), assigning a fresh RoomId, the given
 * name, and the new owner; the `base` template tag is dropped so user clones
 * aren't themselves listed as base rooms. Returns the new room, or null when the
 * source isn't in D1 or disallows cloning.
 */
export async function cloneRoom(
	db: D1Database,
	sourceRoomId: number,
	name: string,
	accountId: number
): Promise<Room | null> {
	const source = await getRoomById(db, sourceRoomId)
	if (!source || source.CloningAllowed === false) return null

	const row = await db
		.prepare('SELECT MAX(room_id) AS maxId FROM rooms')
		.first<{ maxId: number | null }>()
	const newRoomId = (row?.maxId ?? 0) + 1

	const tags = Array.isArray(source.Tags)
		? (source.Tags as Array<Record<string, unknown>>).filter(
				(t) => String(t?.Tag).toLowerCase() !== 'base'
			)
		: source.Tags

	// Ownership is reset to the cloner — the source room's Roles (its creator and
	// any co-owners, e.g. the seeded base-room roles for accounts 1/2) must NOT
	// carry over, or the clone would still list the template's owner as owner.
	const roles: RoomRole[] = [
		{ AccountId: accountId, Role: ROLE_OWNER, LastChangedByAccountId: null, InvitedRole: 0 },
	]

	const cloned: Room = {
		...source,
		RoomId: newRoomId,
		Name: name,
		CreatorAccountId: accountId,
		IsDorm: false,
		Tags: tags,
		Roles: roles,
		CreatedAt: new Date().toISOString(),
	}

	await db.prepare('INSERT INTO rooms (data) VALUES (?1)').bind(JSON.stringify(cloned)).run()
	return cloned
}

/** Set a room's Description in place (the caller is responsible for the owner check). */
export async function setRoomDescription(
	db: D1Database,
	roomId: number,
	description: string
): Promise<void> {
	await db
		.prepare("UPDATE rooms SET data = json_set(data, '$.Description', ?2) WHERE room_id = ?1")
		.bind(roomId, description)
		.run()
}

/** Set a room's Name in place (the caller checks ownership + name uniqueness first). */
export async function setRoomName(db: D1Database, roomId: number, name: string): Promise<void> {
	await db
		.prepare("UPDATE rooms SET data = json_set(data, '$.Name', ?2) WHERE room_id = ?1")
		.bind(roomId, name)
		.run()
}

/** Set a room's ImageName in place (the caller is responsible for the owner check). */
export async function setRoomImage(db: D1Database, roomId: number, imageName: string): Promise<void> {
	await db
		.prepare("UPDATE rooms SET data = json_set(data, '$.ImageName', ?2) WHERE room_id = ?1")
		.bind(roomId, imageName)
		.run()
}

/** Find a subroom (by SubRoomId) inside a room's `SubRooms` array, or undefined. */
export function findSubRoom(room: Room, subRoomId: number): Record<string, unknown> | undefined {
	const subRooms = Array.isArray(room.SubRooms)
		? (room.SubRooms as Array<Record<string, unknown>>)
		: []
	return subRooms.find((s) => s.SubRoomId === subRoomId)
}

/** Fields from the client's room-save POST body. */
export interface SaveSubRoomDataInput {
	/** Uploaded blob key for this subroom's scene data (becomes the subroom's DataBlob). */
	subRoomDataFilename?: string
	/** Uploaded blob key for the room-level data. */
	roomDataFilename?: string
	description?: string
	persistenceVersion?: number
	inventionUsage?: string
}

/**
 * Persist a room-save against a specific subroom: point the subroom at its newly
 * uploaded data blob (what the loader later downloads) and record the room-level
 * fields from the save. Returns the updated room, or null when the room or
 * subroom doesn't exist. The whole room JSON is rewritten (subrooms live in it).
 */
export async function saveSubRoomData(
	db: D1Database,
	roomId: number,
	subRoomId: number,
	accountId: number,
	input: SaveSubRoomDataInput
): Promise<Room | null> {
	const room = await getRoomById(db, roomId)
	if (!room) return null
	const sub = findSubRoom(room, subRoomId)
	if (!sub) return null

	// Populate the subroom's creator on first save — it starts null, and the
	// client NREs on a null CreatorAccountId. Only the owner reaches this path.
	if (sub.CreatorAccountId == null) sub.CreatorAccountId = accountId

	// Point the subroom at the newly-uploaded data blobs and stamp the save.
	if (input.subRoomDataFilename) sub.DataBlob = input.subRoomDataFilename
	if (input.roomDataFilename) sub.RoomDataBlob = input.roomDataFilename
	sub.DataSavedAt = new Date().toISOString()
	if (input.persistenceVersion !== undefined) sub.PersistenceVersion = input.persistenceVersion

	// Room-level fields carried by the save.
	if (typeof input.description === 'string') room.Description = input.description
	if (input.persistenceVersion !== undefined) room.PersistenceVersion = input.persistenceVersion
	if (input.inventionUsage !== undefined) room.InventionUsage = input.inventionUsage

	await db
		.prepare('UPDATE rooms SET data = ?2 WHERE room_id = ?1')
		.bind(roomId, JSON.stringify(room))
		.run()
	return room
}

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

/**
 * An account's public, non-dorm rooms — the publicly viewable "rooms owned by
 * <player>" list (excludes private rooms, dorms, and list-excluded rooms).
 */
export async function getPublicRoomsByCreator(db: D1Database, accountId: number): Promise<Room[]> {
	return (await getRoomsByCreator(db, accountId)).filter(
		(r) => r.IsDorm !== true && r.Accessibility === 1 && r.ExcludeFromLists !== true
	)
}

/**
 * Rooms the player has favorited (interaction.favorited = 1), most recently
 * interacted first. Joins the `interaction` table to `rooms`, so a favorited room
 * no longer in D1 is simply absent. Paginated via skip/take; returns a bare array
 * of rooms (the client's room-source loaders expect a plain list).
 */
export async function getFavoritedRooms(
	db: D1Database,
	playerId: number,
	skip: number,
	take: number
): Promise<Room[]> {
	const { results } = await db
		.prepare(
			`SELECT r.data AS data
			 FROM interaction i
			 JOIN rooms r ON r.room_id = i.room_id
			 WHERE i.player_id = ?1 AND i.favorited = 1
			 ORDER BY i.last_visited_at DESC`
		)
		.bind(playerId)
		.all<RoomRow>()
	return parseAll(results).slice(skip, skip + take)
}

/**
 * Rooms the player has visited (an interaction row with a `last_visited_at`),
 * most recent first. Like favorites, it joins `interaction` to `rooms`, so a
 * visited room no longer in D1 is simply absent. Paginated via skip/take; returns
 * a bare array of rooms (the client's room-source loaders expect a plain list).
 */
export async function getVisitedRooms(
	db: D1Database,
	playerId: number,
	skip: number,
	take: number
): Promise<Room[]> {
	const { results } = await db
		.prepare(
			`SELECT r.data AS data
			 FROM interaction i
			 JOIN rooms r ON r.room_id = i.room_id
			 WHERE i.player_id = ?1 AND i.last_visited_at IS NOT NULL
			 ORDER BY i.last_visited_at DESC`
		)
		.bind(playerId)
		.all<RoomRow>()
	return parseAll(results).slice(skip, skip + take)
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
 * Explicitly clear a single interaction flag on a room (the DELETE counterpart to
 * the cheer/favorite toggles). Idempotent: only clears an existing interaction row
 * and never creates one, so clearing a flag on a room the player never interacted
 * with doesn't add a spurious visited/favorited entry. Returns the interaction.
 */
async function clearInteraction(
	db: D1Database,
	playerId: number,
	roomId: number,
	column: 'cheered' | 'favorited'
): Promise<Interaction> {
	await db
		.prepare(`UPDATE interaction SET ${column} = 0 WHERE player_id = ?1 AND room_id = ?2`)
		.bind(playerId, roomId)
		.run()
	return getInteraction(db, playerId, roomId)
}

/** Clear the player's cheer on a room (DELETE cheer), returning the interaction. */
export async function removeCheer(
	db: D1Database,
	playerId: number,
	roomId: number
): Promise<Interaction> {
	return clearInteraction(db, playerId, roomId, 'cheered')
}

/** Clear the player's favorite on a room (DELETE favorite), returning the interaction. */
export async function removeFavorite(
	db: D1Database,
	playerId: number,
	roomId: number
): Promise<Interaction> {
	return clearInteraction(db, playerId, roomId, 'favorited')
}

/**
 * Search-tag aliases: a queried `#tag` also matches these stored tag names.
 * The client's pinned filters don't always match how rooms are tagged (e.g. it
 * searches `recroomoriginal`, but rooms are tagged `rro`).
 */
const TAG_ALIASES: Record<string, string[]> = {
	recroomoriginal: ['rro'],
}

/** A room's tag names, lowercased (empty when it has no Tags array). */
function roomTags(room: Room): string[] {
	const tags = room.Tags
	if (!Array.isArray(tags)) return []
	return tags
		.map((t) => (t as Record<string, unknown> | null)?.Tag)
		.filter((v): v is string => typeof v === 'string')
		.map((v) => v.toLowerCase())
}

/** True if the room carries any of the given (lowercased) tags. */
function roomHasAnyTag(room: Room, tags: Set<string>): boolean {
	return roomTags(room).some((t) => tags.has(t))
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

/** Engagement score used to order the hot feed (cheers weigh most, then favorites). */
function hotScore(room: Room): number {
	const stats = room.Stats as Record<string, unknown> | null | undefined
	const n = (v: unknown): number => (typeof v === 'number' ? v : 0)
	return n(stats?.CheerCount) * 3 + n(stats?.FavoriteCount) * 2 + n(stats?.VisitorCount)
}

/**
 * The "hot" rooms feed: public, non-dorm rooms not excluded from lists, ordered
 * by engagement and optionally filtered to a single `tag` (with the same aliases
 * as search). Paginated via skip/take; returns `{ Results, TotalResults }` like
 * search. Ties (and the all-zero seed data) fall back to RoomId order so paging
 * is stable. The dataset is small, so this filters/sorts in memory rather than
 * in SQL.
 */
export async function getHotRooms(
	db: D1Database,
	tag: string,
	skip: number,
	take: number
): Promise<{ Results: Room[]; TotalResults: number }> {
	const { results } = await db.prepare('SELECT data FROM rooms').all<RoomRow>()
	let rooms = parseAll(results).filter(
		(r) => r.IsDorm !== true && r.Accessibility === 1 && r.ExcludeFromLists !== true
	)

	const t = tag.trim().toLowerCase()
	if (t !== '') {
		const accepted = new Set([t, ...(TAG_ALIASES[t] ?? [])])
		rooms = rooms.filter((r) => roomHasAnyTag(r, accepted))
	}

	const roomId = (r: Room): number => (typeof r.RoomId === 'number' ? r.RoomId : 0)
	rooms.sort((a, b) => hotScore(b) - hotScore(a) || roomId(a) - roomId(b))
	return { Results: rooms.slice(skip, skip + take), TotalResults: rooms.length }
}

/**
 * Recommended rooms feed: public, non-dorm rooms not excluded from lists, ranked
 * by engagement (same score as the hot feed). Unlike the hot feed this returns a
 * bare array — the client's recommendation room-source loader expects a plain
 * list, like the other `*by/me`/base sources. The `splitTest*` A/B params the
 * client passes don't change the result. Paginated via skip/take; the dataset is
 * small, so this filters/sorts in memory rather than in SQL.
 */
export async function getRecommendedRooms(
	db: D1Database,
	skip: number,
	take: number
): Promise<Room[]> {
	const { results } = await db.prepare('SELECT data FROM rooms').all<RoomRow>()
	const roomId = (r: Room): number => (typeof r.RoomId === 'number' ? r.RoomId : 0)
	return parseAll(results)
		.filter((r) => r.IsDorm !== true && r.Accessibility === 1 && r.ExcludeFromLists !== true)
		.sort((a, b) => hotScore(b) - hotScore(a) || roomId(a) - roomId(b))
		.slice(skip, skip + take)
}

/**
 * Rooms similar to a target room: public, non-dorm rooms (excluding the target)
 * that share at least one tag with it, ranked by shared-tag count then
 * engagement. Returns a paginated `{ Results, TotalResults }` (the client's
 * RoomSimilarity source expects an object, not a bare array); empty if the target
 * isn't in D1 or is untagged. Small dataset, so done in memory.
 */
export async function getSimilarRooms(
	db: D1Database,
	roomId: number,
	skip: number,
	take: number
): Promise<{ Results: Room[]; TotalResults: number }> {
	const empty = { Results: [] as Room[], TotalResults: 0 }
	const target = await getRoomById(db, roomId)
	if (!target) return empty
	const targetTags = new Set(roomTags(target))
	if (targetTags.size === 0) return empty

	const { results } = await db.prepare('SELECT data FROM rooms').all<RoomRow>()
	const sharedCount = (r: Room): number => roomTags(r).filter((t) => targetTags.has(t)).length
	const roomIdOf = (r: Room): number => (typeof r.RoomId === 'number' ? r.RoomId : 0)

	const scored = parseAll(results)
		.filter(
			(r) =>
				roomIdOf(r) !== roomId &&
				r.IsDorm !== true &&
				r.Accessibility === 1 &&
				r.ExcludeFromLists !== true
		)
		.map((room) => ({ room, shared: sharedCount(room) }))
		.filter((x) => x.shared > 0)

	scored.sort(
		(a, b) =>
			b.shared - a.shared ||
			hotScore(b.room) - hotScore(a.room) ||
			roomIdOf(a.room) - roomIdOf(b.room)
	)
	const rooms = scored.map((x) => x.room)
	return { Results: rooms.slice(skip, skip + take), TotalResults: rooms.length }
}

/**
 * "Base" rooms — the template rooms tagged `base` that the client offers as
 * starting points when creating a room. Unlike the public feeds these are
 * returned regardless of accessibility (most base rooms aren't publicly listed).
 * Ordered by RoomId for stable paging. Paginated via skip/take; returns a bare
 * array. Small dataset, so done in memory.
 */
export async function getBaseRooms(db: D1Database, skip: number, take: number): Promise<Room[]> {
	const { results } = await db.prepare('SELECT data FROM rooms').all<RoomRow>()
	const base = new Set(['base'])
	const roomIdOf = (r: Room): number => (typeof r.RoomId === 'number' ? r.RoomId : 0)
	return parseAll(results)
		.filter((r) => roomHasAnyTag(r, base))
		.sort((a, b) => roomIdOf(a) - roomIdOf(b))
		.slice(skip, skip + take)
}
