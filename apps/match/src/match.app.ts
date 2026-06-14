import { Hono } from 'hono'
import { useWorkersLogger } from 'workers-tagged-logger'

import { withNotFound, withOnError } from '@repo/hono-helpers'

import { validateAndGetAccountId } from './jwt'

import type { Context } from 'hono'
import type { App } from './context'

/**
 * Ported from the C# `MatchmakingController`. Endpoints the C# backs with EF Core
 * (`AppDbContext`) are stubbed here — there's no DB binding yet, so room/player
 * lookups fall back to the same defaults the C# uses when nothing is found.
 *
 * Auth-gated routes still validate the Bearer JWT issued by the `auth` worker.
 */

/**
 * Default `/player` payload. The C# serves this from `JSON/getplayer.json`
 * whenever the `id` is missing/invalid or the account isn't found; Workers have
 * no filesystem so it's inlined here.
 */
const DEFAULT_GET_PLAYER = [
	{
		playerId: 1,
		statusVisibility: 0,
		deviceClass: 0,
		vrMovementMode: 1,
		roomInstance: null,
		isOnline: true,
		appVersion: '20210129',
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
 * auth-header check in the C#. Returns `null` when the header is missing,
 * the token is invalid, or the `sub` claim isn't an integer.
 */
async function authedId(c: Context<App>): Promise<number | null> {
	const authHeader = c.req.header('Authorization') ?? ''
	if (!authHeader.toLowerCase().startsWith('bearer ')) return null

	const token = authHeader.slice('Bearer '.length)
	const accountId = await validateAndGetAccountId(token)
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

const presenceKey = (id: number) => `presence:${id}`

/** Persist the player's presence (room instance + status), refreshing the TTL. */
async function setPresence(c: Context<App>, id: number, presence: Presence): Promise<void> {
	await c.env.MATCH_PRESENCE.put(presenceKey(id), JSON.stringify(presence), {
		expirationTtl: PRESENCE_TTL,
	})
}

/** Read the player's stored presence, or null when they aren't in a room. */
async function getPresence(c: Context<App>, id: number): Promise<Presence | null> {
	return c.env.MATCH_PRESENCE.get<Presence>(presenceKey(id), 'json')
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
		appVersion: prev?.appVersion ?? '',
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
		roomInstanceType: 2,
		location: '76d98498-60a1-430c-ab76-b54a29b7a163',
		dataBlob: '',
		eventId: 0,
		clubId: 0,
		roomCode: '',
		photonRegionId: 'us',
		photonRoomId: DORM_PHOTON_ROOM_ID,
		name: 'DormRoom',
		maxCapacity: 4,
		isFull: false,
		isPrivate: true,
		isInProgress: false,
		EncryptVoiceChat: false,
	}
}

/** Synthesize a non-dorm room instance. No Rooms DB, so location is empty and
 * the photon id is freshly minted — it's persisted as presence and replayed by
 * the heartbeat, so it stays consistent for the session. */
function buildRoomInstance(roomName: string, isPrivate: boolean): RoomInstance {
	return {
		roomInstanceId: 1,
		roomId: Number.parseInt(roomName, 10) || 1,
		subRoomId: 0,
		roomInstanceType: 2,
		location: '',
		dataBlob: '',
		eventId: 0,
		clubId: 0,
		roomCode: '',
		photonRegionId: 'us',
		photonRoomId: crypto.randomUUID(),
		name: roomName,
		maxCapacity: 4,
		isFull: false,
		isPrivate,
		isInProgress: false,
		EncryptVoiceChat: false,
	}
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
	// Login/exclusivelogin: the player isn't in a room yet, so clear any stale
	// presence (mirrors the C# connect/token removing the player's RoomInstance).
	// The first heartbeat after this reports roomInstance=null until matchmake.
	.post('/player/login', async (c) => {
		const id = await authedId(c)
		if (id !== null) await c.env.MATCH_PRESENCE.delete(presenceKey(id))
		return c.body(null, 200)
	})
	.post('/player/exclusivelogin', async (c) => {
		const id = await authedId(c)
		if (id !== null) await c.env.MATCH_PRESENCE.delete(presenceKey(id))
		return c.json({ errorCode: 0 })
	})

	.get('/player', async (c) => {
		// Returns each requested player's presence. The C# reads the `id` query
		// param(s); with none it serves the static getplayer.json default.
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
					appVersion: p?.appVersion ?? '',
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
			if (hb.appVersion != null) presence.appVersion = hb.appVersion
			await setPresence(c, id, presence)
		}

		return c.json({
			playerId: hb.playerId ? hb.playerId : id,
			statusVisibility: presence?.statusVisibility ?? hb.statusVisibility ?? 0,
			deviceClass: presence?.deviceClass ?? hb.deviceClass ?? 0,
			vrMovementMode: presence?.vrMovementMode ?? (hb.vrMovementMode ? hb.vrMovementMode : 1),
			roomInstance: presence?.roomInstance ?? null,
			isOnline: presence?.roomInstance != null,
			appVersion: presence?.appVersion ?? hb.appVersion ?? '',
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
		const isDorm = room.toLowerCase() === 'dormroom'
		const body = await c.req.parseBody().catch(() => ({}) as Record<string, unknown>)
		const joinMode = typeof body.JoinMode === 'string' ? Number.parseInt(body.JoinMode, 10) || 0 : 0
		const instance = isDorm ? dormRoomInstance() : buildRoomInstance(room, joinMode === 2)
		await enterRoom(c, id, instance)
		return c.json({ errorCode: 0, roomInstance: instance })
	})

	// Register the static `none` route before the `:room` param route so it
	// isn't swallowed by the auth-gated matchmake handler.
	.post('/matchmake/none', async (c) => {
		const id = await authedId(c)
		const instance = dormRoomInstance()
		if (id !== null) await enterRoom(c, id, instance)
		return c.json({ errorCode: 0, roomInstance: instance })
	})
	.post('/matchmake/:room', async (c) => {
		const id = await authedId(c)
		if (id === null) return unauthorized(c)

		const room = c.req.param('room')
		// Identical to goto/room/:room except the C# dorm check here is "dorm".
		const isDorm = room.toLowerCase() === 'dorm'
		const body = await c.req.parseBody().catch(() => ({}) as Record<string, unknown>)
		const joinMode = typeof body.JoinMode === 'string' ? Number.parseInt(body.JoinMode, 10) || 0 : 0
		const instance = isDorm ? dormRoomInstance() : buildRoomInstance(room, joinMode === 2)
		await enterRoom(c, id, instance)
		return c.json({ errorCode: 0, roomInstance: instance })
	})

	// Offline dorm — also persisted as presence so the heartbeat stays in sync.
	.post('/goto/none', async (c) => {
		const id = await authedId(c)
		const instance = dormRoomInstance()
		if (id !== null) await enterRoom(c, id, instance)
		return c.json({ errorCode: 0, roomInstance: instance })
	})

	// ---- Room instance -------------------------------------------------------
	.post('/roominstance/:id/reportjoinresult', (c) => c.body(null, 200))

export default app
