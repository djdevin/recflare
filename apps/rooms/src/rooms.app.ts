import { Hono } from 'hono'
import { useWorkersLogger } from 'workers-tagged-logger'

import { withNotFound, withOnError } from '@repo/hono-helpers'

import { validateAndGetAccountId } from './jwt'
import {
	cloneRoom,
	getBaseRooms,
	getFavoritedRooms,
	getHotRooms,
	getInteraction,
	getPublicRoomsByCreator,
	getRoomById,
	getRoomByName,
	getRoomsByCreator,
	getRoomsByIds,
	getSimilarRooms,
	getVisitedRooms,
	searchRooms,
	setRoomDescription,
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

/** Room permissions + (empty) Photon token the client needs to spawn into a room. */
function photonAccessToken() {
	const perm = (Permission: string, Role: number, Override: boolean) => ({
		Override,
		Permission,
		Role,
		Type: 0,
		Value: 'True',
	})
	return {
		Permissions: [
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
		],
		PhotonAccessToken: '',
		RoomInstanceId: 1,
	}
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

	// Single room by id. 404 when the room isn't in D1. Ignores the
	// include/unityAsset* query params.
	.get('/rooms/:roomId{[0-9]+}', async (c) => {
		const room = await getRoomById(c.env.DB, Number.parseInt(c.req.param('roomId'), 10))
		return room ? c.json(room) : c.notFound()
	})

	// Photon access token + room permissions the client needs to spawn into a
	// room. The client calls it on the rooms host both bare and under `/roomserver`.
	.get('/photon_access_token', (c) => c.json(photonAccessToken()))
	.get('/roomserver/photon_access_token', (c) => c.json(photonAccessToken()))

export default app
