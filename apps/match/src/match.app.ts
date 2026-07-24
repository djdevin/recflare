import { Hono } from 'hono'
import { describeRoute, openAPIRouteHandler } from 'hono-openapi'
import { useWorkersLogger } from 'workers-tagged-logger'

import {
	areFriends,
	canManageRoom,
	createRoomInstance,
	deleteExpiredPresence,
	deletePresence,
	GAME_VERSION,
	getAccount,
	getClubSummary,
	getExpiredPresenceInstanceIds,
	getFriendIds,
	getJoinableInstance,
	getOrCreateDormRoom,
	getPresence,
	getPresences,
	getRoomById,
	getRoomByName,
	getRoomInstance,
	getRoomInstancesByRoom,
	isClubMember,
	MessageType,
	refreshInstanceFullness,
	RoomInstanceType,
	setPresence,
	setRoomInstanceInProgress,
} from '@repo/domain'
import { logger, withCleanSpec, withNotFound, withOnError } from '@repo/hono-helpers'
import { validateAndGetAccountId } from '@repo/jwt'

// Value import of the notify worker's NotificationType enum (its bundle has no runtime
// deps), so /invite sends a typed MessageReceived frame instead of a magic number.
import { NotificationType } from '../../notify/src/notification-types'

import {
	AUTHED,
	EMPTY_OK,
	ExclusiveLoginResponse,
	form,
	HeartbeatRequest as HeartbeatRequestSchema,
	InProgressRequest,
	InviteRequest,
	JoinModeRequest,
	json,
	jsonBody,
	MatchmakeResponse,
	MatchmakeRoomRequest,
	PlayerDto,
	RoomInstanceDto,
	StatusVisibilityRequest,
	UNAUTHORIZED_RESPONSE,
} from './openapi'

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
 * Default `/player` payload, served whenever the `id` is missing/invalid or the
 * account isn't found. Inlined here (Workers have no filesystem). The stub player
 * reads as online — it's a placeholder for a real, present player.
 */
const DEFAULT_GET_PLAYER = [{ ...playerPayload(1), isOnline: true }]

/**
 * The wire subset of a room instance a friend sees in a presence update — the
 * reference's `RoomInstanceDto.Redact` projection. `photonRoomId` and `dataBlob` are
 * BLANKED (empty string): they're safe only for the player themselves. A leaked
 * `photonRoomId` would let anyone who can read your presence `JoinByName` the Photon
 * room directly, bypassing the private-instance invite check — the friend list only
 * needs `roomId`/`name`/`isPrivate` to render the row, and joins go back through
 * matchmaking (`/goto/player/:id`), which enforces access. `photonRegion` is omitted
 * (not on the presence DTO); `name` is already the `^`-prefixed wire name.
 */
function redactInstanceForPresence(instance: RoomInstance) {
	return {
		roomInstanceId: instance.roomInstanceId,
		roomId: instance.roomId,
		subRoomId: instance.subRoomId,
		roomInstanceType: instance.roomInstanceType,
		location: instance.location,
		// Blanked — see above: never hand another player the join coordinates.
		dataBlob: '',
		eventId: instance.eventId,
		clubId: instance.clubId,
		roomCode: instance.roomCode,
		photonRegionId: instance.photonRegionId,
		photonRoomId: '',
		name: instance.name,
		maxCapacity: instance.maxCapacity,
		isFull: instance.isFull,
		isPrivate: instance.isPrivate,
		isInProgress: instance.isInProgress,
		EncryptVoiceChat: instance.EncryptVoiceChat,
	}
}

/**
 * The SubscriptionUpdatePresence message a friend receives when the player changes rooms:
 * a presence snapshot of who, and the redacted instance they're now in (null when in no
 * room → `isOnline` false). `statusVisibility` is forced to 0 (Everyone) so the player
 * isn't hidden from friends. `appVersion` MUST be a string — the client's presence DTO
 * reads it with a string reader, and a numeric value aborts the whole SignalR frame
 * ("expected String Begin Token"), dropping the room/presence update.
 */
function presenceUpdateMessage(playerId: number, instance: RoomInstance | null) {
	return {
		playerId,
		statusVisibility: 0,
		deviceClass: 0,
		vrMovementMode: 0,
		roomInstance: instance ? redactInstanceForPresence(instance) : null,
		isOnline: instance != null,
		appVersion: GAME_VERSION,
	}
}

/**
 * Push a SubscriptionUpdatePresence to every online friend of `playerId` after their
 * presence changes (they entered a room). Mirrors the reference's PlayerPresenceChanged:
 * only currently-connected friends receive it (an offline friend gets nothing, not a
 * queued stale frame), so it's an ephemeral batch send. The room instance the friends
 * see is read from the player's stored presence — the authoritative record just written,
 * the same one the heartbeat replays. Best-effort: a hub or lookup failure is logged and
 * swallowed, so it never fails the matchmake that triggered it.
 */
