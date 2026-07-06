import { Hono } from 'hono'
import { useWorkersLogger } from 'workers-tagged-logger'

import { logger, withNotFound, withOnError } from '@repo/hono-helpers'

import { validateAndGetAccountId } from './jwt'
import {
	addRoomTag,
	cloneRoom,
	findSubRoom,
	getBaseRooms,
	getFavoritedRooms,
	getHotRooms,
	getInteraction,
	getPublicRoomsByCreator,
	getRecommendedRooms,
	getRoomById,
	getRoomByName,
	getRoomsByCreator,
	getRoomsByIds,
	getSimilarRooms,
	removeCheer,
	removeFavorite,
	getVisitedRooms,
	saveSubRoomData,
	searchRooms,
	setRoomDescription,
	setRoomImage,
	setRoomName,
	toggleCheer,
	toggleFavorite,
} from './rooms-db'

import type { Context } from 'hono'
import type { App } from './context'

/**
 * Room server. Rooms are stored in D1 as JSON blobs with generated columns for
 * querying (see rooms-db.ts); the dorm (RoomId 1) is seeded by the migration.
 * Responses are the stored JSON verbatim (PascalCase, client-facing shape).
 *
 * The `rooms` prefix maps to this worker's subdomain, so method
 * routes are served bare. The 2023 client also hits several of these without the
 * `/roomserver` prefix, so both forms are registered.
 */

/** Parse the first valid integer id from a comma-separated `id` query param. */
function firstId(idParam: string): number | undefined {
	return idParam
		.split(',')
		.map((s) => Number.parseInt(s.trim(), 10))
		.find((n) => !Number.isNaN(n))
}

/** Parse all valid integer ids from a comma-separated `id` query param. */
function allIds(idParam: string): number[] {
	return idParam
		.split(',')
		.map((s) => Number.parseInt(s.trim(), 10))
		.filter((n) => !Number.isNaN(n))
}

/** Account ids granted the global (Role 0) maker pen — the reference server's
 * hardcoded moderator/dev accounts. */
const MAKER_PEN_ACCOUNT_IDS = new Set([1, 2, 3])

/** Presence KV key (owned by the `match` worker); keep in sync with match's `presenceKey`. */
const presenceKey = (id: number) => `presence:${id}`

/** The slice of the match worker's presence record we read — the caller's current
 * room instance. Mirrors the reference server's HeartbeatDB row. */
interface PresenceView {
	roomInstance?: { roomInstanceId?: number } | null
}

/**
 * Room permissions + Photon token the client needs to spawn into a room. The
 * global (Role 0) maker pen is added only for the hardcoded dev accounts, and
 * `RoomInstanceId` is the caller's current instance from presence (null when
 * they aren't in one). `PhotonAccessToken` stays empty — the reference server
 * signs it via `ClientSecurity`, whose secret/algorithm we don't have; our
 * Photon setup accepts an empty token.
 */
function photonAccessToken(accountId: number, roomInstanceId: number | null) {
	const perm = (Permission: string, Role: number, Override: boolean) => ({
		Override,
		Permission,
		Role,
		Type: 0,
		Value: 'True',
	})
	const permissions = [
		perm('CAN_USE_ROOM_RESET_BUTTON', 0, true),
		perm('CAN_USE_DELETE_ALL_BUTTON', 0, true),
		perm('CAN_SAVE_INVENTIONS', 0, true),
		perm('CAN_SPAWN_INVENTIONS', 0, true),
		perm('CAN_USE_PLAY_GIZMOS_TOGGLE', 0, true),
		perm('CAN_USE_MAKER_PEN', 30, false),
		perm('CAN_USE_ROOM_RESET_BUTTON', 30, true),
		perm('CAN_USE_DELETE_ALL_BUTTON', 30, true),
		perm('CAN_SAVE_INVENTIONS', 30, true),
		perm('CAN_SPAWN_INVENTIONS', 30, true),
		perm('CAN_USE_PLAY_GIZMOS_TOGGLE', 30, true),
	]
	if (MAKER_PEN_ACCOUNT_IDS.has(accountId)) {
		permissions.unshift(perm('CAN_USE_MAKER_PEN', 0, true))
	}
	return {
		Permissions: permissions,
		PhotonAccessToken: '',
		RoomInstanceId: roomInstanceId,
	}
}

