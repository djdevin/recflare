import { Hono } from 'hono'
import { useWorkersLogger } from 'workers-tagged-logger'

import { logger, withNotFound, withOnError } from '@repo/hono-helpers'

import { generateToken, TOKEN_TTL_SECONDS } from './jwt'

import type { App } from './context'

/** OAuth scopes granted by `/connect/token`. */
const TOKEN_SCOPE =
	'offline_access profile rn rn.accounts rn.accounts.gc rn.api rn.chat rn.clubs rn.commerce rn.match.read rn.match.write rn.notify rn.rooms rn.storage'

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
		let accountId = '1'
		let platformId = ''
		// `platform` is never populated from the body in the C# source either.
		const platform = ''

		const body = await c.req.parseBody().catch(() => ({}) as Record<string, unknown>)
		console.log(body)

		const accessToken = await generateToken(accountId, platformId, platform)

		// TODO: once a DB binding exists, remove any RoomInstance owned by accountId.

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
