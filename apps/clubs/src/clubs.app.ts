import { Hono } from 'hono'
import { useWorkersLogger } from 'workers-tagged-logger'

import { withNotFound, withOnError } from '@repo/hono-helpers'

import { validateAndGetAccountId } from './jwt'

import type { Context } from 'hono'
import type { App } from './context'

/**
 * The only endpoint is auth-gated and returns 404 unconditionally — no DB
 * binding involved.
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

	// Auth-gated → 401 without a valid token. A bare 404 here makes the client
	// treat it as an error, so we return an empty object stub.
	.get('/club/home/me', async (c) => {
		const id = await authedId(c)
		if (id === null) return c.body(null, 401)
		return c.json({})
	})

	// A real Rec Room client endpoint with no backing implementation yet. The
	// client calls it on the clubs host at /subscription/mine/member (no /club
	// prefix) and sends no auth header, so it isn't gated. Returns an empty
	// array = no club subscription memberships (the client chokes on null).
	.get('/subscription/mine/member', (c) => c.json([]))

	// Details for a given subscription. The client deserializes this into an
	// object, so it must return `{}` (not `[]`).
	.get('/subscription/details/:subscription', (c) => c.json({}))

	// The player's clubs that have unread announcements (MyClubsWithUnread-
	// Announcements). No DB → empty list.
	.get('/announcements/v2/mine/unread', (c) => c.json([]))

	// The clubs the player is a member of (GetMyMembershipClubs). No DB → empty.
	.get('/club/mine/member', (c) => c.json([]))

export default app