/**
 * Photon access-token handler (served bare and under `/roomserver`). Auth-gated:
 * resolves the caller, reads their current room instance from the shared
 * presence KV, and returns the permissions + token.
 */
async function handlePhotonAccessToken(c: Context<App>) {
	const accountId = await authedAccountId(c)
	if (accountId === null) return unauthorized(c)
	const presence = await c.env.RECFLARE_MATCH_PRESENCE.get<PresenceView>(
		presenceKey(accountId),
		'json'
	)
	const roomInstanceId = presence?.roomInstance?.roomInstanceId ?? null
	return c.json(photonAccessToken(accountId, roomInstanceId))
}

/** The Bearer token's account id (`sub`), or null when there's no valid token. */
async function authedAccountId(c: Context<App>): Promise<number | null> {
	const authHeader = c.req.header('Authorization') ?? ''
	if (!authHeader.toLowerCase().startsWith('bearer ')) return null
	const sub = await validateAndGetAccountId(authHeader.slice('Bearer '.length))
	const id = sub ? Number.parseInt(sub, 10) : Number.NaN
	return Number.isNaN(id) ? null : id
}

/** 401 for the auth-gated `*by/me` endpoints — no stub-account fallback. */
function unauthorized(c: Context<App>) {
	return c.json({ error: 'Unauthorized' }, 401)
}

/**
 * Room role values the reference treats as edit-capable: Creator (255) and
 * CoOwner. (CoOwner's numeric value is a best guess from the seed data — base
 * rooms give the co-owner account Role 30.)
 */
const EDIT_ROLES = new Set([255, 30])

/**
 * Whether an account may edit a room's data — its creator, or a holder of a
 * Creator/CoOwner role. Mirrors the reference's SetRoomData permission check.
 */
function canEditRoomData(room: Record<string, unknown>, accountId: number): boolean {
	if (room.CreatorAccountId === accountId) return true
	const roles = Array.isArray(room.Roles) ? (room.Roles as Array<Record<string, unknown>>) : []
	return roles.some(
		(r) => r.AccountId === accountId && typeof r.Role === 'number' && EDIT_ROLES.has(r.Role)
	)
}

/** The notifications hub is a single global DO instance (see the `notify` worker). */
const HUB_INSTANCE = 'global'

/**
 * Push a RoomUpdate notification to a player after their room changes, mirroring
 * the reference server's `HubSendToPlayer(playerId, NotifFrame("RoomUpdate", room))`.
 * Hub failures are logged and swallowed — the room write has already committed,
 * so a hub hiccup must not fail the request.
 */
async function pushRoomUpdate(
	c: Context<App>,
	playerId: number,
	room: Record<string, unknown>
): Promise<void> {
	try {
		await c.env.RECFLARE_NOTIFICATIONS_HUB.getByName(HUB_INSTANCE).notifyPlayer(
			playerId,
			'RoomUpdate',
			room
		)
	} catch (err) {
		logger.error('failed to push RoomUpdate notification', {
			playerId,
			error: err instanceof Error ? err.message : String(err),
		})
	}
}

/**
 * Room-mutation result envelope: `{ Success, Value, ErrorId, Error }`, always
 * HTTP 200 (the client reads `Success`). `ErrorId`/`Error` are null on success.
 */
function roomResult(
	c: Context<App>,
	fields: { Success: boolean; Value?: unknown; ErrorId?: string; Error?: string }
) {
	return c.json({
		Success: fields.Success,
		Value: fields.Value ?? null,
		ErrorId: fields.ErrorId ?? null,
		Error: fields.Error ?? null,
	})
}

/** Client envelope for room clone results: `{ success, error, value }`. */
function cloneResult(c: Context<App>, value: unknown, error = '') {
	return c.json({ success: error === '', error, value })
}

