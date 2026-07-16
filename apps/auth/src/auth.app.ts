import { Hono } from 'hono'
import { useWorkersLogger } from 'workers-tagged-logger'

import {
	countAccountsByPlatformId,
	countAccountsBySignupIp,
	createAccount,
	getAccount,
	getAccountByUsername,
	getAccountsByPlatformId,
	getPasswordHash,
	hashPassword,
	RoomInstanceType,
	setLastLoginTime,
	setLoginContext,
	setPasswordHash,
	setPresence,
	verifyPassword,
} from '@repo/domain'
import { intVar, logger, withNotFound, withOnError } from '@repo/hono-helpers'
import { generateToken, TOKEN_TTL_SECONDS, validateAndGetAccountId } from '@repo/jwt'

import { consumeRefreshToken, issueRefreshToken } from './refresh-db'
import { verifySteamTicket } from './steam-ticket'

import type { Context } from 'hono'
import type { Account } from '@repo/domain'
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

/**
 * Signup caps, enforced on create_account only (never on login — an existing account
 * always stays reachable, however many accounts its owner has since accumulated).
 *
 * Two independent arms, because they fail in opposite ways:
 *  - Per verified platform id (a Steam-proven SteamID64). The sharp one: it can't be
 *    spoofed and can't be reset by changing networks. Only binds on a platform
 *    create_account — the password/anonymous path has no platform identity to count,
 *    so the IP arm is the only thing standing between it and bulk signup.
 *  - Per signup IP. Coarse: households, NAT and shared campus/mobile networks put many
 *    legitimate players behind one address, so this WILL be the arm that produces false
 *    positives. It counts `signupIp` (immutable), so an abuser can't reset their own
 *    count by hopping networks.
 *
 * These are the defaults. An operator overrides either arm with the matching worker var
 * (`MAX_ACCOUNTS_PER_PLATFORM_ID` / `MAX_ACCOUNTS_PER_IP` in wrangler.jsonc `vars`), and
 * setting one to 0 disables that arm entirely — which a small private server that trusts
 * everyone it invites will want, and which the IP arm in particular is worth reaching for
 * if a shared network is being locked out.
 */
const DEFAULT_MAX_ACCOUNTS_PER_PLATFORM_ID = 3
const DEFAULT_MAX_ACCOUNTS_PER_IP = 3

/** New players start in the Orientation room (RoomId 13) — the new-user flow. */
const ORIENTATION_ROOM_ID = 13
/**
 * The client loads Orientation locally (no matchmake) and tags its instance with
 * the sentinel id -2. The heartbeat must echo that exact `roomInstanceId` or the
 * client treats presence as out-of-sync and bounces the player to the dorm.
 */
const ORIENTATION_INSTANCE_ID = -2

/**
 * Seed a freshly created account's match presence to the Orientation room. The
 * client is placed into Orientation by its new-user flow without a matchmake
 * call, so the match heartbeat would otherwise report no/stale (dorm) presence
 * and bounce the player out. We write the Orientation instance (built from the
 * shared rooms D1, matching the match worker's `roomInstanceFromRoom` shape) into
 * the shared `presence` table (see @repo/domain) so the heartbeat keeps them there.
 */
async function placeNewPlayerInOrientation(
	env: App['Bindings'],
	accountId: number,
	deviceClass: number
): Promise<void> {
	const row = await env.DB.prepare('SELECT data FROM room WHERE room_id = ?1')
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
		roomInstanceType: RoomInstanceType.Public,
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
	await setPresence(env.DB, {
		accountId,
		roomInstance,
		statusVisibility: 0,
		deviceClass,
		vrMovementMode: 1,
		platform: 0,
		appVersion: '20230302',
	})
}

/** The Bearer token's account id (`sub`), or null when there's no valid token. */
async function authedId(c: Context<App>): Promise<number | null> {
	return validateAndGetAccountId(c.req.raw, await c.env.JWT_SECRET.get())
}

/**
 * The elevated role names for an account's token `role` claim, derived from its
 * role flags. Base roles (gameClient) are added by generateToken — these are only
 * the operator-granted extras. Order is stable so tokens are deterministic.
 */
