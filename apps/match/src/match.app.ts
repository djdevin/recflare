import { Hono } from 'hono'
import { useWorkersLogger } from 'workers-tagged-logger'

import {
	getOrCreateDormRoom,
	getRoomById,
	getRoomByName,
	RoomInstanceType,
} from '@repo/domain'
import { withNotFound, withOnError } from '@repo/hono-helpers'
import { validateAndGetAccountId } from '@repo/jwt'

import {
	createRoomInstance,
	getJoinableInstance,
	getRoomInstancesByRoom,
	setRoomInstanceInProgress,
} from './room-instance-db'

import type { Room } from '@repo/domain'
import type { Context } from 'hono'
import type { App } from './context'

/**
 * The matchmaking surface. Rooms and room instances are D1-backed (matchmaking
 * finds/creates a `room_instance` row per session); player lookups still fall back
 * to default values when nothing is found. Presence lives in the match KV.
 *
 * Auth-gated routes still validate the Bearer JWT issued by the `auth` worker.
 */

/**
 * Default `/player` payload, served whenever the `id` is missing/invalid or the
 * account isn't found. Inlined here (Workers have no filesystem).
 */
const DEFAULT_GET_PLAYER = [
	{
		playerId: 1,
		statusVisibility: 0,
		deviceClass: 0,
		vrMovementMode: 1,
		roomInstance: null,
		isOnline: true,
		appVersion: '20230302',
		platform: 0,
	},
]

/** Heartbeat body posted by the client (all fields optional). */
interface HeartbeatRequest {
	playerId?: number
	statusVisibility?: number
	deviceClass?: number
	vrMovementMode?: number
	appVersion?: string | null
	platform?: number
}

/**
 * Resolve the account id from a Bearer token, mirroring the repeated
 * auth-header check. Returns `null` when the header is missing,
 * the token is invalid, or the `sub` claim isn't an integer.
 */
async function authedId(c: Context<App>): Promise<number | null> {
	const authHeader = c.req.header('Authorization') ?? ''
	if (!authHeader.toLowerCase().startsWith('bearer ')) return null

	const token = authHeader.slice('Bearer '.length)
	const accountId = await validateAndGetAccountId(token, await c.env.JWT_SECRET.get())
	if (!accountId) return null

	const id = Number.parseInt(accountId, 10)
	return Number.isNaN(id) ? null : id
}

/** Results.Unauthorized() equivalent — 401 with empty body. */
function unauthorized(c: Context<App>) {
	return c.body(null, 401)
}

/** A synthesized room instance (same shape for dorm and other rooms). */
type RoomInstance = ReturnType<typeof dormRoomInstance>

/**
 * Stored presence for a player — the room instance they matchmade into plus the
 * status fields the heartbeat echoes back. Mirrors the reference server's
 * HeartbeatDB row.
 */
interface Presence {
	roomInstance: RoomInstance | null
	statusVisibility: number
	deviceClass: number
	vrMovementMode: number
	platform: number
	appVersion: string
}

/** Presence is kept this long (s) after the last matchmake/heartbeat refresh. */
const PRESENCE_TTL = 900

/**
 * Game build version reported in presence. This is a server-side constant — the
 * client doesn't supply it, and an empty value breaks the client's
 * presence/version handling. Matches our target 2023 client build.
 */
const GAME_VERSION = '20230302'

const presenceKey = (id: number) => `presence:${id}`

/** Persist the player's presence (room instance + status), refreshing the TTL. */
async function setPresence(c: Context<App>, id: number, presence: Presence): Promise<void> {
	await c.env.RECFLARE_MATCH_PRESENCE.put(presenceKey(id), JSON.stringify(presence), {
		expirationTtl: PRESENCE_TTL,
	})
}

/** Read the player's stored presence, or null when they aren't in a room. */
async function getPresence(c: Context<App>, id: number): Promise<Presence | null> {
	return c.env.RECFLARE_MATCH_PRESENCE.get<Presence>(presenceKey(id), 'json')
}