/** Rooms created/owned by the authed caller (shared by the createdby/ownedby routes). */
async function ownedRooms(c: Context<App>) {
	const accountId = await authedAccountId(c)
	if (accountId === null) return unauthorized(c)
	return c.json(await getRoomsByCreator(c.env.DB, accountId))
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

	.get('/', (c) => c.json({ service: 'rooms', status: 'ok' }))

	// Room lookup by `id` (first match wins) or `name`. 400s when neither is
	// supplied and returns `{}` when nothing matches.
	.get('/rooms', async (c) => {
		const idParam = c.req.query('id')
		const nameParam = c.req.query('name')
		if (!idParam && !nameParam) {
			return c.json("Either 'id' or 'name' query parameter is required", 400)
		}
		if (idParam) {
			const id = firstId(idParam)
			const room = id === undefined ? null : await getRoomById(c.env.DB, id)
			return c.json(room ?? {})
		}
		const room = await getRoomByName(c.env.DB, nameParam ?? '')
		return c.json(room ?? {})
	})

	// Room search: `query` is space/`+`-separated terms — `#tag` matches room tags,
	// plain terms match the name. Public, non-dorm rooms only. Paginated via
	// skip/take. Returns `{ Results, TotalResults }`.
	.get('/rooms/search', async (c) => {
		const query = c.req.query('query') ?? ''
		const skip = Number.parseInt(c.req.query('skip') ?? '0', 10) || 0
		const take = Number.parseInt(c.req.query('take') ?? '30', 10) || 30
		return c.json(await searchRooms(c.env.DB, query, skip, take))
	})

	// "Hot" rooms feed — public, non-dorm rooms ordered by engagement, optionally
	// filtered to a single `tag` (e.g. `rro`). Paginated via skip/take (take
	// defaults to 100). Returns `{ Results, TotalResults }` like search.
	.get('/rooms/hot', async (c) => {
		const tag = c.req.query('tag') ?? ''
		const skip = Number.parseInt(c.req.query('skip') ?? '0', 10) || 0
		const take = Number.parseInt(c.req.query('take') ?? '100', 10) || 100
		return c.json(await getHotRooms(c.env.DB, tag, skip, take))
	})

	// "Base" rooms — template rooms (tagged `base`) the client offers when creating
	// a room. Returned regardless of accessibility. Paginated via skip/take (take
	// defaults to 100). Returns a bare array.
	.get('/rooms/base', async (c) => {
		const skip = Number.parseInt(c.req.query('skip') ?? '0', 10) || 0
		const take = Number.parseInt(c.req.query('take') ?? '100', 10) || 100
		return c.json(await getBaseRooms(c.env.DB, skip, take))
	})

	// Recommended rooms feed — public, non-dorm rooms ranked by engagement, returned
	// as a bare array (the client's recommendation room-source expects a plain list).
	// The `splitTestId`/`splitTestValue` A/B params are accepted and ignored.
	// Paginated via skip/take (take defaults to 100).
	.get('/rooms/recommendations', async (c) => {
		const skip = Number.parseInt(c.req.query('skip') ?? '0', 10) || 0
		const take = Number.parseInt(c.req.query('take') ?? '100', 10) || 100
		return c.json(await getRecommendedRooms(c.env.DB, skip, take))
	})

	// Bulk room lookup by `id` or `name` — returns an array of matched rooms (the
	// client calls this bare on the rooms host). Rooms not in D1 are simply absent
	// from the result; the client treats an empty result as NoSuchRoom.
	.get('/rooms/bulk', async (c) => {
		const idParam = c.req.query('id')
		const nameParam = c.req.query('name')
		if (!idParam && !nameParam) {
			return c.json("Either 'id' or 'name' query parameter is required", 400)
		}
		if (idParam) {
			return c.json(await getRoomsByIds(c.env.DB, allIds(idParam)))
		}
		const room = await getRoomByName(c.env.DB, nameParam ?? '')
		return c.json(room ? [room] : [])
	})

	// Rooms created/owned by the caller (their dorm). The client calls all three.
	// Auth-gated — no token is a 401, never account 1.
	.get('/roomserver/rooms/createdby/me', ownedRooms)
	.get('/rooms/ownedby/me', ownedRooms)
	.get('/rooms/createdby/me', ownedRooms)

	// Public: the rooms a given account owns that are publicly viewable. No auth —
	// returns a bare array (empty when the account owns no public rooms).
	.get('/rooms/ownedby/:accountId{[0-9]+}', async (c) =>
		c.json(await getPublicRoomsByCreator(c.env.DB, Number.parseInt(c.req.param('accountId'), 10)))
	)

	// Rooms the caller has favorited (from the interaction table). Auth-gated.
	// Paginated via skip/take (take defaults to 100). Returns a bare array, like the
	// other room-source `*by/me` lists the client loads.
	.get('/rooms/favoritedby/me', async (c) => {
		const accountId = await authedAccountId(c)
		if (accountId === null) return unauthorized(c)
		const skip = Number.parseInt(c.req.query('skip') ?? '0', 10) || 0
		const take = Number.parseInt(c.req.query('take') ?? '100', 10) || 100
		return c.json(await getFavoritedRooms(c.env.DB, accountId, skip, take))
	})

	// Rooms the caller has visited (interaction rows with a last-visited time).
	// Auth-gated. Paginated via skip/take (take defaults to 100). Returns a bare array.
	.get('/rooms/visitedby/me', async (c) => {
		const accountId = await authedAccountId(c)
		if (accountId === null) return unauthorized(c)
		const skip = Number.parseInt(c.req.query('skip') ?? '0', 10) || 0
		const take = Number.parseInt(c.req.query('take') ?? '100', 10) || 100
		return c.json(await getVisitedRooms(c.env.DB, accountId, skip, take))
	})

	// The current player's interaction state with a room (cheered/favorited/last
	// visited), read from the `interaction` table. Auth-gated.
	.get('/rooms/:roomId{[0-9]+}/interactionby/me', async (c) => {
		const accountId = await authedAccountId(c)
		if (accountId === null) return unauthorized(c)
		const interaction = await getInteraction(
			c.env.DB,
			accountId,
			Number.parseInt(c.req.param('roomId'), 10)
		)
		return c.json({ ...interaction, LastVisitedAt: new Date().toISOString() })
	})

	// Toggle the player's cheer/favorite on a room. Both are auth-gated PUTs that
	// flip the stored flag and return the updated interaction.
	.put('/rooms/:roomId{[0-9]+}/interactionby/me/cheer', async (c) => {
		const accountId = await authedAccountId(c)
		if (accountId === null) return unauthorized(c)
		const interaction = await toggleCheer(
			c.env.DB,
			accountId,
			Number.parseInt(c.req.param('roomId'), 10)
		)
		return c.json({ ...interaction, LastVisitedAt: new Date().toISOString() })
	})
	// Explicitly un-cheer a room (DELETE clears the cheer, vs the PUT toggle).
	// Auth-gated; idempotent — un-cheering when there's no cheer is a no-op.
	.delete('/rooms/:roomId{[0-9]+}/interactionby/me/cheer', async (c) => {
		const accountId = await authedAccountId(c)
		if (accountId === null) return unauthorized(c)
		const interaction = await removeCheer(
			c.env.DB,
			accountId,
			Number.parseInt(c.req.param('roomId'), 10)
		)
		return c.json({ ...interaction, LastVisitedAt: new Date().toISOString() })
	})
	.put('/rooms/:roomId{[0-9]+}/interactionby/me/favorite', async (c) => {
		const accountId = await authedAccountId(c)
		if (accountId === null) return unauthorized(c)
		const interaction = await toggleFavorite(
			c.env.DB,
			accountId,
			Number.parseInt(c.req.param('roomId'), 10)
		)
		return c.json({ ...interaction, LastVisitedAt: new Date().toISOString() })
	})
	// Explicitly un-favorite a room (DELETE clears the favorite, vs the PUT toggle).
	// Auth-gated; idempotent — un-favoriting when there's no favorite is a no-op.
	.delete('/rooms/:roomId{[0-9]+}/interactionby/me/favorite', async (c) => {
		const accountId = await authedAccountId(c)
		if (accountId === null) return unauthorized(c)
		const interaction = await removeFavorite(
			c.env.DB,
			accountId,
			Number.parseInt(c.req.param('roomId'), 10)
		)
		return c.json({ ...interaction, LastVisitedAt: new Date().toISOString() })
	})

	// Clone a room into a new one owned by the caller, using the `name` form field
	// (also accepted as a query param). Auth is required — no valid token is a 401,
	// with no stub-account fallback. Returns the `{ success, error, value }` envelope
	// the client expects; business failures are 200 with success:false.
	.post('/rooms/:roomId{[0-9]+}/clone', async (c) => {
		const accountId = await authedAccountId(c)
		if (accountId === null) {
			return c.json({ success: false, error: 'Unauthorized', value: null }, 401)
		}

		const body = (await c.req.parseBody().catch(() => ({}))) as Record<string, unknown>
		const raw = body.name ?? c.req.query('name') ?? ''
		const name = typeof raw === 'string' ? raw.trim() : ''

		if (name === '') return cloneResult(c, null, 'You must enter a name for your room.')
		if (await getRoomByName(c.env.DB, name)) {
			return cloneResult(c, null, 'A room with that name already exists!')
		}
		const room = await cloneRoom(
			c.env.DB,
			Number.parseInt(c.req.param('roomId'), 10),
			name,
			accountId
		)
		if (!room) return cloneResult(c, null, "You can't clone this room!")
		return cloneResult(c, room)
	})

	// Update a room's description. Auth-gated (401) and owner-only. Business results
	// use the `{ Success, Value, ErrorId, Error }` envelope at HTTP 200.
	.put('/rooms/:roomId{[0-9]+}/description', async (c) => {
		const accountId = await authedAccountId(c)
		if (accountId === null) return unauthorized(c)

		const roomId = Number.parseInt(c.req.param('roomId'), 10)
		const room = await getRoomById(c.env.DB, roomId)
		if (!room) {
			return roomResult(c, {
				Success: false,
				ErrorId: 'Rooms.DoesntExist',
				Error: 'This room does not exist!',
			})
		}
		if (room.CreatorAccountId !== accountId) {
			return roomResult(c, {
				Success: false,
				ErrorId: 'Rooms.NotOwner',
				Error: 'You are not the owner of this room!',
			})
		}

		const body = (await c.req.parseBody().catch(() => ({}))) as Record<string, unknown>
		const description = typeof body.description === 'string' ? body.description : ''
		await setRoomDescription(c.env.DB, roomId, description)
		return roomResult(c, { Success: true })
	})

	// Rename a room. Auth-gated (401) and owner-only; the new name must be non-empty
	// and not already taken by another room. Business results use the
	// `{ Success, Value, ErrorId, Error }` envelope at HTTP 200.
	// NOTE: the ErrorId strings (besides Rooms.DoesntExist) are best guesses.
	.put('/rooms/:roomId{[0-9]+}/name', async (c) => {
		const accountId = await authedAccountId(c)
		if (accountId === null) return unauthorized(c)

		const roomId = Number.parseInt(c.req.param('roomId'), 10)
		const room = await getRoomById(c.env.DB, roomId)
		if (!room) {
			return roomResult(c, {
				Success: false,
				ErrorId: 'Rooms.DoesntExist',
				Error: 'This room does not exist!',
			})
		}
		if (room.CreatorAccountId !== accountId) {
			return roomResult(c, {
				Success: false,
				ErrorId: 'Rooms.NotOwner',
				Error: 'You are not the owner of this room!',
			})
		}

		const body = (await c.req.parseBody().catch(() => ({}))) as Record<string, unknown>
		const name = typeof body.name === 'string' ? body.name.trim() : ''
		if (name === '') {
			return roomResult(c, {
				Success: false,
				ErrorId: 'Rooms.InvalidName',
				Error: 'You must enter a name for your room!',
			})
		}

		// Reject if a different room already uses this name (case-insensitive).
		const existing = await getRoomByName(c.env.DB, name)
		if (existing && existing.RoomId !== roomId) {
			return roomResult(c, {
				Success: false,
				ErrorId: 'Rooms.AlreadyExists',
				Error: 'A room with that name already exists!',
			})
		}

		await setRoomName(c.env.DB, roomId, name)
		return roomResult(c, { Success: true })
	})

	// Add a tag to a room. Auth-gated (401) and owner-only. Body is the `tag` form
	// field; the tag is added as a user tag (Type 0), deduped case-insensitively.
	// Business results use the `{ Success, Value, ErrorId, Error }` envelope at 200.
	.put('/rooms/:roomId{[0-9]+}/tags', async (c) => {
		const accountId = await authedAccountId(c)
		if (accountId === null) return unauthorized(c)

		const roomId = Number.parseInt(c.req.param('roomId'), 10)
		const room = await getRoomById(c.env.DB, roomId)
		if (!room) {
			return roomResult(c, {
				Success: false,
				ErrorId: 'Rooms.DoesntExist',
				Error: 'This room does not exist!',
			})
		}
		if (room.CreatorAccountId !== accountId) {
			return roomResult(c, {
				Success: false,
				ErrorId: 'Rooms.NotOwner',
				Error: 'You are not the owner of this room!',
			})
		}

		const body = (await c.req.parseBody().catch(() => ({}))) as Record<string, unknown>
		const tag = typeof body.tag === 'string' ? body.tag.trim() : ''
		if (tag === '') {
			return roomResult(c, {
				Success: false,
				ErrorId: 'Rooms.InvalidTag',
				Error: 'You must provide a tag!',
			})
		}
		await addRoomTag(c.env.DB, roomId, room, tag)
		return roomResult(c, { Success: true })
	})

	// Set a room's image. Auth-gated (401) and owner-only. Body is the `imageName`
	// form field (a key from the storage/image upload). Business results use the
	// `{ Success, Value, ErrorId, Error }` envelope at HTTP 200.
	.put('/rooms/:roomId{[0-9]+}/image', async (c) => {
		const accountId = await authedAccountId(c)
		if (accountId === null) return unauthorized(c)

		const roomId = Number.parseInt(c.req.param('roomId'), 10)
		const room = await getRoomById(c.env.DB, roomId)
		if (!room) {
			return roomResult(c, {
				Success: false,
				ErrorId: 'Rooms.DoesntExist',
				Error: 'This room does not exist!',
			})
		}
		if (room.CreatorAccountId !== accountId) {
			return roomResult(c, {
				Success: false,
				ErrorId: 'Rooms.NotOwner',
				Error: 'You are not the owner of this room!',
			})
		}

		const body = (await c.req.parseBody().catch(() => ({}))) as Record<string, unknown>
		const imageName = typeof body.imageName === 'string' ? body.imageName.trim() : ''
		if (imageName === '') {
			return roomResult(c, {
				Success: false,
				ErrorId: 'Rooms.InvalidImage',
				Error: 'You must provide an image!',
			})
		}
		await setRoomImage(c.env.DB, roomId, imageName)
		// Notify the owner so their client refreshes the room (RoomUpdate carries the
		// updated room). The reference sends the post-update room, so merge the change.
		await pushRoomUpdate(c, accountId, { ...room, ImageName: imageName })
		return roomResult(c, { Success: true })
	})

	// A subroom's data descriptor (the SubRoom object from the room's SubRooms
	// array). Public — the client fetches it while loading the room. 404 when the
	// room or subroom is unknown.
	.get('/rooms/:roomId{[0-9]+}/subrooms/:subRoomId{[0-9]+}/data', async (c) => {
		const roomId = Number.parseInt(c.req.param('roomId'), 10)
		const subRoomId = Number.parseInt(c.req.param('subRoomId'), 10)
		const room = await getRoomById(c.env.DB, roomId)
		const sub = room ? findSubRoom(room, subRoomId) : undefined
		return sub ? c.json(sub) : c.notFound()
	})

	// Save a subroom's data (room save). Auth-gated (401 with empty body). Editable
	// by the room creator or a Creator/CoOwner role holder. Points the subroom at
	// the uploaded data blobs and records the room-level save fields, notifies the
	// owner, and returns the updated ROOM in the lowercase `{ success, error, value }`
	// envelope the reference's SetRoomData uses.
	.post('/rooms/:roomId{[0-9]+}/subrooms/:subRoomId{[0-9]+}/data', async (c) => {
		const accountId = await authedAccountId(c)
		if (accountId === null) return c.body(null, 401)

		const roomId = Number.parseInt(c.req.param('roomId'), 10)
		const subRoomId = Number.parseInt(c.req.param('subRoomId'), 10)

		const room = await getRoomById(c.env.DB, roomId)
		if (!room) {
			return roomResult(c, {
				Success: false,
				ErrorId: 'Rooms.DoesntExist',
				Error: 'This room does not exist!',
			})
		}
		if (!canEditRoomData(room, accountId)) {
			return roomResult(c, {
				Success: false,
				ErrorId: 'Rooms.PermissionDenied',
				Error: 'You are not the owner of this room!',
			})
		}

		const body = (await c.req.json().catch(() => ({}))) as {
			RoomData?: { Filename?: string }
			SubRoomData?: { Filename?: string }
			Description?: string
			PersistenceVersion?: number
			InventionUsage?: string
		}

		const updated = await saveSubRoomData(c.env.DB, roomId, subRoomId, accountId, {
			subRoomDataFilename: body.SubRoomData?.Filename,
			roomDataFilename: body.RoomData?.Filename,
			description: typeof body.Description === 'string' ? body.Description : undefined,
			persistenceVersion:
				typeof body.PersistenceVersion === 'number' ? body.PersistenceVersion : undefined,
			inventionUsage: typeof body.InventionUsage === 'string' ? body.InventionUsage : undefined,
		})
		if (!updated) {
			return roomResult(c, {
				Success: false,
				ErrorId: 'Rooms.DoesntExist',
				Error: 'This room does not exist!',
			})
		}

		// RoomUpdate carries the full room, but the HTTP response is the saved SUBROOM
		// itself — no envelope. The client deserializes the body directly as the subroom.
		await pushRoomUpdate(c, accountId, updated)
		return c.json(findSubRoom(updated, subRoomId) ?? {})
	})

	// Rooms similar to the given room (sharing tags). Paginated via skip/take (take
	// defaults to 100). Returns `{ Results, TotalResults }`; empty when the room is
	// unknown/untagged.
	.get('/rooms/:roomId{[0-9]+}/similar', async (c) => {
		const skip = Number.parseInt(c.req.query('skip') ?? '0', 10) || 0
		const take = Number.parseInt(c.req.query('take') ?? '100', 10) || 100
		return c.json(
			await getSimilarRooms(c.env.DB, Number.parseInt(c.req.param('roomId'), 10), skip, take)
		)
	})

	// The caller's per-room player data. Stub → empty blob (client reads `Data`).
	.get('/rooms/:roomId{[0-9]+}/playerdata/me', (c) => c.json({ Data: '' }))

	// Single room by id. 404 when the room isn't in D1. Ignores the
	// include/unityAsset* query params.
	.get('/rooms/:roomId{[0-9]+}', async (c) => {
		const room = await getRoomById(c.env.DB, Number.parseInt(c.req.param('roomId'), 10))
		return room ? c.json(room) : c.notFound()
	})

	// Photon access token + room permissions the client needs to spawn into a
	// room. The client calls it on the rooms host both bare and under `/roomserver`.
	.get('/photon_access_token', handlePhotonAccessToken)
	.get('/roomserver/photon_access_token', handlePhotonAccessToken)

export default app
