import { Hono } from 'hono'
import { useWorkersLogger } from 'workers-tagged-logger'

import {
	createRoomInstance,
	deleteExpiredPresence,
	getAccount,
	getExpiredPresenceInstanceIds,
	getJoinableInstance,
	getOrCreateDormRoom,
	getPresence,
	getPresences,
	getRoomById,
	getRoomByName,
	getRoomInstancesByRoom,
	refreshInstanceFullness,
	RoomInstanceType,
	setPresence,
	setRoomInstanceInProgress,
} from '@repo/domain'
import { withNotFound, withOnError } from '@repo/hono-helpers'
import { validateAndGetAccountId } from '@repo/jwt'

import type { Context } from 'hono'
import type { Room, StoredPresence } from '@repo/domain'
import type { App, Env } from './context'

/**
 * The matchmaking surface. Rooms and room instances are D1-backed (matchmaking
 * finds/creates a `room_instance` row per session); player lookups still fall back
 * to default values when nothing is found. Presence is D1-backed too (the
 * `presence` table; see @repo/domain's presence-db).
 *
 * Auth-gated routes still validate the Bearer JWT issued by the `auth` worker.
 */

/**
 * The connection fields the client expects on a player payload but that only ever
 * carry a value in a matchmaking response — the photon/voice credentials for the
 * instance you were just placed into. Reading someone else's presence never hands
 * out credentials, so they're always null here; the client needs the keys present.
 */
const NULL_CONNECTION_INFO = {
	photonAuthToken: null,
	photonRealtimeAppId: null,
	photonVoiceAppId: null,
	photonChatAppId: null,
	photonRegion: null,
	photonRoomId: null,
	voiceConnectionInfo: null,
	voiceServerId: null,
	experiments: null,
} as const

/**
 * A player's presence as the client reads it (`/player`, `/player/heartbeat`).
 * `isOnline` means "has a live presence row" — presence rows expire, so a player who
 * stopped heartbeating drops offline — and is deliberately *not* derived from being
 * in a room: you can be online in the lobby with `roomInstance` null. `errorCode` 0
 * is "no error"; it only turns non-zero on a failed matchmake.
 */
function playerPayload(playerId: number, presence?: Presence | null) {
	return {
		appVersion: presence?.appVersion || GAME_VERSION,
		deviceClass: presence?.deviceClass ?? 0,
		errorCode: 0,
		// `getPresence` yields null and the batch map yields undefined — neither is online.
		isOnline: presence != null,
		playerId,
		roomInstance: presence?.roomInstance ?? null,
		statusVisibility: presence?.statusVisibility ?? 0,
		vrMovementMode: presence?.vrMovementMode ?? 1,
		platform: presence?.platform ?? 0,
		...NULL_CONNECTION_INFO,
	}
}

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
	return validateAndGetAccountId(c.req.raw, await c.env.JWT_SECRET.get())
}

/** Results.Unauthorized() equivalent — 401 with empty body. */
function unauthorized(c: Context<App>) {
	return c.body(null, 401)
}

/** A synthesized room instance (same shape for dorm and other rooms). */
type RoomInstance = ReturnType<typeof dormRoomInstance>

/**
 * Stored presence for a player — the room instance they matchmade into plus the
 * status fields the heartbeat echoes back. The generic StoredPresence lives in
 * @repo/domain; here it's specialized to the match worker's RoomInstance shape.
 */
type Presence = StoredPresence<RoomInstance>

/**
 * A heartbeat that changes nothing re-writes presence only once its TTL drops
 * within this window of expiring (s), instead of on every beat. So a player who's
 * sitting still is refreshed at most once per (PRESENCE_TTL_SECONDS − this) rather
 * than on every heartbeat — far fewer D1 writes, while still staying comfortably
 * ahead of expiry (the client heartbeats many times inside this window).
 */
const PRESENCE_REFRESH_THRESHOLD = 300

/**
 * Game build version reported in presence. This is a server-side constant — the
 * client doesn't supply it, and an empty value breaks the client's
 * presence/version handling. Matches our target 2023 client build.
 */
const GAME_VERSION = '20230302'

/**
 * Default `/player` payload, served whenever the `id` is missing/invalid or the
 * account isn't found. Inlined here (Workers have no filesystem). The stub player
 * reads as online — it's a placeholder for a real, present player.
 */
const DEFAULT_GET_PLAYER = [{ ...playerPayload(1), isOnline: true }]

/**
 * Store the room instance the player just matchmade into, preserving status.
 *
 * With no live presence to carry forward (the player's first matchmake after login,
 * or one after their presence lapsed) the device fields would otherwise default —
 * writing a screen player into the instance as deviceClass 0 until their next
 * heartbeat corrects it. Everyone already in the room sees that stale class in the
 * meantime, so fall back to what the account reported at login (auth stores
 * `deviceClass`/`platform` from the token request) instead of to 0. The account read
 * only happens on that no-presence path; a normal matchmake carries `prev` forward.
 */
