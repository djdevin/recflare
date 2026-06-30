import { Hono } from 'hono'
import { useWorkersLogger } from 'workers-tagged-logger'

import { logger, withNotFound, withOnError } from '@repo/hono-helpers'

import { createAccount } from './accounts-db'
import { generateToken, TOKEN_TTL_SECONDS } from './jwt'

import type { App } from './context'

/** OAuth scopes granted by `/connect/token`. */
const TOKEN_SCOPE =
	'offline_access profile rn rn.accounts rn.accounts.gc rn.api rn.chat rn.clubs rn.commerce rn.match.read rn.match.write rn.notify rn.rooms rn.storage'

/** Platform-type enum names by value, used for the token's `platform` claim. */
const PLATFORM_TYPES: Record<number, string> = {
	[-1]: 'All',
	0: 'Steam',
	1: 'Oculus',
	2: 'PlayStation',
	3: 'Xbox',
	4: 'RecNet',
	5: 'IOS',
	6: 'GooglePlay',
	7: 'Standalone',
	8: 'Pico',
}

/** New players start in the Orientation room (RoomId 13) — the new-user flow. */
const ORIENTATION_ROOM_ID = 13
/**
 * The client loads Orientation locally (no matchmake) and tags its instance with
 * the sentinel id -2. The heartbeat must echo that exact `roomInstanceId` or the
 * client treats presence as out-of-sync and bounces the player to the dorm.
 */
const ORIENTATION_INSTANCE_ID = -2
/** Presence TTL (s) — matches the match worker; refreshed by each heartbeat. */
const PRESENCE_TTL = 900

/**
 * Seed a freshly created account's match presence to the Orientation room. The
 * client is placed into Orientation by its new-user flow without a matchmake
 * call, so the match heartbeat would otherwise report no/stale (dorm) presence
 * and bounce the player out. We write the Orientation instance (built from the
 * shared rooms D1, matching the match worker's `roomInstanceFromRoom` shape) so
 * the heartbeat keeps them there.
 */
async function placeNewPlayerInOrientation(env: App['Bindings'], accountId: number): Promise<void> {
	const row = await env.DB.prepare('SELECT data FROM rooms WHERE room_id = ?1')
		.bind(ORIENTATION_ROOM_ID)
		.first<{ data: string }>()
	if (!row) return

	const room = JSON.parse(row.data) as Record<string, unknown>
	const subRooms = room.SubRooms
	const sub = (Array.isArray(subRooms) ? subRooms[0] : undefined) as
		| Record<string, unknown>
		| undefined
	const str = (v: unknown, fallback = '') => (typeof v === 'string' ? v : fallback)
	const num = (v: unknown, fallback: number) => (typeof v === 'number' ? v : fallback)

	const roomInstance = {
		roomInstanceId: ORIENTATION_INSTANCE_ID,
		roomId: ORIENTATION_ROOM_ID,
		subRoomId: num(sub?.SubRoomId, 1),
		roomInstanceType: 0,
		location: str(sub?.UnitySceneId),
		dataBlob: str(sub?.DataBlob),
		eventId: 0,
		clubId: 0,
		roomCode: '',
		photonRegion: 'us',
		photonRegionId: 'us',
		photonRoomId: `rec.${ORIENTATION_ROOM_ID}`,
		name: `^${str(room.Name, 'Orientation')}`,
		maxCapacity: num(sub?.MaxPlayers, 4),
		isFull: false,
		isPrivate: false,
		isInProgress: false,
		EncryptVoiceChat: false,
	}
	const presence = {
		roomInstance,
		statusVisibility: 0,
		deviceClass: 0,
		vrMovementMode: 1,
		platform: 0,
		appVersion: '20230302',
	}
	await env.RECFLARE_MATCH_PRESENCE.put(`presence:${accountId}`, JSON.stringify(presence), {
		expirationTtl: PRESENCE_TTL,
	})
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

	// EAC challenge — a fresh GUID, JSON-quoted, served as plain text.
	.get('/eac/challenge', (c) => c.text(`"AA=="`))

	// Cached logins for a platform id. No DB binding yet — always empty.
	.get('/cachedlogin/forplatformid/:platform/:id', (c) => {
		const { platform, id } = c.req.param()
		logger.info('cached login lookup', { platform, id })
		// TODO: query CachedLogins once a DB binding exists.
		return c.json([
			{
				accountId: 1,
				platform: '0',
				platformId: '0',
				lastLoginTime: '2026-06-10T00:00:00Z',
				requirePassword: false,
			},
		])
	})

	// Bulk cached-login lookup by platform id (friends resolution). The client
	// POSTs repeated `id=` params on the auth host; no DB → no matches → [].
	.post('/cachedlogin/forplatformids', (c) => c.json([]))

	// OAuth token endpoint — accepts a form-urlencoded body and issues a JWT.
	.post('/connect/token', async (c) => {
		// Reads `grant_type`, `account_id`, `platform_id` and `platform` from the
		// form body.
		const body = await c.req.parseBody().catch(() => ({}) as Record<string, unknown>)
		const grantType = typeof body.grant_type === 'string' ? body.grant_type : ''
		const platformId = typeof body.platform_id === 'string' ? body.platform_id : ''
		// `platform` is the PlatformType int → its enum name (e.g. 0 → "Steam").
		const platformInt = typeof body.platform === 'string' ? Number.parseInt(body.platform, 10) : NaN
		const platform = Number.isNaN(platformInt) ? '' : (PLATFORM_TYPES[platformInt] ?? '')

		// grant_type=create_account mints + persists a brand-new account (with an
		// auto-assigned random username — players don't choose one initially). The
		// token's `sub` is the new account's id. Otherwise use the posted account_id,
		// falling back to "1" (the cachedlogin stub hands the client account 1).
		let accountId: string
		if (grantType === 'create_account') {
			const account = await createAccount(c.env.DB, { Platforms: platformInt || 0 })
			accountId = String(account.AccountId)
			// Place the new player in Orientation (they don't matchmake into it).
			await placeNewPlayerInOrientation(c.env, account.AccountId)
		} else {
			accountId = typeof body.account_id === 'string' && body.account_id ? body.account_id : '1'
		}

		const accessToken = await generateToken(accountId, platformId, platform)

		// TODO: also create the player's dorm on create_account, and remove any
		// RoomInstance owned by accountId on login.

		return c.json({
			access_token: accessToken,
			expires_in: TOKEN_TTL_SECONDS,
			token_type: 'Bearer',
			refresh_token: `${crypto.randomUUID().replace(/-/g, '').toUpperCase()}-1`,
			scope: TOKEN_SCOPE,
			key: '8oQ+e+WQaOBPbEcakhqs3dwZZdOmmyDUmJSD9u4AHMY=',
		})
	})

	// Developer role lookup. Not implemented yet.
	.get('/role/developer/:id', (c) => {
		const { id } = c.req.param()
		logger.info('developer role lookup', { id })
		// TODO: implement
		return c.json({ success: true })
	})

export default app