/** Store the room instance the player just matchmade into, preserving status. */
async function enterRoom(c: Context<App>, id: number, roomInstance: RoomInstance): Promise<void> {
	const prev = await getPresence(c, id)
	await setPresence(c, id, {
		roomInstance,
		statusVisibility: prev?.statusVisibility ?? 0,
		deviceClass: prev?.deviceClass ?? 0,
		vrMovementMode: prev?.vrMovementMode ?? 1,
		platform: prev?.platform ?? 0,
		appVersion: prev?.appVersion || GAME_VERSION,
	})
}

/**
 * Fixed Photon room id for the dorm. With no RoomInstance DB we can't persist
 * the GUID minted at matchmake time, and the client's presence check compares
 * the *whole* instance (photonRoomId included). Every dorm entry point
 * (matchmake/goto, matchmake/none, the heartbeat) must therefore return the
 * exact same instance, so the id is a constant rather than random/per-account.
 */
const DORM_PHOTON_ROOM_ID = '00000000-0000-4000-8000-000000000001'

/** MatchmakingErrorCode.NoSuchRoom — returned when a room isn't in the DB. */
const NO_SUCH_ROOM = 20

/**
 * The canonical dorm room instance (room 1, instance 1.1). Returned identically
 * by every dorm entry point and the presence heartbeat so the client's local
 * presence never reads as out-of-sync.
 */
function dormRoomInstance() {
	return {
		roomInstanceId: 1,
		roomId: 1,
		subRoomId: 1,
		roomInstanceType: RoomInstanceType.Dormroom,
		location: '76d98498-60a1-430c-ab76-b54a29b7a163',
		dataBlob: '',
		eventId: 0,
		clubId: 0,
		roomCode: '',
		photonRegion: 'us',
		photonRegionId: 'us',
		photonRoomId: DORM_PHOTON_ROOM_ID,
		name: '^DormRoom',
		maxCapacity: 4,
		isFull: false,
		isPrivate: true,
		isInProgress: false,
		EncryptVoiceChat: false,
	}
}

/**
 * Instance-relevant fields pulled from a stored room (scene, name, capacity, …).
 * The `location` is the SubRoom's real `UnitySceneId` — an empty/unknown location
 * makes the client reject the session with "unknown scene location ID".
 */
function instanceFieldsFromRoom(room: Room) {
	const sub = (Array.isArray(room.SubRooms) ? room.SubRooms[0] : undefined) as
		Record<string, unknown> | undefined
	const str = (v: unknown, fallback = '') => (typeof v === 'string' ? v : fallback)
	const num = (v: unknown, fallback: number) => (typeof v === 'number' ? v : fallback)
	// Room instance names are prefixed with `^` so the client resolves the instance
	// (without it the new scene won't load). Personal dorms are the exception: they
	// carry the owner prefix `@<user>'s Dorm` and must NOT also get a `^`.
	const rawName = str(room.Name, 'Room')
	const name = rawName.startsWith('^') || rawName.startsWith('@') ? rawName : `^${rawName}`
	return {
		roomId: num(room.RoomId, 1),
		subRoomId: num(sub?.SubRoomId, 1),
		location: str(sub?.UnitySceneId),
		dataBlob: str(sub?.DataBlob),
		name,
		maxCapacity: num(sub?.MaxPlayers, 4),
		roomInstanceType: room.IsDorm === true ? RoomInstanceType.Dormroom : RoomInstanceType.Public,
		isDorm: room.IsDorm === true,
	}
}

/**
 * Build the client instance wire shape from a stored room plus the live instance's
 * id + Photon room id (both come from the `room_instance` table so joiners of the
 * same instance share them).
 */
function roomInstanceFromRoom(
	room: Room,
	isPrivate: boolean,
	instanceId: number,
	photonRoomId: string
): RoomInstance {
	const f = instanceFieldsFromRoom(room)
	return {
		roomInstanceId: instanceId,
		roomId: f.roomId,
		subRoomId: f.subRoomId,
		roomInstanceType: f.roomInstanceType,
		location: f.location,
		dataBlob: f.dataBlob,
		eventId: 0,
		clubId: 0,
		roomCode: '',
		photonRegion: 'us',
		photonRegionId: 'us',
		photonRoomId,
		name: f.name,
		maxCapacity: f.maxCapacity,
		isFull: false,
		isPrivate: isPrivate || f.isDorm,
		isInProgress: false,
		EncryptVoiceChat: false,
	}
}