async function enterRoom(c: Context<App>, id: number, roomInstance: RoomInstance): Promise<void> {
	const prev = await getPresence<RoomInstance>(c.env.DB, id)
	const account = prev ? null : await getAccount(c.env.DB, id)
	await setPresence(c.env.DB, {
		accountId: id,
		roomInstance,
		statusVisibility: prev?.statusVisibility ?? 0,
		deviceClass: prev?.deviceClass ?? account?.deviceClass ?? 0,
		vrMovementMode: prev?.vrMovementMode ?? 1,
		platform: prev?.platform ?? account?.platform ?? 0,
		appVersion: prev?.appVersion || GAME_VERSION,
	})
	// Keep the destination instance's is_full flag in sync with live presence (the
	// player's own presence, just written, is counted). Then re-evaluate the
	// instance they left — its head-count dropped — so a full room frees up when
	// players move on. Both no-op for the synthetic dorm/orientation instances.
	await refreshInstanceFullness(c.env.DB, roomInstance.roomInstanceId)
	const leftId = prev?.roomInstance?.roomInstanceId
	if (leftId != null && leftId !== roomInstance.roomInstanceId) {
		await refreshInstanceFullness(c.env.DB, leftId)
	}
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
 *
 * `subRoomId` picks which of the room's subrooms to enter (the client matchmakes
 * into one with `/matchmake/room/{roomId}/{subRoomId}`); an unknown or unspecified
 * subroom falls back to the room's first, which is its default entrance.
 */
