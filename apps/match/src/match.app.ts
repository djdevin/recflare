import { Hono } from 'hono'
import { useWorkersLogger } from 'workers-tagged-logger'

import { withNotFound, withOnError } from '@repo/hono-helpers'

import type { App } from './context'
import type { Context } from 'hono'
import { validateAndGetAccountId } from './jwt'

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
	.post('/player/login', (c) => c.body(null, 200))

	.get('/player', (c) => {
		// C# loads the account + its active RoomInstance; without a DB binding it
		// always falls through to the JSON/getplayer.json default.
		// TODO: build the per-account payload once a DB binding exists.
		return c.json(DEFAULT_GET_PLAYER)
	})

	.post('/player/heartbeat', async (c) => {
		const id = await authedId(c)
		if (id === null) return unauthorized(c)

		// Body may be a JSON HeartbeatRequest or a form post; only JSON is read.
		const raw = await c.req.text().catch(() => '')
		let hb: HeartbeatRequest = {}
		if (raw.trimStart().startsWith('{')) {
			try {
				hb = JSON.parse(raw) as HeartbeatRequest
			} catch {
				hb = {}
			}
		}

		// TODO: look up the player's active RoomInstance once a DB binding exists.
		return c.json({
			playerId: hb.playerId ? hb.playerId : id,
			statusVisibility: hb.statusVisibility ?? 0,
			deviceClass: hb.deviceClass ?? 0,
			vrMovementMode: hb.vrMovementMode ? hb.vrMovementMode : 1,
			roomInstance: null,
			isOnline: false,
			appVersion: hb.appVersion ?? '',
			platform: hb.platform ?? 0,
		})
	})

	.put('/player/statusvisibility', (c) => c.body(null, 200)) // TODO: add functionality

	// ---- Room navigation -----------------------------------------------------
	.post('/goto/room/:room', async (c) => {
		const id = await authedId(c)
		if (id === null) return unauthorized(c)
		// No Rooms binding → the room can never be found (C# returns NotFound here).
		// TODO: resolve the Room, upsert a RoomInstance, and return it.
		return c.text('Room not found', 404)
	})

	.post('/goto/none', (c) =>
		// Offline dorm — fully static in the C# source.
		c.json({
			errorCode: 0,
			roomInstance: {
				roomInstanceId: 1,
				roomId: 1,
				subRoomId: 1,
				roomInstanceType: 2,
				location: '76d98498-60a1-430c-ab76-b54a29b7a163',
				dataBlob: '',
				eventId: 0,
				clubId: 0,
				photonRegionId: 'us',
				photonRoomId: crypto.randomUUID(),
				name: 'DormRoom',
				maxCapacity: 4,
				isFull: false,
				isPrivate: true,
				isInProgress: false,
				EncryptVoiceChat: false,
			},
		})
	)

	// ---- Room instance -------------------------------------------------------
	.post('/roominstance/:id/reportjoinresult', (c) => c.body(null, 200))

export default app