/** Read the `JoinMode` form field (2 = private instance). */
async function readJoinMode(c: Context<App>): Promise<number> {
	const body = await c.req.parseBody().catch(() => ({}) as Record<string, unknown>)
	return typeof body.JoinMode === 'string' ? Number.parseInt(body.JoinMode, 10) || 0 : 0
}

/**
 * Resolve a room by `:room` path segment (numeric id or name) from D1, then find a
 * joinable instance of it (public matchmakes reuse one via the `room_instance`
 * table) or create a new one. Returns null when the room isn't found.
 */
async function resolveRoomInstance(
	c: Context<App>,
	roomKey: string,
	isPrivate: boolean,
	ownerId: number
): Promise<RoomInstance | null> {
	const id = Number.parseInt(roomKey, 10)
	const room = Number.isNaN(id)
		? await getRoomByName(c.env.DB, roomKey)
		: await getRoomById(c.env.DB, id)
	if (!room) return null

	const f = instanceFieldsFromRoom(room)
	// Reuse an existing joinable public instance; private matchmakes always get a
	// fresh instance. Create one when there's nothing to join.
	let instance = isPrivate ? null : await getJoinableInstance(c.env.DB, f.roomId)
	if (!instance) {
		instance = await createRoomInstance(c.env.DB, {
			ownerAccountId: ownerId,
			roomId: f.roomId,
			subRoomId: f.subRoomId,
			location: f.location,
			dataBlob: f.dataBlob,
			photonRoomId: crypto.randomUUID(),
			name: f.name,
			maxCapacity: f.maxCapacity,
			isPrivate: isPrivate || f.isDorm,
			roomInstanceType: f.roomInstanceType,
		})
	}
	return roomInstanceFromRoom(room, isPrivate, instance.roomInstanceId, instance.photonRoomId)
}

/**
 * The authed player's personal dorm instance. Gets-or-creates their dorm room,
 * then backs it with a single persistent private `room_instance` so the dorm has
 * a stable, unique Photon room id (dorms are isolated from each other) that
 * survives re-entry. The room's current scene/saved data is re-read each time, so
 * edits show up on the next visit.
 */
async function playerDormInstance(c: Context<App>, accountId: number): Promise<RoomInstance> {
	const room = await getOrCreateDormRoom(c.env.DB, accountId)
	const f = instanceFieldsFromRoom(room)
	// Reuse the dorm's one instance (private, so getJoinableInstance won't find it).
	let instance = (await getRoomInstancesByRoom(c.env.DB, f.roomId))[0]
	if (!instance) {
		instance = await createRoomInstance(c.env.DB, {
			ownerAccountId: accountId,
			roomId: f.roomId,
			subRoomId: f.subRoomId,
			location: f.location,
			dataBlob: f.dataBlob,
			photonRoomId: crypto.randomUUID(),
			name: f.name,
			maxCapacity: f.maxCapacity,
			isPrivate: true,
			roomInstanceType: f.roomInstanceType,
		})
	}
	return roomInstanceFromRoom(room, true, instance.roomInstanceId, instance.photonRoomId)
}

