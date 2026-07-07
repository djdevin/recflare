/**
 * Room instances — live sessions of a room. Stored with the same JSON-blob pattern
 * as the rooms/accounts tables: the full instance is a JSON blob in `data`, and
 * every field is a SQLite generated (virtual) column extracted from it (snake_case
 * per the C# `[Column]` names). `id` is a sequential key held in the blob.
 *
 * Mirror of `apps/rooms/src/room-instance-db.ts` — the `rooms` worker owns the
 * schema (migrations/0004_room_instance.sql); this worker finds/creates instances
 * here at matchmake time, keeping this copy in sync. Columns marked
 * `[JsonIgnore]` in the C# (owner_account_id, data_blob, allow_new_users,
 * join_disabled) live in the blob but are dropped from the client DTO (`toDto`).
 */

/** Schema DDL (mirror of migrations/0004_room_instance.sql). */
export const SCHEMA_DDL: string[] = [
	`CREATE TABLE IF NOT EXISTS room_instance (
		data TEXT NOT NULL,
		id INTEGER GENERATED ALWAYS AS (json_extract(data, '$.roomInstanceId')) VIRTUAL,
		owner_account_id INTEGER GENERATED ALWAYS AS (json_extract(data, '$.ownerAccountId')) VIRTUAL,
		room_id INTEGER GENERATED ALWAYS AS (json_extract(data, '$.roomId')) VIRTUAL,
		sub_room_id INTEGER GENERATED ALWAYS AS (json_extract(data, '$.subRoomId')) VIRTUAL,
		location TEXT GENERATED ALWAYS AS (json_extract(data, '$.location')) VIRTUAL,
		data_blob TEXT GENERATED ALWAYS AS (json_extract(data, '$.dataBlob')) VIRTUAL,
		event_id INTEGER GENERATED ALWAYS AS (json_extract(data, '$.eventId')) VIRTUAL,
		photon_region_id TEXT GENERATED ALWAYS AS (json_extract(data, '$.photonRegionId')) VIRTUAL,
		photon_room_id TEXT GENERATED ALWAYS AS (json_extract(data, '$.photonRoomId')) VIRTUAL,
		name TEXT GENERATED ALWAYS AS (json_extract(data, '$.name')) VIRTUAL,
		max_capacity INTEGER GENERATED ALWAYS AS (json_extract(data, '$.maxCapacity')) VIRTUAL,
		is_full INTEGER GENERATED ALWAYS AS (json_extract(data, '$.isFull')) VIRTUAL,
		is_private INTEGER GENERATED ALWAYS AS (json_extract(data, '$.isPrivate')) VIRTUAL,
		is_in_progress INTEGER GENERATED ALWAYS AS (json_extract(data, '$.isInProgress')) VIRTUAL,
		room_code TEXT GENERATED ALWAYS AS (json_extract(data, '$.roomCode')) VIRTUAL,
		room_instance_type INTEGER GENERATED ALWAYS AS (json_extract(data, '$.roomInstanceType')) VIRTUAL,
		club_id INTEGER GENERATED ALWAYS AS (json_extract(data, '$.clubId')) VIRTUAL,
		encrypt_voice_chat INTEGER GENERATED ALWAYS AS (json_extract(data, '$.EncryptVoiceChat')) VIRTUAL,
		matchmaking_policy INTEGER GENERATED ALWAYS AS (json_extract(data, '$.matchmakingPolicy')) VIRTUAL,
		allow_new_users INTEGER GENERATED ALWAYS AS (json_extract(data, '$.allowNewUsers')) VIRTUAL,
		join_disabled INTEGER GENERATED ALWAYS AS (json_extract(data, '$.joinDisabled')) VIRTUAL,
		created_at TEXT GENERATED ALWAYS AS (json_extract(data, '$.createdAt')) VIRTUAL
	)`,
	`CREATE UNIQUE INDEX IF NOT EXISTS idx_room_instance_id ON room_instance (id)`,
	`CREATE UNIQUE INDEX IF NOT EXISTS idx_room_instance_photon_room_id ON room_instance (photon_room_id)`,
	`CREATE INDEX IF NOT EXISTS idx_room_instance_room_id ON room_instance (room_id)`,
]

/** Client-facing RoomInstance JSON (JsonPropertyName keys; JsonIgnore omitted). */
export interface RoomInstanceDto {
	roomInstanceId: number
	roomId: number
	subRoomId: number
	location: string
	eventId: number
	photonRegionId: string
	photonRoomId: string
	name: string
	maxCapacity: number
	isFull: boolean
	isPrivate: boolean
	isInProgress: boolean
	roomCode: string
	roomInstanceType: number
	clubId: number
	// PascalCase JSON key, per the C# `[JsonPropertyName("EncryptVoiceChat")]`.
	EncryptVoiceChat: boolean
	matchmakingPolicy: number
	createdAt: string
}

/** The full stored instance — the DTO plus the JsonIgnore fields (in the blob). */
interface StoredRoomInstance extends RoomInstanceDto {
	ownerAccountId: number
	dataBlob: string
	allowNewUsers: boolean
	joinDisabled: boolean
}

/** Fields for a new instance; `roomInstanceId` and `createdAt` are assigned here. */
export interface NewRoomInstance {
	ownerAccountId: number
	roomId: number
	photonRoomId: string
	subRoomId?: number
	location?: string
	dataBlob?: string
	eventId?: number
	photonRegionId?: string
	name?: string
	maxCapacity?: number
	isFull?: boolean
	isPrivate?: boolean
	isInProgress?: boolean
	roomCode?: string
	roomInstanceType?: number
	clubId?: number
	encryptVoiceChat?: boolean
	matchmakingPolicy?: number
	allowNewUsers?: boolean
	joinDisabled?: boolean
}