async function notifyFriendsPresence(c: Context<App>, playerId: number): Promise<void> {
	try {
		const friendIds = await getFriendIds(c.env.DB, playerId)
		if (friendIds.length === 0) return
		const presence = await getPresence<RoomInstance>(c.env.DB, playerId)
		await c.env.RECFLARE_NOTIFICATIONS_HUB.getByName(HUB_INSTANCE).notifyPlayersEphemeral(
			friendIds,
			NotificationType.SubscriptionUpdatePresence,
			presenceUpdateMessage(playerId, presence?.roomInstance ?? null)
		)
	} catch (err) {
		logger.error('failed to push SubscriptionUpdatePresence to friends', {
			playerId,
			error: err instanceof Error ? err.message : String(err),
		})
	}
}

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

	// The player's presence changed — tell their online friends where they went, reading
	// the instance back from the presence we just stored. Best-effort; never blocks or
	// fails the matchmake.
	await notifyFriendsPresence(c, id)
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

/** The notifications hub is a single global DO instance (see the `notify` worker). */
const HUB_INSTANCE = 'global'

/**
 * A fresh id for a *live* (non-persisted) message — the reference's
 * `NextLiveMessageID`. A game invite is ephemeral (never stored), so there's no
 * database sequence to draw from; epoch milliseconds give a monotonically increasing,
 * effectively unique id the client can key the invite off. It only has to be distinct
 * among a player's in-flight invites, not globally.
 */
function nextLiveMessageId(): number {
	return Date.now()
}

/**
 * Deliver a game invite from `fromId` to `toId` for a room instance — a `MessageReceived`
 * frame carrying a game-invite `Message` the client renders the join prompt from. `data`
 * is the raw roomInstanceId string the message carries; `roomId` (nullable) tells the
 * client which room it points at. Best-effort: a hub failure is logged and swallowed.
 *
 * Shared by `POST /invite` (a single explicit invite) and the party fan-out on a room
 * matchmake (one per `AdditionalPlayerIds` entry), so the two can't drift.
 */
async function sendGameInvite(
	c: Context<App>,
	fromId: number,
	toId: number,
	data: string,
	roomId: number | null
): Promise<void> {
	const message = {
		Id: nextLiveMessageId(),
		FromPlayerId: fromId,
		ToPlayerId: toId,
		Type: MessageType.GameInvite,
		Data: data,
		SentTime: new Date().toISOString(),
		RoomId: roomId,
	}
	try {
		await c.env.RECFLARE_NOTIFICATIONS_HUB.getByName(HUB_INSTANCE).notifyPlayer(
			toId,
			NotificationType.MessageReceived,
			message
		)
	} catch (err) {
		logger.error('failed to push game-invite MessageReceived notification', {
			fromPlayerId: fromId,
			toPlayerId: toId,
			error: err instanceof Error ? err.message : String(err),
		})
	}
}

/**
 * The sentinel room-instance id the `auth` worker seeds a brand-new player's
 * Orientation presence with (see auth's `placeNewPlayerInOrientation`). The client
 * fires a spurious `player/logout` right after that seed, so logout must NOT clear
 * presence while it still points at Orientation — doing so wipes the seed and
 * bounces the new player to the dorm.
 */
const ORIENTATION_INSTANCE_ID = -2

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
 * Read the room-matchmake form body once: `JoinMode` (2 = private) plus the party members
 * to pull along (`AdditionalPlayerIds`). The 2023 client posts its party on a room
 * matchmake so they can be invited into the instance the leader lands in;
 * `AdditionalPlayerIds` may repeat and/or be comma-separated, and ids are parsed
 * defensively, de-duplicated, and non-positive/garbage entries dropped. Parsed with
 * `{ all: true }` in one pass so repeated fields survive.
 */
async function readMatchmakeBody(
	c: Context<App>
): Promise<{ joinMode: number; additionalPlayerIds: number[] }> {
	const body = await c.req.parseBody({ all: true }).catch(() => ({}) as Record<string, unknown>)
	const firstString = (v: unknown): string | undefined => {
		const first = Array.isArray(v) ? v[0] : v
		return typeof first === 'string' ? first : undefined
	}
	const joinModeRaw = firstString(body.JoinMode)
	const joinMode = joinModeRaw === undefined ? 0 : Number.parseInt(joinModeRaw, 10) || 0

	const key = Object.keys(body).find((k) => k.toLowerCase() === 'additionalplayerids')
	const raw = key === undefined ? [] : body[key]
	const values = Array.isArray(raw) ? raw : [raw]
	const additionalPlayerIds = [
		...new Set(
			values
				.filter((v): v is string => typeof v === 'string')
				.flatMap((v) => v.split(','))
				.map((s) => Number.parseInt(s.trim(), 10))
				.filter((n) => !Number.isNaN(n) && n > 0)
		),
	]
	return { joinMode, additionalPlayerIds }
}