const app = new Hono<App>()
	.use(
		'*',
		// middleware
		(c, next) =>
			useWorkersLogger(c.env.NAME, {
				environment: c.env.ENVIRONMENT,
				release: c.env.SENTRY_RELEASE,
			})(c, next)
	)

	.onError(withOnError())
	.notFound(withNotFound())

	// ---- Player presence -----------------------------------------------------
	// login/exclusivelogin/logout are all no-op acks and MUST NOT touch presence.
	// The client fires a spurious `player/logout` during the account-creation
	// bootstrap (right after create_account seeds the new player into Orientation);
	// deleting presence here wiped that seed and bounced the player to the dorm.
	// Presence is overwritten by matchmake/goto and expires on its own TTL, so we
	// don't need to clear it on these lifecycle calls.
	.post('/player/login', (c) => c.body(null, 200))
	.post('/player/exclusivelogin', (c) => c.json({ errorCode: 0 }))
	.post('/player/logout', (c) => c.body(null, 200))

	.get('/player', async (c) => {
		// Returns each requested player's presence. Reads the `id` query param(s);
		// with none it serves the static getplayer.json default.
		const ids = c.req
			.queries('id')
			?.flatMap((v) => v.split(','))
			.map((s) => Number.parseInt(s.trim(), 10))
			.filter((n) => !Number.isNaN(n))
		if (!ids || ids.length === 0) return c.json(DEFAULT_GET_PLAYER)

		const players = await Promise.all(
			ids.map(async (playerId) => {
				const p = await getPresence(c, playerId)
				return {
					playerId,
					statusVisibility: p?.statusVisibility ?? 0,
					deviceClass: p?.deviceClass ?? 0,
					vrMovementMode: p?.vrMovementMode ?? 1,
					roomInstance: p?.roomInstance ?? null,
					isOnline: p?.roomInstance != null,
					appVersion: p?.appVersion || GAME_VERSION,
					platform: p?.platform ?? 0,
				}
			})
		)
		return c.json(players)
	})

	.post('/player/heartbeat', async (c) => {
		const id = await authedId(c)
		if (id === null) return unauthorized(c)

		// Body may be a JSON HeartbeatRequest or a form post (LoginLock); only JSON
		// carries presence/status fields.
		const raw = await c.req.text().catch(() => '')
		let hb: HeartbeatRequest = {}
		if (raw.trimStart().startsWith('{')) {
			try {
				hb = JSON.parse(raw) as HeartbeatRequest
			} catch {
				hb = {}
			}
		}

		// Return the player's stored presence (set by matchmake/goto), mirroring the
		// reference server's HeartbeatDB.GetPlayerHeartbeat. No presence → the player
		// isn't in a room yet, so roomInstance=null / isOnline=false. Posted status
		// fields are merged back and the TTL refreshed so presence stays alive.
		const presence = await getPresence(c, id)
		if (presence) {
			if (hb.statusVisibility !== undefined) presence.statusVisibility = hb.statusVisibility
			if (hb.deviceClass !== undefined) presence.deviceClass = hb.deviceClass
			if (hb.vrMovementMode !== undefined) presence.vrMovementMode = hb.vrMovementMode
			if (hb.platform !== undefined) presence.platform = hb.platform
			if (hb.appVersion) presence.appVersion = hb.appVersion
			if (!presence.appVersion) presence.appVersion = GAME_VERSION
			await setPresence(c, id, presence)
		}

		return c.json({
			playerId: hb.playerId ? hb.playerId : id,
			statusVisibility: presence?.statusVisibility ?? hb.statusVisibility ?? 0,
			deviceClass: presence?.deviceClass ?? hb.deviceClass ?? 0,
			vrMovementMode: presence?.vrMovementMode ?? (hb.vrMovementMode ? hb.vrMovementMode : 1),
			roomInstance: presence?.roomInstance ?? null,
			isOnline: presence?.roomInstance != null,
			appVersion: presence?.appVersion || hb.appVersion || GAME_VERSION,
			platform: presence?.platform ?? hb.platform ?? 0,
		})
	})

	.put('/player/statusvisibility', async (c) => {
		const id = await authedId(c)
		if (id !== null) {
			const body = await c.req.parseBody().catch(() => ({}) as Record<string, unknown>)
			const sv =
				typeof body.statusVisibility === 'string' ? Number.parseInt(body.statusVisibility, 10) : NaN
			const presence = await getPresence(c, id)
			if (presence && !Number.isNaN(sv)) {
				presence.statusVisibility = sv
				await setPresence(c, id, presence)
			}
		}
		return c.body(null, 200)
	})

	// ---- Room navigation -----------------------------------------------------
	// Each matchmake/goto persists the resulting instance as the player's presence
	// so the heartbeat can replay it (keeping client presence in sync).
	.post('/goto/room/:room', async (c) => {
		const id = await authedId(c)
		if (id === null) return unauthorized(c)

		const room = c.req.param('room')
		const joinMode = await readJoinMode(c)
		const instance =
			room.toLowerCase() === 'dormroom'
				? await playerDormInstance(c, id)
				: await resolveRoomInstance(c, room, joinMode === 2, id)
		if (!instance) return c.json({ errorCode: NO_SUCH_ROOM, roomInstance: null })
		await enterRoom(c, id, instance)
		return c.json({ errorCode: 0, roomInstance: instance })
	})

	// Register the static `none` route before the `:room` param route so it
	// isn't swallowed by the auth-gated matchmake handler.
	.post('/matchmake/none', async (c) => {
		const id = await authedId(c)
		// Return the player's *current* heartbeat here rather than forcing the dorm.
		// Orientation is a solo room the client establishes via matchmake/none; if we
		// force the dorm, the new player is warped out of Orientation within seconds.
		// So: preserve existing presence; only fall back to the offline dorm when the
		// player has none (e.g. the title screen before they've entered any room).
		if (id !== null) {
			const presence = await getPresence(c, id)
			if (presence?.roomInstance) {
				return c.json({ errorCode: 0, roomInstance: presence.roomInstance })
			}
		}
		// Authed but no presence → their personal dorm; unauthenticated → offline dorm.
		const instance = id !== null ? await playerDormInstance(c, id) : dormRoomInstance()
		if (id !== null) await enterRoom(c, id, instance)
		return c.json({ errorCode: 0, roomInstance: instance })
	})
	// The 2023 client uses a two-segment matchmake/room/{roomId}. Look the room up
	// in D1 so the instance carries its real scene, and store it as presence.
	.post('/matchmake/room/:roomId', async (c) => {
		const id = await authedId(c)
		if (id === null) return unauthorized(c)
		const joinMode = await readJoinMode(c)
		const instance = await resolveRoomInstance(c, c.req.param('roomId'), joinMode === 2, id)
		if (!instance) return c.json({ errorCode: NO_SUCH_ROOM, roomInstance: null })
		await enterRoom(c, id, instance)
		return c.json({ errorCode: 0, roomInstance: instance })
	})
	.post('/matchmake/:room', async (c) => {
		const id = await authedId(c)
		if (id === null) return unauthorized(c)

		const room = c.req.param('room')
		const joinMode = await readJoinMode(c)
		// The dorm check here is "dorm" (goto/room uses "dormroom").
		const instance =
			room.toLowerCase() === 'dorm'
				? await playerDormInstance(c, id)
				: await resolveRoomInstance(c, room, joinMode === 2, id)
		if (!instance) return c.json({ errorCode: NO_SUCH_ROOM, roomInstance: null })
		await enterRoom(c, id, instance)
		return c.json({ errorCode: 0, roomInstance: instance })
	})

	// Offline dorm — also persisted as presence so the heartbeat stays in sync.
	.post('/goto/none', async (c) => {
		const id = await authedId(c)
		// Authed → their personal dorm; unauthenticated → the offline dorm.
		const instance = id !== null ? await playerDormInstance(c, id) : dormRoomInstance()
		if (id !== null) await enterRoom(c, id, instance)
		return c.json({ errorCode: 0, roomInstance: instance })
	})

	// Region ping reports — accept-and-ack (the reference returns Ok()).
	.put('/player/photonregionpings', (c) => c.body(null, 200))
	.put('/player/gameserverregionpings', (c) => c.body(null, 200))

	// ---- Room instance -------------------------------------------------------
	.post('/roominstance/:id/reportjoinresult', (c) => c.body(null, 200))

	// The room owner flips the instance's in-progress flag once the session starts
	// (e.g. a game round begins). Body is a form post: `inProgress=True|False`.
	.put('/roominstance/:id/inprogress', async (c) => {
		const id = await authedId(c)
		if (id === null) return unauthorized(c)

		const instanceId = Number.parseInt(c.req.param('id'), 10)
		if (Number.isNaN(instanceId)) return c.body(null, 404)

		const body = await c.req.parseBody().catch(() => ({}) as Record<string, unknown>)
		const inProgress =
			typeof body.inProgress === 'string' && body.inProgress.toLowerCase() === 'true'

		const instance = await setRoomInstanceInProgress(c.env.DB, instanceId, inProgress)
		if (!instance) return c.body(null, 404)
		return c.body(null, 200)
	})

	// Rooms flagged as needing a developer/moderator to spawn in. No such queue
	// yet → empty list.
	.get('/rooms/requiring/developer', (c) => c.json([]))

	// Rooms flagged as requiring an RR+ subscription. No such queue yet → empty list.
	.get('/rooms/requiring/rrplus', (c) => c.json([]))

export default app