/** Project a stored instance to the client DTO (JsonIgnore fields dropped). */
function toDto(s: StoredRoomInstance): RoomInstanceDto {
	return {
		roomInstanceId: s.roomInstanceId,
		roomId: s.roomId,
		subRoomId: s.subRoomId,
		location: s.location,
		eventId: s.eventId,
		photonRegionId: s.photonRegionId,
		photonRoomId: s.photonRoomId,
		name: s.name,
		maxCapacity: s.maxCapacity,
		isFull: s.isFull,
		isPrivate: s.isPrivate,
		isInProgress: s.isInProgress,
		roomCode: s.roomCode,
		roomInstanceType: s.roomInstanceType,
		clubId: s.clubId,
		EncryptVoiceChat: s.EncryptVoiceChat,
		matchmakingPolicy: s.matchmakingPolicy,
		createdAt: s.createdAt,
	}
}

const parse = (data: string): StoredRoomInstance => JSON.parse(data) as StoredRoomInstance

/**
 * Ids start high (above 1_000_000) so an instance id never collides with the
 * dorm's fixed roomInstanceId of 1 — the client keys room transitions off the id,
 * so a room instance that returned 1 would look like "still in the dorm".
 */
const ID_BASE = 1_000_000

/** Insert a new room instance, returning it as a client DTO. */
export async function createRoomInstance(
	db: D1Database,
	input: NewRoomInstance
): Promise<RoomInstanceDto> {
	const idRow = await db
		.prepare(`SELECT COALESCE(MAX(id), ${ID_BASE}) + 1 AS next FROM room_instance`)
		.first<{ next: number }>()
	const stored: StoredRoomInstance = {
		roomInstanceId: idRow?.next ?? ID_BASE + 1,
		ownerAccountId: input.ownerAccountId,
		roomId: input.roomId,
		subRoomId: input.subRoomId ?? 0,
		location: input.location ?? '',
		dataBlob: input.dataBlob ?? '',
		eventId: input.eventId ?? 0,
		photonRegionId: input.photonRegionId ?? 'us',
		photonRoomId: input.photonRoomId,
		name: input.name ?? '',
		maxCapacity: input.maxCapacity ?? 0,
		isFull: input.isFull ?? false,
		isPrivate: input.isPrivate ?? false,
		isInProgress: input.isInProgress ?? false,
		roomCode: input.roomCode ?? '',
		roomInstanceType: input.roomInstanceType ?? 0,
		clubId: input.clubId ?? 0,
		EncryptVoiceChat: input.encryptVoiceChat ?? false,
		matchmakingPolicy: input.matchmakingPolicy ?? 0,
		allowNewUsers: input.allowNewUsers ?? true,
		joinDisabled: input.joinDisabled ?? false,
		createdAt: new Date().toISOString(),
	}
	await db.prepare('INSERT INTO room_instance (data) VALUES (?1)').bind(JSON.stringify(stored)).run()
	return toDto(stored)
}

/** Look up a room instance by its id (roomInstanceId). */
export async function getRoomInstance(db: D1Database, id: number): Promise<RoomInstanceDto | null> {
	const row = await db
		.prepare('SELECT data FROM room_instance WHERE id = ?1')
		.bind(id)
		.first<{ data: string }>()
	return row ? toDto(parse(row.data)) : null
}

/**
 * Flip an instance's `isInProgress` flag, rewriting the JSON blob (the generated
 * `is_in_progress` column follows it). Returns the updated DTO, or null when the
 * instance doesn't exist.
 */
export async function setRoomInstanceInProgress(
	db: D1Database,
	id: number,
	isInProgress: boolean
): Promise<RoomInstanceDto | null> {
	const row = await db
		.prepare('SELECT data FROM room_instance WHERE id = ?1')
		.bind(id)
		.first<{ data: string }>()
	if (!row) return null
	const stored = parse(row.data)
	stored.isInProgress = isInProgress
	await db
		.prepare('UPDATE room_instance SET data = ?1 WHERE id = ?2')
		.bind(JSON.stringify(stored), id)
		.run()
	return toDto(stored)
}

/**
 * The oldest joinable public instance of a room (not private, not full, joins
 * enabled, not already in progress), or null when there's none to join. Used by
 * matchmaking to reuse an existing instance before creating a new one.
 */
export async function getJoinableInstance(
	db: D1Database,
	roomId: number
): Promise<RoomInstanceDto | null> {
	const row = await db
		.prepare(
			`SELECT data FROM room_instance
			 WHERE room_id = ?1 AND is_private = 0 AND is_full = 0 AND join_disabled = 0
			   AND is_in_progress = 0
			 ORDER BY id LIMIT 1`
		)
		.bind(roomId)
		.first<{ data: string }>()
	return row ? toDto(parse(row.data)) : null
}

/** All instances of a given room. */
export async function getRoomInstancesByRoom(
	db: D1Database,
	roomId: number
): Promise<RoomInstanceDto[]> {
	const { results } = await db
		.prepare('SELECT data FROM room_instance WHERE room_id = ?1')
		.bind(roomId)
		.all<{ data: string }>()
	return results.map((r) => toDto(parse(r.data)))
}
