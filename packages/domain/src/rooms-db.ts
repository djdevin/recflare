/**
 * Room storage on the shared `recflare` D1 database. Each room is a single JSON
 * blob in the `data` column; queryable fields (RoomId, Name, CreatorAccountId,
 * IsDorm) are SQLite generated (virtual) columns extracted from that JSON and
 * indexed. This keeps the room shape flexible while still allowing fast lookups
 * by id/name/creator — the same JSON-blob pattern `accounts-db` uses.
 *
 * `ROOM_SCHEMA_DDL` mirrors the head schema after all migrations (`0001_init.sql`
 * created the table as `rooms`; `0005_rename_room.sql` renamed it to `room`); the
 * room data is seeded from `apps/rooms/static/ImportRooms.json` by
 * `migrations/0002_import_rooms.sql`. Tests apply `ROOM_SCHEMA_DDL` then seed the
 * imported rooms directly.
 *
 * This module is the single source of truth for the helpers: the `rooms` worker
 * (which owns the schema/migrations) uses the read/write set; the `match` worker
 * uses the room lookups plus the dorm helpers; the `api` worker binds the same
 * database read-only and uses `getRoomById`. Each imports the subset it needs.
 */

import { Accessibility, Role } from './enums'

/** Schema DDL (mirror of the head migration schema, sans the seed INSERT). */
export const ROOM_SCHEMA_DDL: string[] = [
	`CREATE TABLE IF NOT EXISTS room (
		data TEXT NOT NULL,
		room_id INTEGER GENERATED ALWAYS AS (json_extract(data, '$.RoomId')) VIRTUAL,
		name TEXT GENERATED ALWAYS AS (json_extract(data, '$.Name')) VIRTUAL,
		name_lower TEXT GENERATED ALWAYS AS (lower(json_extract(data, '$.Name'))) VIRTUAL,
		creator_account_id INTEGER GENERATED ALWAYS AS (json_extract(data, '$.CreatorAccountId')) VIRTUAL,
		is_dorm INTEGER GENERATED ALWAYS AS (json_extract(data, '$.IsDorm')) VIRTUAL
	)`,
	`CREATE UNIQUE INDEX IF NOT EXISTS idx_rooms_room_id ON room (room_id)`,
	`CREATE INDEX IF NOT EXISTS idx_rooms_name_lower ON room (name_lower)`,
	`CREATE INDEX IF NOT EXISTS idx_rooms_creator ON room (creator_account_id)`,
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
		.prepare('SELECT MAX(room_id) AS maxId FROM room')
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
		{ AccountId: accountId, Role: Role.Owner, LastChangedByAccountId: null, InvitedRole: 0 },
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

	await db.prepare('INSERT INTO room (data) VALUES (?1)').bind(JSON.stringify(cloned)).run()
	return cloned
}

/** Set a room's Description in place (the caller is responsible for the owner check). */
export async function setRoomDescription(
	db: D1Database,
	roomId: number,
	description: string
): Promise<void> {
	await db
		.prepare("UPDATE room SET data = json_set(data, '$.Description', ?2) WHERE room_id = ?1")
		.bind(roomId, description)
		.run()
}

/** Set a room's Name in place (the caller checks ownership + name uniqueness first). */
export async function setRoomName(db: D1Database, roomId: number, name: string): Promise<void> {
	await db
		.prepare("UPDATE room SET data = json_set(data, '$.Name', ?2) WHERE room_id = ?1")
		.bind(roomId, name)
		.run()
}

/** Set a room's ImageName in place (the caller is responsible for the owner check). */
export async function setRoomImage(db: D1Database, roomId: number, imageName: string): Promise<void> {
	await db
		.prepare("UPDATE room SET data = json_set(data, '$.ImageName', ?2) WHERE room_id = ?1")
		.bind(roomId, imageName)
		.run()
}

/**
 * Mutually-exclusive "main" room tags. The UI presents these as radio buttons, so
 * setting one clears any other main tag. Compared case-insensitively.
 */
const MAIN_TAGS = new Set(['pvp', 'quest', 'game', 'hangout', 'art'])

/**
 * Add a user tag (`Type: 0`) to a room's `Tags`, skipping it when already present
 * (case-insensitive). The caller supplies the already-loaded room (owner-checked)
 * to avoid a re-read; the whole room JSON is rewritten. Returns the updated room.
 */