function accountRoles(account: Pick<Account, 'isDeveloper' | 'isModerator'> | null): string[] {
	if (!account) return []
	const roles: string[] = []
	if (account.isDeveloper) roles.push('developer')
	if (account.isModerator) roles.push('moderator')
	return roles
}

/**
 * The platform an account's `platformId` belongs to. Nothing defaults the `platform`
 * field (see defaultAccount), so an account can carry a platform identity with no
 * platform recorded — and Steam is the only platform whose identity we can prove, so
 * an unset one *is* Steam.
 */
function accountPlatform(account: Pick<Account, 'platform'>): number {
	return account.platform ?? 0
}

/**
 * Whether an account is the one linked to a given platform identity — the single
 * check behind both the cached-login picker and the `cached_login` grant. It lives in
 * one place on purpose: if the picker offers an account the grant then rejects, the
 * client is handed an `account_id` it can never log into ("no linked account for this
 * platform identity" on every attempt).
 *
 * `platformId` must be the *proven* identity (the SteamID64 from a verified
 * platform_auth ticket), never the client-supplied `platform_id` field.
 */
export function isLinkedToPlatformIdentity(
	account: Pick<Account, 'platform' | 'platformId'>,
	platform: number,
	platformId: string
): boolean {
	if (!account.platformId || platformId === '') return false
	return account.platformId === platformId && accountPlatform(account) === platform
}

/**
 * Project a linked account into the client's CachedLogin DTO — the account-picker
 * entry on the login screen. The client posts the chosen `accountId` back as a
 * `grant_type=cached_login`. `requirePassword` is false because platform ownership
 * (the platform_auth ticket) is the credential for a cached login — no prompt.
 */
