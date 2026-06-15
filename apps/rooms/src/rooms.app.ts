import { Hono } from 'hono'
import { useWorkersLogger } from 'workers-tagged-logger'

import { withNotFound, withOnError } from '@repo/hono-helpers'

import type { App } from './context'

/**
 * Ported from the C# `RoomsController`. The C# backs these with EF Core
 * (`AppDbContext`); there's no DB binding yet, so room lookups synthesize the
 * same shape `BuildRoomResponse` produces. Responses are PascalCase — the C#
 * sets `PropertyNamingPolicy = null` and the anonymous response object uses
 * PascalCase member names (see JSON/ownedrooms.json).
 *
 * The class `[Route("rooms")]` prefix maps to this worker's subdomain, so the
 * method routes are served bare (e.g. `/rooms/{id}`, not `/rooms/rooms/{id}`).
 */

/**
 * Build the full room payload the C# `BuildRoomResponse` returns. With no DB,
 * room 1 is the dorm (matching JSON/ownedrooms.json) and any other id gets a
 * generic published room so the client can still resolve and load it.
 */
/** Unity scene id for the dorm (also the matchmake/heartbeat instance location). */
const DORM_SCENE_ID = '76d98498-60a1-430c-ab76-b54a29b7a163'

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

function buildRoomResponse(roomId: number) {
	const isDorm = roomId === 1
	return {
		RoomId: roomId,
		Name: isDorm ? 'DormRoom' : `Room${roomId}`,
		Description: isDorm ? 'Your private room' : '',
		CreatorAccountId: 1,
		ImageName: 'DefaultRoomImage.jpg',
		State: 0,
		Accessibility: 0,
		SupportsLevelVoting: false,
		IsRRO: false,
		IsDorm: isDorm,
		CloningAllowed: false,
		SupportsVRLow: true,
		SupportsQuest2: true,
		SupportsMobile: true,
		SupportsScreens: true,
		SupportsWalkVR: true,
		SupportsTeleportVR: true,
		SupportsJuniors: true,
		MinLevel: 0,
		WarningMask: 0,
		CustomWarning: null,
		DisableMicAutoMute: false,
		DisableRoomComments: false,
		EncryptVoiceChat: false,
		CreatedAt: '2026-01-18T02:31:37.6171131',
		Stats: { CheerCount: 0, FavoriteCount: 0, VisitorCount: 1, VisitCount: 1 },
		// The client needs a SubRoom (UnitySceneId + DataBlob) to load the scene.
		// The dorm points at the dorm scene; an empty DataBlob loads the default
		// build. Generic rooms have no known scene yet.
		SubRooms: [
			{
				SubRoomId: 1,
				Name: '',
				DataBlob: '',
				IsSandbox: false,
				MaxPlayers: 4,
				Accessibility: 0,
				UnitySceneId: isDorm ? DORM_SCENE_ID : '',
				DataSavedAt: '2026-01-18T02:31:37.6171131',
			},
		],
		Roles: [],
		LoadScreens: [],
		PromoImages: [],
		PromoExternalContent: [],
		Tags: [],
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

	.get('/', (c) => c.json({ service: 'rooms', status: 'ok' }))

	// Room lookup by `id` (comma-separated; first match wins) or `name`. The C#
	// 400s when neither is supplied and returns `{}` when nothing matches.
	.get('/rooms', (c) => {
		const idParam = c.req.query('id')
		const nameParam = c.req.query('name')
		if (!idParam && !nameParam) {
			return c.json("Either 'id' or 'name' query parameter is required", 400)
		}
		if (idParam) {
			const firstId = idParam
				.split(',')
				.map((s) => Number.parseInt(s.trim(), 10))
				.find((n) => !Number.isNaN(n))
			if (firstId === undefined) return c.json({})
			return c.json(buildRoomResponse(firstId))
		}
		// Looked up by name — no DB to resolve it, so synthesize a room 1 (dorm).
		// TODO: resolve the named room once a DB binding exists.
		return c.json(buildRoomResponse(1))
	})

	// Bulk room lookup by `id` (synthesized per id) or `name`. The client calls
	// this bare on the rooms host. We have no named-room data, so a name lookup
	// returns [] — the client treats that as NoSuchRoom (a non-fatal warning),
	// which is the honest answer since we can't actually host that room.
	.get('/rooms/bulk', (c) => {
		const idParam = c.req.query('id')
		const nameParam = c.req.query('name')
		if (!idParam && !nameParam) {
			return c.json("Either 'id' or 'name' query parameter is required", 400)
		}
		if (idParam) {
			const ids = idParam
				.split(',')
				.map((s) => Number.parseInt(s.trim(), 10))
				.filter((n) => !Number.isNaN(n))
			return c.json(ids.map(buildRoomResponse))
		}
		return c.json([])
	})

	// Single room by id. The C# 404s when the row is missing; with no DB we
	// synthesize the room so the client can load it (ignores the include/
	// unityAsset* query params, same as the C#).
	.get('/rooms/:roomId{[0-9]+}', (c) => {
		const roomId = Number.parseInt(c.req.param('roomId'), 10)
		return c.json(buildRoomResponse(roomId))
	})

	// Rooms created by the caller. The C# serves JSON/ownedrooms.json (the dorm).
	.get('/roomserver/rooms/createdby/me', (c) => c.json([buildRoomResponse(1)]))

	// Photon access token + room permissions the client needs to spawn into a
	// room. Without it the player is stuck on a black screen. PhotonAccessToken is
	// empty (the client uses its baked-in Photon credentials); roomInstanceId is
	// our constant 1. The client calls it on the rooms host both bare and under
	// `/roomserver`, so both are registered.
	.get('/photon_access_token', (c) => c.json(photonAccessToken()))
	.get('/roomserver/photon_access_token', (c) => c.json(photonAccessToken()))

export default app