export async function toggleRoomTag(
	db: D1Database,
	roomId: number,
	room: Room,
	tag: string
): Promise<Room> {
	const tags = Array.isArray(room.Tags) ? (room.Tags as Array<Record<string, unknown>>) : []
	const lower = tag.toLowerCase()
	const tagLower = (t: Record<string, unknown>): string => String(t?.Tag).toLowerCase()
	const existing = tags.findIndex((t) => tagLower(t) === lower)

	// The client has no delete/patch endpoint — the same call toggles a tag: remove
	// it if already present, add it otherwise. Adding a main tag is a radio pick, so
	// it also clears any other main tag already set.
	let nextTags: Array<Record<string, unknown>>
	if (existing !== -1) {
		nextTags = tags.filter((_, i) => i !== existing)
	} else if (MAIN_TAGS.has(lower)) {
		nextTags = [...tags.filter((t) => !MAIN_TAGS.has(tagLower(t))), { Tag: tag, Type: 0 }]
	} else {
		nextTags = [...tags, { Tag: tag, Type: 0 }]
	}

	const updated: Room = { ...room, Tags: nextTags }
	await db
		.prepare('UPDATE room SET data = ?2 WHERE room_id = ?1')
		.bind(roomId, JSON.stringify(updated))
		.run()
	return updated
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
		.prepare('UPDATE room SET data = ?2 WHERE room_id = ?1')
		.bind(roomId, JSON.stringify(room))
		.run()
	return room
}

/** Fields from the client's subroom `modify` form (each applied only when supplied). */
export interface ModifySubRoomInput {
	name?: string
	accessibility?: number
	maxPlayers?: number
}

/**
 * Modify a subroom's settings in place — its Name, Accessibility, and MaxPlayers
 * (the fields the client's subroom `modify` form carries). Only the supplied
 * fields are changed; the whole room JSON is rewritten (subrooms live in it).
 * Returns the updated room, or null when the room or subroom doesn't exist.
 */
export async function modifySubRoom(
	db: D1Database,
	roomId: number,
	subRoomId: number,
	input: ModifySubRoomInput
): Promise<Room | null> {
	const room = await getRoomById(db, roomId)
	if (!room) return null
	const sub = findSubRoom(room, subRoomId)
	if (!sub) return null

	if (input.name !== undefined) sub.Name = input.name
	if (input.accessibility !== undefined) sub.Accessibility = input.accessibility
	if (input.maxPlayers !== undefined) sub.MaxPlayers = input.maxPlayers

	await db
		.prepare('UPDATE room SET data = ?2 WHERE room_id = ?1')
		.bind(roomId, JSON.stringify(room))
		.run()
	return room
}

/**
 * Clone an existing subroom into a new subroom of the same room, owned by
 * `accountId`. The copy keeps the source's scene/settings (and its saved data
 * blobs, so it loads identical content) but gets a fresh SubRoomId — the next
 * integer above the room's current subrooms. Returns the updated room and the new
 * subroom, or null when the room or source subroom doesn't exist.
 */
export async function cloneSubRoom(
	db: D1Database,
	roomId: number,
	subRoomId: number,
	accountId: number
): Promise<{ room: Room; subRoom: Record<string, unknown> } | null> {
	const room = await getRoomById(db, roomId)
	if (!room) return null
	const source = findSubRoom(room, subRoomId)
	if (!source) return null

	const subRooms = Array.isArray(room.SubRooms)
		? (room.SubRooms as Array<Record<string, unknown>>)
		: []
	const nextSubRoomId =
		subRooms.reduce((max, s) => {
			const id = typeof s.SubRoomId === 'number' ? s.SubRoomId : 0
			return id > max ? id : max
		}, 0) + 1

	const subRoom: Record<string, unknown> = {
		...source,
		SubRoomId: nextSubRoomId,
		RoomId: room.RoomId,
		CreatorAccountId: accountId,
	}

	room.SubRooms = [...subRooms, subRoom]
	await db
		.prepare('UPDATE room SET data = ?2 WHERE room_id = ?1')
		.bind(roomId, JSON.stringify(room))
		.run()
	return { room, subRoom }
}

interface RoomRow {
	data: string
}

const parseOne = (row: RoomRow | null): Room | null => (row ? (JSON.parse(row.data) as Room) : null)
const parseAll = (rows: RoomRow[]): Room[] => rows.map((r) => JSON.parse(r.data) as Room)

/** Look up a single room by its RoomId. */
export async function getRoomById(db: D1Database, roomId: number): Promise<Room | null> {
	return parseOne(
		await db.prepare('SELECT data FROM room WHERE room_id = ?1').bind(roomId).first<RoomRow>()
	)
}

/** Look up a single room by name (case-insensitive exact match). */
export async function getRoomByName(db: D1Database, name: string): Promise<Room | null> {
	return parseOne(
		await db
			.prepare('SELECT data FROM room WHERE name_lower = ?1')
			.bind(name.toLowerCase())
			.first<RoomRow>()
	)
}

