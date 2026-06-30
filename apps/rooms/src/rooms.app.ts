import { Hono } from 'hono'
import { useWorkersLogger } from 'workers-tagged-logger'

import { withNotFound, withOnError } from '@repo/hono-helpers'

import { validateAndGetAccountId } from './jwt'
import {
	getInteraction,
	getRoomById,
	getRoomByName,
	getRoomsByCreator,
	getRoomsByIds,
	searchRooms,
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

/** The account whose owned rooms to return: the Bearer token's `sub`, falling
 * back to account 1 (the stub player) when there's no valid token. */
async function ownerId(c: Context<App>): Promise<number> {
	const authHeader = c.req.header('Authorization') ?? ''
	if (authHeader.toLowerCase().startsWith('bearer ')) {
		const sub = await validateAndGetAccountId(authHeader.slice('Bearer '.length))
		const id = sub ? Number.parseInt(sub, 10) : Number.NaN
		if (!Number.isNaN(id)) return id
	}
	return 1
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
	.get('/roomserver/rooms/createdby/me', async (c) =>
		c.json(await getRoomsByCreator(c.env.DB, await ownerId(c)))
	)
	.get('/rooms/ownedby/me', async (c) => c.json(await getRoomsByCreator(c.env.DB, await ownerId(c))))
	.get('/rooms/createdby/me', async (c) => c.json(await getRoomsByCreator(c.env.DB, await ownerId(c))))

	// The current player's interaction state with a room (cheered/favorited/last
	// visited), read from the `interaction` table.
	.get('/rooms/:roomId{[0-9]+}/interactionby/me', async (c) => {
		const interaction = await getInteraction(
			c.env.DB,
			await ownerId(c),
			Number.parseInt(c.req.param('roomId'), 10)
		)
		return c.json({ ...interaction, LastVisitedAt: new Date().toISOString() })
	})

	// Toggle the player's cheer/favorite on a room. Both are PUTs that flip the
	// stored flag and return the updated interaction.
	.put('/rooms/:roomId{[0-9]+}/interactionby/me/cheer', async (c) => {
		const interaction = await toggleCheer(
			c.env.DB,
			await ownerId(c),
			Number.parseInt(c.req.param('roomId'), 10)
		)
		return c.json({ ...interaction, LastVisitedAt: new Date().toISOString() })
	})
	.put('/rooms/:roomId{[0-9]+}/interactionby/me/favorite', async (c) => {
		const interaction = await toggleFavorite(
			c.env.DB,
			await ownerId(c),
			Number.parseInt(c.req.param('roomId'), 10)
		)
		return c.json({ ...interaction, LastVisitedAt: new Date().toISOString() })
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
