import { Hono } from 'hono'
import { useWorkersLogger } from 'workers-tagged-logger'

import { logger, withNotFound, withOnError } from '@repo/hono-helpers'

import { createAccount, getPasswordHash, setPasswordHash } from './accounts-db'
import { generateToken, TOKEN_TTL_SECONDS, validateAndGetAccountId } from './jwt'
import { hashPassword, verifyPassword } from './password'

import type { Context } from 'hono'
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
		Record<string, unknown> | undefined
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

/** The Bearer token's account id (`sub`), or null when there's no valid token. */
async function authedId(c: Context<App>): Promise<number | null> {
	const authHeader = c.req.header('Authorization') ?? ''
	if (!authHeader.toLowerCase().startsWith('bearer ')) return null
	const sub = await validateAndGetAccountId(authHeader.slice('Bearer '.length), c.env.JWT_SECRET)
	const id = sub ? Number.parseInt(sub, 10) : Number.NaN
	return Number.isNaN(id) ? null : id
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

	// Cached logins for a platform id. No CachedLogins storage yet, so there's never
	// a cached account — return []. The client then goes through a fresh login /
	// create_account instead of auto-logging into a stub account.
	.get('/cachedlogin/forplatformid/:platform/:id', (c) => {
		const { platform, id } = c.req.param()
		logger.info('cached login lookup', { platform, id })
		// TODO: query CachedLogins once they're persisted.
		return c.json([])
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
		// auto-assigned random username — players don't choose one initially) and the
		// token's `sub` is its id. Otherwise the request MUST post a valid account_id —
		// never fall back to a stub account (issuing account 1 to anyone would be bad).
		let accountId: string
		if (grantType === 'create_account') {
			const account = await createAccount(c.env.DB, { platforms: platformInt || 0 })
			accountId = String(account.accountId)
			// Place the new player in Orientation (they don't matchmake into it).
			//await placeNewPlayerInOrientation(c.env, account.accountId)
		} else {
			const posted = typeof body.account_id === 'string' ? body.account_id.trim() : ''
			if (!/^\d+$/.test(posted)) {
				return c.json(
					{ error: 'invalid_request', error_description: 'account_id is required' },
					400
				)
			}
			accountId = posted
		}

		const accessToken = await generateToken(accountId, platformId, platform, c.env.JWT_SECRET)

		return c.json({
			access_token: accessToken,
			expires_in: TOKEN_TTL_SECONDS,
			token_type: 'Bearer',
			refresh_token: `${crypto.randomUUID().replace(/-/g, '').toUpperCase()}-1`,
			scope: TOKEN_SCOPE,
			key: '8oQ+e+WQaOBPbEcakhqs3dwZZdOmmyDUmJSD9u4AHMY=',
		})
	})

	// Change the caller's password. Auth-gated. Stores a PBKDF2 hash on the account
	// row (the raw password is never persisted). When the account already has a
	// password, `oldPassword` must match; the first time it's set, `oldPassword` is
	// empty (as the client sends).
	.post('/account/me/changepassword', async (c) => {
		const id = await authedId(c)
		if (id === null) return c.body(null, 401)

		const body = await c.req.parseBody().catch(() => ({}) as Record<string, unknown>)
		const oldPassword = typeof body.oldPassword === 'string' ? body.oldPassword : ''
		const newPassword = typeof body.newPassword === 'string' ? body.newPassword : ''
		if (newPassword === '') {
			return c.json({ success: false, error: 'You must enter a new password.' }, 400)
		}

		const currentHash = await getPasswordHash(c.env.DB, id)
		if (currentHash && !(await verifyPassword(oldPassword, currentHash))) {
			return c.json({ success: false, error: 'Your old password is incorrect.' }, 400)
		}

		const ok = await setPasswordHash(c.env.DB, id, await hashPassword(newPassword))
		if (!ok) return c.body(null, 404)
		return c.json({ success: true })
	})

	// Developer role lookup. No developer role granted by default.
	.get('/role/developer/:id', (c) => {
		const { id } = c.req.param()
		logger.info('developer role lookup', { id })
		return c.json({ success: false })
	})

export default app
