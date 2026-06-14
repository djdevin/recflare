import { Hono } from 'hono'
import { useWorkersLogger } from 'workers-tagged-logger'

import { logger, withNotFound, withOnError } from '@repo/hono-helpers'

import { generateToken, TOKEN_TTL_SECONDS } from './jwt'

import type { App } from './context'

/** OAuth scopes granted by `/connect/token`. */
const TOKEN_SCOPE =
	'offline_access profile rn rn.accounts rn.accounts.gc rn.api rn.chat rn.clubs rn.commerce rn.match.read rn.match.write rn.notify rn.rooms rn.storage'

/** C# `PlatformType` enum names by value, used for the token's `platform` claim. */
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

	// OAuth token endpoint — accepts a form-urlencoded body and issues a JWT.
	.post('/connect/token', async (c) => {
		// The C# reads `grant_type`, `account_id`, `platform_id` and `platform` from
		// the form body.
		const body = await c.req.parseBody().catch(() => ({}) as Record<string, unknown>)
		const grantType = typeof body.grant_type === 'string' ? body.grant_type : ''
		const platformId = typeof body.platform_id === 'string' ? body.platform_id : ''
		// `platform` is the PlatformType int → its enum name (e.g. 0 → "Steam").
		const platformInt = typeof body.platform === 'string' ? Number.parseInt(body.platform, 10) : NaN
		const platform = Number.isNaN(platformInt) ? '' : (PLATFORM_TYPES[platformInt] ?? '')

		// grant_type=create_account mints a brand-new account (the C# persists it
		// plus a dorm; with no DB we just allocate a random id — the accounts worker
		// synthesizes the account on demand). Otherwise use the posted account_id,
		// falling back to "1" (the cachedlogin stub hands the client account 1).
		const accountId =
			grantType === 'create_account'
				? String(Math.floor(Math.random() * (99999 - 10000 + 1)) + 10000)
				: typeof body.account_id === 'string' && body.account_id
					? body.account_id
					: '1'

		const accessToken = await generateToken(accountId, platformId, platform)

		// TODO: once a DB binding exists, create the account + dorm on create_account
		// and remove any RoomInstance owned by accountId on login.

		return c.json({
			access_token: accessToken,
			expires_in: TOKEN_TTL_SECONDS,
			token_type: 'Bearer',
			refresh_token: `${crypto.randomUUID().replace(/-/g, '').toUpperCase()}-1`,
			scope: TOKEN_SCOPE,
			key: '8oQ+e+WQaOBPbEcakhqs3dwZZdOmmyDUmJSD9u4AHMY=',
		})
	})

	// Developer role lookup. Not implemented in the C# source either.
	.get('/role/developer/:id', (c) => {
		const { id } = c.req.param()
		logger.info('developer role lookup', { id })
		// TODO: implement
		return c.json({ success: true })
	})

export default app
