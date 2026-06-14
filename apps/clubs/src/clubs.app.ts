import { Hono } from 'hono'
import { useWorkersLogger } from 'workers-tagged-logger'

import { withNotFound, withOnError } from '@repo/hono-helpers'

import { validateAndGetAccountId } from './jwt'

import type { Context } from 'hono'
import type { App } from './context'

/**
 * Ported from the C# `ClubsController`. The only endpoint is `[Authorize]` and
 * then returns `Results.NotFound()` unconditionally — no DB binding involved.
 */

/**
 * Resolve the account id from a Bearer token. Returns `null` when the header is
 * missing, the token is invalid, or the `sub` claim isn't an integer.
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

	// [Authorize] → 401 without a valid token. The C# returns NotFound here, but
	// the client treats that 404 as an error, so we return an empty object stub.
	.get('/club/home/me', async (c) => {
		const id = await authedId(c)
		if (id === null) return c.body(null, 401)
		return c.json({})
	})

	// Not present in CannedNet — a real Rec Room client endpoint the C# never
	// implemented. The client calls it on the clubs host at /subscription/mine/member
	// (no /club prefix) and sends no auth header, so it isn't gated. Returns an
	// empty array = no club subscription memberships (the client chokes on null).
	.get('/subscription/mine/member', (c) => c.json([]))

	// Details for a given subscription. Also not in CannedNet; the client
	// deserializes this into an object, so it must return `{}` (not `[]`).
	.get('/subscription/details/:subscription', (c) => c.json({}))

export default app