/** Look up multiple rooms by RoomId. */
export async function getRoomsByIds(db: D1Database, ids: number[]): Promise<Room[]> {
	if (ids.length === 0) return []
	const placeholders = ids.map((_, i) => `?${i + 1}`).join(',')
	const { results } = await db
		.prepare(`SELECT data FROM room WHERE room_id IN (${placeholders})`)
		.bind(...ids)
		.all<RoomRow>()
	return parseAll(results)
}

/** All rooms created by an account (e.g. their dorm). */
export async function getRoomsByCreator(db: D1Database, accountId: number): Promise<Room[]> {
	const { results } = await db
		.prepare('SELECT data FROM room WHERE creator_account_id = ?1')
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
			 JOIN room r ON r.room_id = i.room_id
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
			 JOIN room r ON r.room_id = i.room_id
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

	const { results } = await db.prepare('SELECT data FROM room').all<RoomRow>()
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
	const { results } = await db.prepare('SELECT data FROM room').all<RoomRow>()
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
	const { results } = await db.prepare('SELECT data FROM room').all<RoomRow>()
	const roomId = (r: Room): number => (typeof r.RoomId === 'number' ? r.RoomId : 0)
	return parseAll(results)
		.filter((r) => r.IsDorm !== true && r.Accessibility === 1 && r.ExcludeFromLists !== true)
		.sort((a, b) => hotScore(b) - hotScore(a) || roomId(a) - roomId(b))
		.slice(skip, skip + take)
}

/** Compact room projection carried by a featured-room group. */
export interface FeaturedRoom {
	RoomId: number
	RoomName: string
	ImageName: string
	IsRecRoomApproved: boolean
	ExcludeFromLists: boolean
	ExcludeFromSearch: boolean
}

/** A time-boxed group of featured rooms, as returned by `/featuredrooms/current`. */
export interface FeaturedRoomGroup {
	FeaturedRoomGroupId: number
	name: string
	StartAt: string
	EndAt: string
	Rooms: FeaturedRoom[]
}

/**
 * Featured rooms group: public, non-dorm rooms not excluded from lists, in random
 * order. There's no editorial curation behind this yet, so "featured" is just a
 * random shuffle of the eligible rooms wrapped in a single always-active group.
 * Small dataset, so done in memory.
 */
export async function getFeaturedRooms(db: D1Database): Promise<FeaturedRoomGroup> {
	const { results } = await db.prepare('SELECT data FROM room').all<RoomRow>()
	const rooms = parseAll(results).filter(
		(r) => r.IsDorm !== true && r.Accessibility === 1 && r.ExcludeFromLists !== true
	)
	// Fisher–Yates shuffle so the feed varies between requests.
	for (let i = rooms.length - 1; i > 0; i--) {
		const j = Math.floor(Math.random() * (i + 1))
		;[rooms[i], rooms[j]] = [rooms[j], rooms[i]]
	}

	const str = (v: unknown): string => (typeof v === 'string' ? v : '')
	const num = (v: unknown): number => (typeof v === 'number' ? v : 0)
	return {
		FeaturedRoomGroupId: 1,
		name: 'Featured Rooms',
		StartAt: '2025-12-01T11:01:00Z',
		EndAt: '9999-12-08T11:00:00Z',
		Rooms: rooms.map((r) => ({
			RoomId: num(r.RoomId),
			RoomName: str(r.Name),
			ImageName: str(r.ImageName),
			IsRecRoomApproved: r.IsRecRoomApproved === true,
			ExcludeFromLists: r.ExcludeFromLists === true,
			ExcludeFromSearch: r.ExcludeFromSearch === true,
		})),
	}
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

	const { results } = await db.prepare('SELECT data FROM room').all<RoomRow>()
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
	const { results } = await db.prepare('SELECT data FROM room').all<RoomRow>()
	const base = new Set(['base'])
	const roomIdOf = (r: Room): number => (typeof r.RoomId === 'number' ? r.RoomId : 0)
	return parseAll(results)
		.filter((r) => roomHasAnyTag(r, base))
		.sort((a, b) => roomIdOf(a) - roomIdOf(b))
		.slice(skip, skip + take)
}

/** The seeded template dorm (RoomId 1) that personal dorms are cloned from. */
const DORM_TEMPLATE_ROOM_ID = 1

/** A player's username from the shared accounts table (for naming their dorm), or null. */
export async function getUsername(db: D1Database, accountId: number): Promise<string | null> {
	const row = await db
		.prepare('SELECT data FROM account WHERE account_id = ?1')
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