/**
 * Invite the caller's party members into the instance the caller just matchmade into —
 * the `AdditionalPlayerIds` fan-out. Each member gets the same game invite `POST /invite`
 * sends, pointing at this instance, so a party matchmake pulls the whole party along. The
 * leader is skipped (already in). Best-effort per member (sendGameInvite swallows its own
 * failures), and never blocks the matchmake beyond the sends themselves.
 */
async function inviteParty(
	c: Context<App>,
	leaderId: number,
	playerIds: number[],
	instance: RoomInstance
): Promise<void> {
	const data = String(instance.roomInstanceId)
	await Promise.all(
		playerIds
			.filter((pid) => pid !== leaderId)
			.map((pid) => sendGameInvite(c, leaderId, pid, data, instance.roomId))
	)
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
	// Never place the player back into the instance they're already in: the client
	// keys the room transition off a changing `roomInstanceId`, so re-matchmaking into
	// your current instance (e.g. the only public instance of a room you're already in)
	// returns the same id and hangs the client mid-join. Exclude it from the join
	// search, which pushes them to another live instance if one exists or forces a
	// fresh one below. (Only the public path reuses instances, so only it needs the
	// read; a private matchmake always gets a fresh instance.)
	const currentInstanceId = isPrivate
		? undefined
		: (await getPresence<RoomInstance>(c.env.DB, ownerId))?.roomInstance?.roomInstanceId
	// Reuse an existing joinable public instance *of the same subroom* — subrooms are
	// separate places, so joining one must never land you in another. Private
	// matchmakes always get a fresh instance. Create one when there's nothing to join.
	let instance = isPrivate
		? null
		: await getJoinableInstance(c.env.DB, f.roomId, f.subRoomId, currentInstanceId)
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
	// login/exclusivelogin are no-op acks and MUST NOT touch presence: the client
	// fires exclusivelogin when going online, and clearing presence there would bounce
	// the player to the dorm. Presence is overwritten by matchmake/goto and expires on
	// its own TTL.
	.post(
		'/player/login',
		describeRoute({
			tags: ['Presence'],
			summary: 'Login ack (no-op)',
			description: [
				'A no-op ack. Must NOT touch presence — the client fires this going online, and',
				'clearing presence here would bounce the player to the dorm.',
			].join(' '),
			responses: { 200: EMPTY_OK },
		}),
		(c) => c.body(null, 200)
	)
	.post(
		'/player/exclusivelogin',
		describeRoute({
			tags: ['Presence'],
			summary: 'Exclusive-login ack (no-op)',
			description: 'A no-op ack returning a zero error code. Like login, must not touch presence.',
			responses: { 200: json(ExclusiveLoginResponse, 'errorCode 0') },
		}),
		(c) => c.json({ errorCode: 0 })
	)

	// Logout clears the player's presence so they read offline immediately and the
	// instance they were in frees up (rather than waiting out the presence TTL).
	//
	// EXCEPTION: the account-creation bootstrap. The client fires a spurious
	// `player/logout` right after a new player is seeded into Orientation (the auth
	// worker writes that presence with instance id -2). Clearing presence there wipes
	// the seed and bounces the new player to the dorm — so a logout that still points
	// at Orientation is left as a no-op ack. An unauthenticated logout is also a no-op
	// (no player to clear).
	.post(
		'/player/logout',
		describeRoute({
			tags: ['Presence'],
			summary: 'Clear presence on logout',
			description: [
				'Clears the player’s presence so they read offline immediately and the instance',
				'they were in frees up. EXCEPTION: a logout whose presence still points at the',
				'Orientation seed (instance -2) is left as a no-op, so the account-creation',
				'bootstrap isn’t wiped. An unauthenticated logout is also a no-op.',
			].join(' '),
			responses: { 200: EMPTY_OK },
		}),
		async (c) => {
			const id = await authedId(c)
			if (id !== null) {
				const presence = await getPresence<RoomInstance>(c.env.DB, id)
				const instanceId = presence?.roomInstance?.roomInstanceId
				if (presence && instanceId !== ORIENTATION_INSTANCE_ID) {
					await deletePresence(c.env.DB, id)
					// The instance they were in lost a player — recompute its fullness so a
					// full room frees up. No-op for the synthetic dorm/orientation instances.
					if (instanceId != null) await refreshInstanceFullness(c.env.DB, instanceId)
					// Their presence changed — tell online friends they went offline. Presence
					// is already cleared, so notifyFriendsPresence reads null and sends the
					// offline snapshot (roomInstance null, isOnline false).
					await notifyFriendsPresence(c, id)
				}
			}
			return c.body(null, 200)
		}
	)

	// Fire-and-forget disconnect notification (form body `PlayerId`/`RoomInstanceId`).
	// The client posts this when it drops a room; we don't act on it — presence is
	// cleared by logout and otherwise expires on its own TTL — so just ack with 200.
	.post(
		'/player/notifydisconnect',
		describeRoute({
			tags: ['Presence'],
			summary: 'Disconnect notification (no-op ack)',
			description: [
				'Posted when the client drops a room. Not acted on — presence is cleared by logout',
				'and otherwise expires on its TTL.',
			].join(' '),
			responses: { 200: EMPTY_OK },
		}),
		(c) => c.body(null, 200)
	)

	.get(
		'/player',
		describeRoute({
			tags: ['Presence'],
			summary: 'Batch player presence lookup',
			description: [
				'Returns each requested player’s presence. `id` is repeatable and each value may',
				'be a comma-separated list. With no ids, serves a single default (online) player.',
			].join(' '),
			parameters: [
				{
					name: 'id',
					in: 'query',
					required: false,
					description: 'Repeatable; each value may be a comma-separated list of player ids',
					schema: { type: 'array', items: { type: 'string' } },
				},
			],
			responses: { 200: json(PlayerDto.array(), 'One entry per requested player') },
		}),
		async (c) => {
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
		}
	)

	.post(
		'/player/heartbeat',
		describeRoute({
			tags: ['Presence'],
			summary: 'Presence heartbeat',
			description: [
				'Merges the posted status fields into stored presence and echoes back the player',
				'payload. Re-writes the row (refreshing its TTL) only when something changed or the',
				'TTL is close to lapsing, so a still player isn’t written on every beat. With no',
				'stored presence the player isn’t in a room yet (roomInstance null, isOnline false).',
			].join(' '),
			security: AUTHED,
			requestBody: jsonBody(
				HeartbeatRequestSchema,
				'JSON status fields. A non-JSON (LoginLock) body is accepted and ignored.'
			),
			responses: {
				200: json(PlayerDto, 'The player’s current presence payload'),
				401: UNAUTHORIZED_RESPONSE,
			},
		}),
		async (c) => {
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
			const payload = {
				...playerPayload(hb.playerId ? hb.playerId : id, presence),
				statusVisibility: presence?.statusVisibility ?? hb.statusVisibility ?? 0,
				deviceClass: presence?.deviceClass ?? hb.deviceClass ?? 0,
				vrMovementMode: presence?.vrMovementMode ?? (hb.vrMovementMode ? hb.vrMovementMode : 1),
				appVersion: presence?.appVersion || hb.appVersion || GAME_VERSION,
				platform: presence?.platform ?? hb.platform ?? 0,
			}

			// Also push the presence over the websocket as a PresenceHeartbeatResponse,
			// mirroring the reference's ReturnHeartbeat. Sent ephemerally (never queued) —
			// a heartbeat fires on every beat, and a queued copy would pile up and arrive
			// stale. Best-effort: the HTTP body carries the same payload regardless.
			try {
				await c.env.RECFLARE_NOTIFICATIONS_HUB.getByName(HUB_INSTANCE).notifyPlayerEphemeral(
					id,
					NotificationType.PresenceHeartbeatResponse,
					payload
				)
			} catch (err) {
				logger.error('failed to push PresenceHeartbeatResponse notification', {
					playerId: id,
					error: err instanceof Error ? err.message : String(err),
				})
			}

			return c.json(payload)
		}
	)

	.put(
		'/player/statusvisibility',
		describeRoute({
			tags: ['Presence'],
			summary: 'Set status visibility',
			description: [
				'Updates the stored presence’s status visibility. No-op when the player has no live',
				'presence or an unauthenticated/invalid token — always acks 200.',
			].join(' '),
			requestBody: form(StatusVisibilityRequest, 'The statusVisibility value'),
			responses: { 200: EMPTY_OK },
		}),
		async (c) => {
			const id = await authedId(c)
			if (id !== null) {
				const body = await c.req.parseBody().catch(() => ({}) as Record<string, unknown>)
				const sv =
					typeof body.statusVisibility === 'string'
						? Number.parseInt(body.statusVisibility, 10)
						: NaN
				const presence = await getPresence<RoomInstance>(c.env.DB, id)
				if (presence && !Number.isNaN(sv)) {
					presence.statusVisibility = sv
					await setPresence(c.env.DB, presence)
				}
			}
			return c.body(null, 200)
		}
	)

	// ---- Room navigation -----------------------------------------------------
	// Each matchmake/goto persists the resulting instance as the player's presence
	// so the heartbeat can replay it (keeping client presence in sync).
	.post(
		'/goto/room/:room',
		describeRoute({
			tags: ['Navigation'],
			summary: 'Go to a room',
			description: [
				'Resolves the room (numeric id or name; `dormroom` → the player’s personal dorm),',
				'finds or creates an instance, and stores it as presence. `JoinMode=2` requests a',
				'private instance.',
			].join(' '),
			security: AUTHED,
			requestBody: form(JoinModeRequest, 'Optional JoinMode'),
			parameters: [
				{
					name: 'room',
					in: 'path',
					required: true,
					description: 'Room id, room name, or `dormroom`',
					schema: { type: 'string' },
				},
			],
			responses: {
				200: json(MatchmakeResponse, 'The instance (or errorCode 20 with null on unknown room)'),
				401: UNAUTHORIZED_RESPONSE,
			},
		}),
		async (c) => {
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
		}
	)

	// Register the static `none` route before the `:room` param route so it
	// isn't swallowed by the auth-gated matchmake handler.
	.post(
		'/matchmake/none',
		describeRoute({
			tags: ['Navigation'],
			summary: 'Matchmake with no target (preserve or dorm)',
			description: [
				'Returns the player’s current instance if they have one (so Orientation isn’t warped',
				'away), else their personal dorm when authed, or the shared offline dorm when not.',
				'Not auth-gated.',
			].join(' '),
			responses: {
				200: json(MatchmakeResponse, 'Current, personal-dorm, or offline-dorm instance'),
			},
		}),
		async (c) => {
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
		}
	)
	// Matchmake into a club's clubhouse (`/matchmake/club/{clubId}`). Registered before
	// the single-segment `/matchmake/:room` route so `club` isn't read as a room name.
	// Members only: the clubhouse is the club's private space, so a non-member (or
	// someone with a pending request, or banned) is refused rather than let in.
	.post(
		'/matchmake/club/:clubId{[0-9]+}',
		describeRoute({
			tags: ['Navigation'],
			summary: 'Matchmake into a club’s clubhouse',
			description: [
				'Looks the club up, checks the caller is a member of it, and places them into an',
				'instance of its clubhouse room. Returns errorCode 20 with a null instance when the',
				'club is unknown, has no clubhouse set, or the caller isn’t a member.',
			].join(' '),
			security: AUTHED,
			requestBody: form(JoinModeRequest, 'Optional JoinMode'),
			parameters: [
				{
					name: 'clubId',
					in: 'path',
					required: true,
					description: 'Club id (digits only)',
					schema: { type: 'string', pattern: '^[0-9]+$' },
				},
			],
			responses: {
				200: json(
					MatchmakeResponse,
					'The clubhouse instance (or errorCode 20 with null when it can’t be entered)'
				),
				401: UNAUTHORIZED_RESPONSE,
			},
		}),
		async (c) => {
			const id = await authedId(c)
			if (id === null) return unauthorized(c)

			const clubId = Number.parseInt(c.req.param('clubId'), 10)
			const club = await getClubSummary(c.env.DB, clubId)
			// One response for "no such club", "no clubhouse", and "not a member": the
			// client only needs "you're not going there", and a distinct code for the last
			// case would tell a non-member which clubs exist and have a clubhouse.
			if (!club?.clubhouseRoomId) return c.json({ errorCode: NO_SUCH_ROOM, roomInstance: null })
			if (!(await isClubMember(c.env.DB, clubId, id))) {
				return c.json({ errorCode: NO_SUCH_ROOM, roomInstance: null })
			}

			const joinMode = await readJoinMode(c)
			const instance = await resolveRoomInstance(
				c,
				String(club.clubhouseRoomId),
				joinMode === 2,
				id
			)
			if (!instance) return c.json({ errorCode: NO_SUCH_ROOM, roomInstance: null })
			await enterRoom(c, id, instance)
			return c.json({ errorCode: 0, roomInstance: instance })
		}
	)

	// Follow a friend into the room they're in (`/matchmake/player/{playerId}`). Friends
	// ONLY — the caller must be a mutual friend of the target, or it's refused; otherwise
	// anyone could read a player's presence and warp to them. Reads the friend's current
	// instance from their stored presence and places the caller into that same instance
	// (the real, un-redacted Photon coordinates — the caller is authorized to join).
	// Registered before the single-segment `/matchmake/:room` route so `player` isn't read
	// as a room name. Returns errorCode 20 with a null instance when the target isn't a
	// friend or isn't currently in a room.
	.post(
		'/matchmake/player/:playerId{[0-9]+}',
		describeRoute({
			tags: ['Navigation'],
			summary: 'Follow a friend into their room',
			description: [
				'Places the caller into the room instance the target player is currently in, read',
				'from the target’s stored presence. FRIENDS ONLY: the caller must be a mutual friend',
				'of the target (otherwise anyone could read a player’s presence and warp to them).',
				'Returns errorCode 20 with a null instance when the target isn’t a friend, is the',
				'caller themselves, or isn’t currently in a room.',
			].join(' '),
			security: AUTHED,
			parameters: [
				{
					name: 'playerId',
					in: 'path',
					required: true,
					description: 'The friend to follow (digits only)',
					schema: { type: 'string', pattern: '^[0-9]+$' },
				},
			],
			responses: {
				200: json(
					MatchmakeResponse,
					'The friend’s instance (or errorCode 20 with null when it can’t be joined)'
				),
				401: UNAUTHORIZED_RESPONSE,
			},
		}),
		async (c) => {
			const id = await authedId(c)
			if (id === null) return unauthorized(c)

			const targetId = Number.parseInt(c.req.param('playerId'), 10)
			// Friends only, and never yourself — otherwise refuse without leaking whether the
			// target is even online (same opaque NoSuchRoom the club path uses).
			if (targetId === id || !(await areFriends(c.env.DB, id, targetId))) {
				return c.json({ errorCode: NO_SUCH_ROOM, roomInstance: null })
			}

			// The instance the friend is currently in, straight off their presence row.
			const targetPresence = await getPresence<RoomInstance>(c.env.DB, targetId)
			const instance = targetPresence?.roomInstance ?? null
			if (!instance) return c.json({ errorCode: NO_SUCH_ROOM, roomInstance: null })

			// Join that same instance (same id + Photon room) and store it as the caller's
			// presence, so the heartbeat replays it and their own friend fan-out fires.
			await enterRoom(c, id, instance)
			return c.json({ errorCode: 0, roomInstance: instance })
		}
	)

	// Matchmake into a specific subroom of a room (`/matchmake/room/{roomId}/{subRoomId}`
	// — the client uses this to enter a room's other scenes). The subroom decides the
	// scene the client loads and which instances are joinable, so it must be carried
	// through; an unknown subroom falls back to the room's first.
	.post(
		'/matchmake/room/:roomId/:subRoomId{[0-9]+}',
		describeRoute({
			tags: ['Navigation'],
			summary: 'Matchmake into a specific subroom',
			description: [
				'Enters a specific subroom (scene) of a room. The subroom decides the scene loaded',
				'and which instances are joinable; an unknown subroom falls back to the room’s first.',
			].join(' '),
			security: AUTHED,
			requestBody: form(MatchmakeRoomRequest, 'Optional JoinMode and AdditionalPlayerIds'),
			parameters: [
				{ name: 'roomId', in: 'path', required: true, schema: { type: 'string' } },
				{
					name: 'subRoomId',
					in: 'path',
					required: true,
					description: 'Subroom id (digits only)',
					schema: { type: 'string', pattern: '^[0-9]+$' },
				},
			],
			responses: {
				200: json(MatchmakeResponse, 'The instance (or errorCode 20 with null on unknown room)'),
				401: UNAUTHORIZED_RESPONSE,
			},
		}),
		async (c) => {
			const id = await authedId(c)
			if (id === null) return unauthorized(c)
			const { joinMode, additionalPlayerIds } = await readMatchmakeBody(c)
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
			// Pull the caller's party (AdditionalPlayerIds) into the instance they landed in.
			await inviteParty(c, id, additionalPlayerIds, instance)
			return c.json({ errorCode: 0, roomInstance: instance })
		}
	)

	// The 2023 client uses a two-segment matchmake/room/{roomId}. Look the room up
	// in D1 so the instance carries its real scene, and store it as presence.
	.post(
		'/matchmake/room/:roomId',
		describeRoute({
			tags: ['Navigation'],
			summary: 'Matchmake into a room (default subroom)',
			description: [
				'The 2023 client’s two-segment matchmake. Resolves the room from D1 so the instance',
				'carries its real scene, and stores it as presence.',
			].join(' '),
			security: AUTHED,
			requestBody: form(MatchmakeRoomRequest, 'Optional JoinMode and AdditionalPlayerIds'),
			parameters: [{ name: 'roomId', in: 'path', required: true, schema: { type: 'string' } }],
			responses: {
				200: json(MatchmakeResponse, 'The instance (or errorCode 20 with null on unknown room)'),
				401: UNAUTHORIZED_RESPONSE,
			},
		}),
		async (c) => {
			const id = await authedId(c)
			if (id === null) return unauthorized(c)
			const { joinMode, additionalPlayerIds } = await readMatchmakeBody(c)
			const instance = await resolveRoomInstance(c, c.req.param('roomId'), joinMode === 2, id)
			if (!instance) return c.json({ errorCode: NO_SUCH_ROOM, roomInstance: null })
			await enterRoom(c, id, instance)
			// Pull the caller's party (AdditionalPlayerIds) into the instance they landed in.
			await inviteParty(c, id, additionalPlayerIds, instance)
			return c.json({ errorCode: 0, roomInstance: instance })
		}
	)
	.post(
		'/matchmake/:room',
		describeRoute({
			tags: ['Navigation'],
			summary: 'Matchmake into a room by id or name',
			description: [
				'Single-segment matchmake. `dorm` → the player’s personal dorm; otherwise resolves',
				'the room by id or name. (Note: this dorm keyword is `dorm`, while goto/room uses',
				'`dormroom`.)',
			].join(' '),
			security: AUTHED,
			requestBody: form(JoinModeRequest, 'Optional JoinMode'),
			parameters: [
				{
					name: 'room',
					in: 'path',
					required: true,
					description: 'Room id, room name, or `dorm`',
					schema: { type: 'string' },
				},
			],
			responses: {
				200: json(MatchmakeResponse, 'The instance (or errorCode 20 with null on unknown room)'),
				401: UNAUTHORIZED_RESPONSE,
			},
		}),
		async (c) => {
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
		}
	)

	// Offline dorm — also persisted as presence so the heartbeat stays in sync.
	.post(
		'/goto/none',
		describeRoute({
			tags: ['Navigation'],
			summary: 'Go to the dorm',
			description: [
				'Authed → the player’s personal dorm (persisted as presence); unauthenticated → the',
				'shared offline dorm. Unlike matchmake/none, this always goes to the dorm.',
			].join(' '),
			responses: { 200: json(MatchmakeResponse, 'The dorm instance') },
		}),
		async (c) => {
			const id = await authedId(c)
			// Authed → their personal dorm; unauthenticated → the offline dorm.
			const instance = id !== null ? await playerDormInstance(c, id) : dormRoomInstance()
			if (id !== null) await enterRoom(c, id, instance)
			return c.json({ errorCode: 0, roomInstance: instance })
		}
	)

	// Region ping reports — accept-and-ack (the reference returns Ok()).
	.put(
		'/player/photonregionpings',
		describeRoute({
			tags: ['Presence'],
			summary: 'Photon region pings (no-op ack)',
			description: 'Region latency report; accepted and ignored.',
			responses: { 200: EMPTY_OK },
		}),
		(c) => c.body(null, 200)
	)
	.put(
		'/player/gameserverregionpings',
		describeRoute({
			tags: ['Presence'],
			summary: 'Game-server region pings (no-op ack)',
			description: 'Region latency report; accepted and ignored.',
			responses: { 200: EMPTY_OK },
		}),
		(c) => c.body(null, 200)
	)

	// ---- Social --------------------------------------------------------------
	// Invite a player to join the caller in their room instance. The caller is the
	// inviter (from the Bearer token); the form carries the target `playerId` and the
	// `roomInstanceId` they're being invited into. Delivers a game-invite Message to the
	// target over the notify hub as a MessageReceived frame — the client renders the
	// join prompt from it. When the room instance resolves, its RoomId rides along on the
	// message so the client knows which room the invite points at. Always acks 200 (a bad
	// playerId is a 400, a missing token a 401); hub delivery is best-effort, so a target
	// who's offline simply has the frame queued (or dropped) without failing the invite.
	.post(
		'/invite',
		describeRoute({
			tags: ['Social'],
			summary: 'Invite a player into the caller’s room instance',
			description: [
				'Sends a game invite from the caller (the Bearer token) to `playerId` for',
				'`roomInstanceId`. Delivered to the target over the notify hub as a `MessageReceived`',
				'notification carrying a game-invite `Message`; the resolved instance’s `RoomId` rides',
				'on the message. Acks 200 (bad `playerId` → 400); hub delivery is best-effort.',
			].join(' '),
			security: AUTHED,
			requestBody: form(InviteRequest, 'The target player and the room instance'),
			responses: {
				200: EMPTY_OK,
				400: { description: 'Missing, non-numeric, or zero playerId (empty body)' },
				401: UNAUTHORIZED_RESPONSE,
			},
		}),
		async (c) => {
			const id = await authedId(c)
			if (id === null) return unauthorized(c)

			const body = await c.req.parseBody().catch(() => ({}) as Record<string, unknown>)
			const str = (v: unknown) => (typeof v === 'string' ? v : '')
			const toPlayerId = Number.parseInt(str(body.playerId), 10)
			// A missing or zero target is a bad request (mirrors the reference's guard).
			if (Number.isNaN(toPlayerId) || toPlayerId === 0) return c.body(null, 400)

			const roomInstanceIdStr = str(body.roomInstanceId)
			const roomInstanceId = Number.parseInt(roomInstanceIdStr, 10)

			// Resolve the instance to stamp the invite's RoomId — the client reads it to know
			// which room the invite points at. A missing/unknown instance just leaves RoomId
			// null (buildNotificationPayload drops it from the frame), as the reference does.
			let roomId: number | null = null
			if (!Number.isNaN(roomInstanceId) && roomInstanceId > 0) {
				const instance = await getRoomInstance(c.env.DB, roomInstanceId)
				if (instance) roomId = instance.roomId
			}

			await sendGameInvite(c, id, toPlayerId, roomInstanceIdStr, roomId)
			return c.body(null, 200)
		}
	)

	// ---- Room instance -------------------------------------------------------
	.post(
		'/roominstance/:id/reportjoinresult',
		describeRoute({
			tags: ['Room instance'],
			summary: 'Report join result (no-op ack)',
			description: 'The client reports how a join went; accepted and ignored.',
			parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
			responses: { 200: EMPTY_OK },
		}),
		(c) => c.body(null, 200)
	)

	// The room owner flips the instance's in-progress flag once the session starts
	// (e.g. a game round begins). Body is a form post: `inProgress=True|False`.
	.put(
		'/roominstance/:id/inprogress',
		describeRoute({
			tags: ['Room instance'],
			summary: 'Set instance in-progress flag',
			description: [
				'The room owner flips the instance’s in-progress flag when a session starts (e.g. a',
				'round begins). Body is `inProgress=True|False`.',
			].join(' '),
			security: AUTHED,
			requestBody: form(InProgressRequest, 'The inProgress flag'),
			parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
			responses: {
				200: EMPTY_OK,
				401: UNAUTHORIZED_RESPONSE,
				404: { description: 'Non-numeric id or no such instance (empty body)' },
			},
		}),
		async (c) => {
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
		}
	)

	// The room's live instances — the owner's view of active sessions of their room.
	// Auth-gated (401) and owner/co-owner-only (403): the caller must be the room's
	// creator or hold a Creator/CoOwner role on it. Unknown room → 404. Returns the
	// bare RoomInstance DTO array (empty when the room has no live instances).
	.get(
		'/room/:roomId{[0-9]+}/instances',
		describeRoute({
			tags: ['Room instance'],
			summary: 'A room’s live instances',
			description: [
				'The owner’s view of active sessions of their room. Auth-gated and gated to the',
				'room’s creator or a co-owner (403 otherwise). Unknown room → 404.',
			].join(' '),
			security: AUTHED,
			parameters: [
				{
					name: 'roomId',
					in: 'path',
					required: true,
					description: 'Room id (digits only)',
					schema: { type: 'string', pattern: '^[0-9]+$' },
				},
			],
			responses: {
				200: json(RoomInstanceDto.array(), 'Live instances (empty when none)'),
				401: UNAUTHORIZED_RESPONSE,
				403: { description: 'Not the room’s creator or a co-owner (empty body)' },
				404: { description: 'No such room (empty body)' },
			},
		}),
		async (c) => {
			const id = await authedId(c)
			if (id === null) return unauthorized(c)

			const roomId = Number.parseInt(c.req.param('roomId'), 10)
			const room = await getRoomById(c.env.DB, roomId)
			if (!room) return c.body(null, 404)
			// The room's creator *or* a co-owner (Role 30) may see its live instances —
			// same owner-or-co-owner gate the rooms worker uses for room-admin actions.
			if (!canManageRoom(room, id)) return c.body(null, 403)

			return c.json(await getRoomInstancesByRoom(c.env.DB, roomId))
		}
	)

	// Rooms flagged as needing a developer/moderator to spawn in. No such queue
	// yet → empty list.
	.get(
		'/rooms/requiring/developer',
		describeRoute({
			tags: ['Room instance'],
			summary: 'Rooms requiring a developer',
			description: 'Rooms flagged as needing a developer/moderator to spawn in. No queue yet → [].',
			responses: { 200: json(RoomInstanceDto.array(), 'Always empty for now') },
		}),
		(c) => c.json([])
	)

	// Rooms flagged as requiring an RR+ subscription. No such queue yet → empty list.
	.get(
		'/rooms/requiring/rrplus',
		describeRoute({
			tags: ['Room instance'],
			summary: 'Rooms requiring RR+',
			description: 'Rooms flagged as requiring an RR+ subscription. No queue yet → [].',
			responses: { 200: json(RoomInstanceDto.array(), 'Always empty for now') },
		}),
		(c) => c.json([])
	)

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

// The generated spec. Documentation only — no request is validated against it (see
// openapi.ts). `hide: true` keeps this route out of its own output. Registered on
// `app` before it's wrapped in the exported handler below.
app.get(
	'/openapi.json',
	describeRoute({ hide: true }),
	withCleanSpec(
		openAPIRouteHandler(app, {
			documentation: {
				info: {
					title: 'recflare match',
					version: '1.0.0',
					description: [
						'Matchmaking and presence for recflare, a private-server reimplementation of the Rec',
						'Room backend. Rooms and room instances are D1-backed (matchmaking finds or creates a',
						'`room_instance` per session); presence — the instance each player is currently in —',
						'lives in the shared `presence` table and expires on a TTL. A cron sweep clears',
						'expired presence and frees up instances a crashed player never left.',
					].join('\n'),
				},
				servers: [{ url: 'https://match.recflare.net', description: 'Production' }],
				components: {
					securitySchemes: {
						bearerAuth: {
							type: 'http',
							scheme: 'bearer',
							bearerFormat: 'JWT',
							description: 'An `access_token` from the auth worker’s `POST /connect/token`.',
						},
					},
				},
			},
		})
	)
)

// The HTTP surface is a standard Hono app, exported by name so it can be mounted
// uniformly like every other worker (e.g. by a combined/facade worker). The cron
// that sweeps expired presence is exported alongside it.
export { app }

export const scheduled: ExportedHandlerScheduledHandler<Env> = (_controller, env, ctx) => {
	ctx.waitUntil(sweepExpiredPresence(env))
}

// Standalone entry: a Worker only runs `scheduled` when it's on the default export,
// so match keeps the object form the runtime requires to fire its `*/5 * * * *` cron.
export default { fetch: app.fetch, scheduled } satisfies ExportedHandler<Env>