function instanceFieldsFromRoom(room: Room, subRoomId?: number) {
	const subRooms = (Array.isArray(room.SubRooms) ? room.SubRooms : []) as Array<
		Record<string, unknown>
	>
	const sub =
		(subRoomId === undefined ? undefined : subRooms.find((s) => s.SubRoomId === subRoomId)) ??
		subRooms[0]
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
	photonRoomId: string,
	subRoomId?: number
): RoomInstance {
	const f = instanceFieldsFromRoom(room, subRoomId)
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
	ownerId: number,
	subRoomId?: number
): Promise<RoomInstance | null> {
	const id = Number.parseInt(roomKey, 10)
	const room = Number.isNaN(id)
		? await getRoomByName(c.env.DB, roomKey)
		: await getRoomById(c.env.DB, id)
	if (!room) return null

	const f = instanceFieldsFromRoom(room, subRoomId)
	// Reuse an existing joinable public instance *of the same subroom* — subrooms are
	// separate places, so joining one must never land you in another. Private
	// matchmakes always get a fresh instance. Create one when there's nothing to join.
	let instance = isPrivate ? null : await getJoinableInstance(c.env.DB, f.roomId, f.subRoomId)
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
	return roomInstanceFromRoom(
		room,
		isPrivate,
		instance.roomInstanceId,
		instance.photonRoomId,
		f.subRoomId
	)
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

		// One query for the whole batch (D1 `WHERE account_id IN (…)`), rather than a
		// point read per id as the KV store required.
		const presences = await getPresences<RoomInstance>(c.env.DB, ids)
		return c.json(ids.map((playerId) => playerPayload(playerId, presences.get(playerId))))
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
		// fields are merged back; the row is re-written (refreshing the TTL) only when
		// something changed or its TTL is close to lapsing — see below.
		const presence = await getPresence<RoomInstance>(c.env.DB, id)
		if (presence) {
			// Merge the posted status fields, tracking whether any actually changed.
			let changed = false
			const apply = <K extends keyof Presence>(key: K, value: Presence[K]) => {
				if (presence[key] !== value) {
					presence[key] = value
					changed = true
				}
			}
			if (hb.statusVisibility !== undefined) apply('statusVisibility', hb.statusVisibility)
			if (hb.deviceClass !== undefined) apply('deviceClass', hb.deviceClass)
			if (hb.vrMovementMode !== undefined) apply('vrMovementMode', hb.vrMovementMode)
			if (hb.platform !== undefined) apply('platform', hb.platform)
			if (hb.appVersion) apply('appVersion', hb.appVersion)
			if (!presence.appVersion) apply('appVersion', GAME_VERSION)

			// Extending the TTL means re-writing the row, so skip the write on an
			// unchanged heartbeat until the TTL is within PRESENCE_REFRESH_THRESHOLD
			// (s) of lapsing — a still player is refreshed periodically rather than on
			// every beat. `expiresAt` is epoch seconds (set by setPresence).
			const nowSeconds = Math.floor(Date.now() / 1000)
			const dueForRefresh = presence.expiresAt - nowSeconds <= PRESENCE_REFRESH_THRESHOLD
			if (changed || dueForRefresh) {
				await setPresence(c.env.DB, presence)
			}
		}

		// The heartbeat echoes the same player payload `/player` serves; with no stored
		// presence it falls back to what the client just posted.
		return c.json({
			...playerPayload(hb.playerId ? hb.playerId : id, presence),
			statusVisibility: presence?.statusVisibility ?? hb.statusVisibility ?? 0,
			deviceClass: presence?.deviceClass ?? hb.deviceClass ?? 0,
			vrMovementMode: presence?.vrMovementMode ?? (hb.vrMovementMode ? hb.vrMovementMode : 1),
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
			const presence = await getPresence<RoomInstance>(c.env.DB, id)
			if (presence && !Number.isNaN(sv)) {
				presence.statusVisibility = sv
				await setPresence(c.env.DB, presence)
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
			const presence = await getPresence<RoomInstance>(c.env.DB, id)
			if (presence?.roomInstance) {
				return c.json({ errorCode: 0, roomInstance: presence.roomInstance })
			}
		}
		// Authed but no presence → their personal dorm; unauthenticated → offline dorm.
		const instance = id !== null ? await playerDormInstance(c, id) : dormRoomInstance()
		if (id !== null) await enterRoom(c, id, instance)
		return c.json({ errorCode: 0, roomInstance: instance })
	})
	// Matchmake into a specific subroom of a room (`/matchmake/room/{roomId}/{subRoomId}`
	// — the client uses this to enter a room's other scenes). The subroom decides the
	// scene the client loads and which instances are joinable, so it must be carried
	// through; an unknown subroom falls back to the room's first.
	.post('/matchmake/room/:roomId/:subRoomId{[0-9]+}', async (c) => {
		const id = await authedId(c)
		if (id === null) return unauthorized(c)
		const joinMode = await readJoinMode(c)
		const subRoomId = Number.parseInt(c.req.param('subRoomId'), 10)
		const instance = await resolveRoomInstance(
			c,
			c.req.param('roomId'),
			joinMode === 2,
			id,
			subRoomId
		)
		if (!instance) return c.json({ errorCode: NO_SUCH_ROOM, roomInstance: null })
		await enterRoom(c, id, instance)
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

	// The room's live instances — the owner's view of active sessions of their room.
	// Auth-gated (401) and owner-only (403): the caller must be the room's creator.
	// Unknown room → 404. Returns the bare RoomInstance DTO array (empty when the
	// room has no live instances).
	.get('/room/:roomId{[0-9]+}/instances', async (c) => {
		const id = await authedId(c)
		if (id === null) return unauthorized(c)

		const roomId = Number.parseInt(c.req.param('roomId'), 10)
		const room = await getRoomById(c.env.DB, roomId)
		if (!room) return c.body(null, 404)
		if (room.CreatorAccountId !== id) return c.body(null, 403)

		return c.json(await getRoomInstancesByRoom(c.env.DB, roomId))
	})

	// Rooms flagged as needing a developer/moderator to spawn in. No such queue
	// yet → empty list.
	.get('/rooms/requiring/developer', (c) => c.json([]))

	// Rooms flagged as requiring an RR+ subscription. No such queue yet → empty list.
	.get('/rooms/requiring/rrplus', (c) => c.json([]))

/**
 * Cron: sweep presence that has aged past its TTL. Reads already ignore expired rows,
 * so this isn't about correctness of `/player` — it's that a player who crashed or
 * hard-quit never matchmakes out of their instance, so nothing recomputes that
 * instance's fullness and it can stay flagged full (and unjoinable) with nobody in it.
 * Recompute the instances the expiring rows point at, *then* delete: the sweep is the
 * only thing that notices those departures. Fullness is recomputed after the delete so
 * the head-count no longer sees them.
 */
async function sweepExpiredPresence(env: Env): Promise<void> {
	const staleInstanceIds = await getExpiredPresenceInstanceIds(env.DB)
	const removed = await deleteExpiredPresence(env.DB)
	for (const instanceId of staleInstanceIds) {
		await refreshInstanceFullness(env.DB, instanceId)
	}
	// The tagged logger is request-scoped (its middleware never runs for a cron), so
	// log plainly here — Workers observability picks it up either way.
	console.log(
		`presence sweep: removed ${removed} expired rows, refreshed ${staleInstanceIds.length} instances`
	)
}

export default {
	fetch: app.fetch,
	scheduled: async (_controller, env, ctx) => {
		ctx.waitUntil(sweepExpiredPresence(env))
	},
} satisfies ExportedHandler<Env>