function toCachedLogin(account: Account) {
	return {
		platform: accountPlatform(account),
		platformId: account.platformId ?? '',
		accountId: account.accountId,
		lastLoginTime: account.lastLoginTime ?? account.createdAt,
		requirePassword: false,
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

	// EAC challenge — a fresh GUID, JSON-quoted, served as plain text.
	.get('/eac/challenge', (c) => c.text(`"AA=="`))

	// Cached logins for a platform id — the accounts linked to this platform-native
	// id, so the client can offer them on the login screen (and post one back as a
	// cached_login grant). No linked account → [], and the client falls back to a
	// fresh login / create_account.
	.get('/cachedlogin/forplatformid/:platform/:id', async (c) => {
		const { platform, id } = c.req.param()
		logger.info('cached login lookup', { platform, id })
		const platformInt = Number.parseInt(platform, 10)
		const accounts = await getAccountsByPlatformId(c.env.DB, id)
		// Offer only accounts the `cached_login` grant will actually accept — same check.
		return c.json(
			accounts
				.filter((a) => Number.isNaN(platformInt) || isLinkedToPlatformIdentity(a, platformInt, id))
				.map(toCachedLogin)
		)
	})

	// Bulk cached-login lookup by platform id (friends resolution). The client POSTs
	// repeated `id=` params on the auth host; resolve each to its linked accounts.
	.post('/cachedlogin/forplatformids', async (c) => {
		const body = await c.req.parseBody({ all: true }).catch(() => ({}) as Record<string, unknown>)
		const raw = body.id
		const ids = (Array.isArray(raw) ? raw : raw != null ? [raw] : []).map(String)
		const out: Array<ReturnType<typeof toCachedLogin>> = []
		for (const pid of ids) {
			out.push(...(await getAccountsByPlatformId(c.env.DB, pid)).map(toCachedLogin))
		}
		return c.json(out)
	})

	// OAuth token endpoint — accepts a form-urlencoded body and issues a JWT.
	.post('/connect/token', async (c) => {
		// Reads `grant_type`, `account_id`, `platform_id` and `platform` from the
		// form body.
		const body = await c.req.parseBody().catch(() => ({}) as Record<string, unknown>)
		const grantType = typeof body.grant_type === 'string' ? body.grant_type : ''
		// `platform`/`platform_id` come from the body for a fresh login; a refresh
		// grant overrides them below with what was stored when the token was issued.
		let platformId = typeof body.platform_id === 'string' ? body.platform_id : ''
		// `platform` is the PlatformType int → its enum name (e.g. 0 → "Steam").
		const platformInt = typeof body.platform === 'string' ? Number.parseInt(body.platform, 10) : NaN
		let platform = Number.isNaN(platformInt) ? '' : (PLATFORM_TYPES[platformInt] ?? '')

		// The device this login came from. The client posts both on every grant; they're
		// unverified (client-picked) so they're recorded on the account, never trusted as
		// a credential. Stored on account creation AND refreshed on each successful login,
		// so the account's device tracks the player across devices — the raw material for
		// linking accounts that share a device later.
		const deviceId = typeof body.device_id === 'string' ? body.device_id : ''
		const deviceClassInt =
			typeof body.device_class === 'string' ? Number.parseInt(body.device_class, 10) : NaN
		const deviceClass = Number.isNaN(deviceClassInt) ? 0 : deviceClassInt

		// The client's real IP, per Cloudflare (the client can't spoof CF-Connecting-IP —
		// the edge sets it — unlike X-Forwarded-For, which is why we don't read that).
		// Recorded as the immutable `signupIp` at creation and as `lastLoginIp` on every
		// login; both feed the per-IP signup cap. Absent (empty) outside the CF edge.
		const clientIp = c.req.header('cf-connecting-ip') ?? ''

		// A platform-authenticated login proves who you are with the platform itself,
		// and we can ONLY verify Steam (platform 0) — via its Steam-signed platform_auth
		// ticket. So those logins must be Steam:
		//   - cached_login authenticates purely by platform identity → always Steam-only.
		//   - create_account that asserts a platform is rejected unless it's Steam, since
		//     we won't bind an identity we can't prove. (create_account with NO platform
		//     is the password-account path — allowed, but it binds no platformId.)
		// The verified SteamID64 replaces the unauthenticated `platform_id` field and is
		// the ONLY value ever written to an account's `platformId`. Credential (password)
		// and refresh_token grants carry their own credential and aren't gated here.
		let verifiedSteamId: string | null = null
		const platformAsserted = !Number.isNaN(platformInt)
		if (grantType === 'cached_login' || (grantType === 'create_account' && platformAsserted)) {
			if (platformInt !== 0) {
				return c.json(
					{
						error: 'invalid_grant',
						error_description: 'unsupported platform; only Steam can be verified',
					},
					400
				)
			}
			const platformAuth = typeof body.platform_auth === 'string' ? body.platform_auth : ''
			const verified = platformAuth ? await verifySteamTicket(platformAuth) : null
			if (!verified) {
				return c.json(
					{ error: 'invalid_grant', error_description: 'invalid or missing platform_auth ticket' },
					400
				)
			}
			verifiedSteamId = verified.steamId
			platformId = verified.steamId
		}

		// Resolve the account this token is for:
		//  - create_account: mint + persist a brand-new account (auto-assigned random
		//    username — players don't pick one initially); the token's `sub` is its id.
		//    A `password` may be posted to establish the account's login credential.
		//  - refresh_token: redeem a stored (single-use) refresh token for its account +
		//    platform, so an expiring session renews without re-login.
		//  - otherwise: a credential login. The request identifies the account by
		//    `username` (RecRoom's password grant posts the username, not the id) or a
		//    numeric `account_id`, and MUST post the account's correct `password`. An
		//    account with no password set can't be logged into (no credential to verify)
		//    — closing the id/username-only takeover. New accounts establish a password
		//    via create_account or /account/me/changepassword.
		let accountId: string
		if (grantType === 'create_account') {
			// Signup caps. Checked before minting anything, so a rejected signup leaves no
			// account behind. Each arm is skipped when it's disabled (var <= 0) or when its
			// identity is unknown (no verified platform id / no client IP) — an unattributable
			// signup can't be counted against anyone, and lumping them together would lock out
			// real players. The disabled check comes first so a disabled arm costs no D1 read.
			const maxPerPlatformId = intVar(
				c.env.MAX_ACCOUNTS_PER_PLATFORM_ID,
				DEFAULT_MAX_ACCOUNTS_PER_PLATFORM_ID
			)
			const maxPerIp = intVar(c.env.MAX_ACCOUNTS_PER_IP, DEFAULT_MAX_ACCOUNTS_PER_IP)
			if (
				maxPerPlatformId > 0 &&
				verifiedSteamId !== null &&
				(await countAccountsByPlatformId(c.env.DB, verifiedSteamId)) >= maxPerPlatformId
			) {
				logger.info('signup rejected: platform account limit', { platformId: verifiedSteamId })
				return c.json(
					{
						error: 'invalid_grant',
						error_description: 'account limit reached for this platform account',
					},
					400
				)
			}
			if (
				maxPerIp > 0 &&
				clientIp !== '' &&
				(await countAccountsBySignupIp(c.env.DB, clientIp)) >= maxPerIp
			) {
				logger.info('signup rejected: per-IP account limit', { ip: clientIp })
				return c.json(
					{
						error: 'invalid_grant',
						error_description: 'too many accounts created from this network',
					},
					400
				)
			}

			// Bind the platform identity ONLY when a Steam ticket proved it. That bound
			// `platformId` (the SteamID64) is what a later cached login is checked against,
			// so only this Steam user can log back into the account. A password/anonymous
			// create_account (no platform) binds no platformId.
			const account = await createAccount(c.env.DB, {
				platforms: platformInt || 0,
				platform: verifiedSteamId !== null ? 0 : undefined,
				platformId: verifiedSteamId ?? undefined,
				lastLoginTime: new Date().toISOString(),
				deviceId: deviceId || undefined,
				deviceClass: deviceId ? deviceClass : undefined,
				signupIp: clientIp || undefined,
				lastLoginIp: clientIp || undefined,
			})
			accountId = String(account.accountId)
			// Establish the login password when one is posted (raw password never stored).
			const password = typeof body.password === 'string' ? body.password : ''
			if (password !== '') {
				await setPasswordHash(c.env.DB, account.accountId, await hashPassword(password))
			}
			// Place the new player in Orientation (they don't explicitly matchmake into it).
			await placeNewPlayerInOrientation(c.env, account.accountId, deviceClass)
		} else if (grantType === 'refresh_token') {
			const presented = typeof body.refresh_token === 'string' ? body.refresh_token : ''
			const refreshed = presented ? await consumeRefreshToken(c.env.DB, presented) : null
			if (!refreshed) {
				return c.json(
					{ error: 'invalid_grant', error_description: 'refresh_token is invalid or expired' },
					400
				)
			}
			accountId = String(refreshed.accountId)
			platform = refreshed.platform
			platformId = refreshed.platformId
		} else if (grantType === 'cached_login') {
			// Platform-authenticated login into an already-linked account. The client posts
			// the `account_id` it got from /cachedlogin/forplatformid together with the
			// `platform_id` its platform_auth ticket vouches for. Authorize ONLY when that
			// account is linked to exactly this platform identity — this is the check that
			// keeps anyone but platform user `platform_id` out of the account (platform
			// ownership is the credential; no password needed). An account with no stored
			// platform identity can't be cached-logged-into and must use a fresh login.
			//
			// NB: `platform_id` here is the Steam-verified SteamID64 (set from the ticket
			// above), never the client-supplied field. See steam-ticket.ts.
			//
			const postedId = typeof body.account_id === 'string' ? body.account_id.trim() : ''
			const account = /^\d+$/.test(postedId) ? await getAccount(c.env.DB, Number(postedId)) : null
			if (!account || !isLinkedToPlatformIdentity(account, platformInt, platformId)) {
				return c.json(
					{
						error: 'invalid_grant',
						error_description: 'no linked account for this platform identity',
					},
					400
				)
			}
			accountId = String(account.accountId)
			await setLastLoginTime(c.env.DB, account.accountId, new Date().toISOString())
			await setLoginContext(c.env.DB, account.accountId, { deviceId, deviceClass, ip: clientIp })
		} else {
			// Resolve the account from a posted numeric `account_id` or, as RecRoom's
			// password grant sends, a `username` (case-insensitive; trailing whitespace
			// is trimmed off the posted value).
			const postedId = typeof body.account_id === 'string' ? body.account_id.trim() : ''
			const postedUsername = typeof body.username === 'string' ? body.username.trim() : ''
			let resolvedId: number | null = null
			if (/^\d+$/.test(postedId)) {
				resolvedId = Number(postedId)
			} else if (postedUsername !== '') {
				resolvedId = (await getAccountByUsername(c.env.DB, postedUsername))?.accountId ?? null
			}
			if (resolvedId === null) {
				return c.json(
					{ error: 'invalid_request', error_description: 'account_id or username is required' },
					400
				)
			}
			// The account's password MUST be presented and match. An account with no
			// stored hash has no credential to authenticate against, so login is refused
			// — this closes the id/username-only takeover.
			const storedHash = await getPasswordHash(c.env.DB, resolvedId)
			const password = typeof body.password === 'string' ? body.password : ''
			if (!storedHash || !(await verifyPassword(password, storedHash))) {
				return c.json(
					{ error: 'invalid_grant', error_description: 'invalid account_id or password' },
					400
				)
			}
			accountId = String(resolvedId)
			await setLastLoginTime(c.env.DB, resolvedId, new Date().toISOString())
			await setLoginContext(c.env.DB, resolvedId, { deviceId, deviceClass, ip: clientIp })
		}

		// Never sign with an empty key. An empty JWT_SECRET (misconfigured/missing
		// binding) would still yield a well-formed token — but one signed with an empty
		// key, which every worker validates against, so anyone could forge it. Refuse to
		// issue a token at all rather than complete the login with a forgeable credential.
		const jwtSecret = await c.env.JWT_SECRET.get()
		if (jwtSecret === '') {
			logger.error('refusing to issue token: JWT_SECRET is empty')
			return c.json(
				{ error: 'server_error', error_description: 'token signing is not configured' },
				500
			)
		}

		// Stamp the account's elevated roles into the token's `role` claim so the client
		// authorizes developer/moderator powers from the token itself (not just the
		// /role/* lookups). One read of the just-resolved account; roles thus refresh on
		// every login and every refresh_token grant.
		const roleAccount = await getAccount(c.env.DB, Number(accountId))
		const accessToken = await generateToken(
			accountId,
			platformId,
			platform,
			jwtSecret,
			accountRoles(roleAccount)
		)
		// Issue a fresh, persisted refresh token (single-use; the client redeems it via
		// grant_type=refresh_token). A refresh grant thus rotates its token.
		const refreshToken = await issueRefreshToken(c.env.DB, {
			accountId: Number(accountId),
			platform,
			platformId,
		})

		return c.json({
			access_token: accessToken,
			expires_in: TOKEN_TTL_SECONDS,
			token_type: 'Bearer',
			refresh_token: refreshToken,
			scope: TOKEN_SCOPE,
			// @kludge Why is this necessary? Who knows.
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

	// Developer role lookup. Returns a bare JSON boolean (the client reads the body as
	// a bool), and 404s for an unknown player — mirroring the reference API. The role
	// is off by default and only an operator grants it (via `runx admin grant-developer`,
	// which sets the account's isDeveloper flag); it also rides in the token's `role`
	// claim (see accountRoles).
	.get('/role/developer/:id', async (c) => {
		const { id } = c.req.param()
		logger.info('developer role lookup', { id })
		const accountId = Number.parseInt(id, 10)
		const account = Number.isNaN(accountId) ? null : await getAccount(c.env.DB, accountId)
		if (!account) return c.body(null, 404)
		return c.json(account.isDeveloper === true)
	})

	// Moderator role lookup, mirroring developer (bare boolean, 404 for unknown player).
	// Operator-granted only (via `runx admin grant-moderator`); the flag also rides in
	// the token's `role` claim.
	.get('/role/moderator/:id', async (c) => {
		const { id } = c.req.param()
		logger.info('moderator role lookup', { id })
		const accountId = Number.parseInt(id, 10)
		const account = Number.isNaN(accountId) ? null : await getAccount(c.env.DB, accountId)
		if (!account) return c.body(null, 404)
		return c.json(account.isModerator === true)
	})

export default app
