import { Hono } from 'hono'
import { useWorkersLogger } from 'workers-tagged-logger'

import { withNotFound, withOnError } from '@repo/hono-helpers'
import { validateAndGetAccountId } from '@repo/jwt'

import {
	createClub,
	getClub,
	getClubsByCreator,
	getClubsByMember,
	joinClub,
	leaveClub,
} from './clubs-db'

import type { Context } from 'hono'
import type { App } from './context'

/**
 * Resolve the account id from a Bearer token. Returns `null` when the header is
 * missing, the token is invalid, or the `sub` claim isn't an integer.
 */
async function authedId(c: Context<App>): Promise<number | null> {
	return validateAndGetAccountId(c.req.raw, await c.env.JWT_SECRET.get())
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

	// Subscription details for an account (numeric id) — simulated: no club, no subs.
	.get('/subscription/details/:accountId{[0-9]+}', (c) =>
		c.json({
			accountId: Number.parseInt(c.req.param('accountId'), 10),
			clubId: 0,
			subscriberCount: 0,
		})
	)

	// Details for a named subscription (e.g. `rrplus`). The client deserializes this
	// into an object, so it must return `{}` (not `[]`).
	.get('/subscription/details/:subscription', (c) => c.json({}))

	// Subscriber count for an account. No club subscriptions yet → 0.
	.get('/subscription/subscriberCount/:accountId{[0-9]+}', (c) => c.json(0))

	// The player's clubs that have unread announcements (MyClubsWithUnread-
	// Announcements). No announcements backing yet → empty list.
	.get('/announcements/v2/mine/unread', (c) => c.json([]))

	// The clubs the player is a member of (GetMyMembershipClubs). Auth-gated; reads
	// the caller's memberships from `club_member`.
	.get('/club/mine/member', async (c) => {
		const id = await authedId(c)
		if (id === null) return c.body(null, 401)
		return c.json(await getClubsByMember(c.env.DB, id))
	})

	// The clubs the player created (GetMyCreatedClubs). Auth-gated.
	.get('/club/mine/created', async (c) => {
		const id = await authedId(c)
		if (id === null) return c.body(null, 401)
		return c.json(await getClubsByCreator(c.env.DB, id))
	})

	// The set of club category tags a club can be filed under — a fixed list.
	.get('/club/categoryTags', (c) =>
		c.json(['Social', 'Creative', 'Competitive', 'Casual', 'Entertainment'])
	)

	// Create a club owned by the caller. Auth-gated (401). Body carries the club
	// fields (Name required; the rest fall back to the model defaults). The creator
	// is auto-joined as the owner. Returns the new Club.
	.post('/club', async (c) => {
		const id = await authedId(c)
		if (id === null) return c.body(null, 401)

		const body = (await c.req.parseBody().catch(() => ({}))) as Record<string, unknown>
		const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined)
		const int = (v: unknown): number | undefined => {
			const n = typeof v === 'string' ? Number.parseInt(v, 10) : Number.NaN
			return Number.isNaN(n) ? undefined : n
		}
		const bool = (v: unknown): boolean | undefined =>
			typeof v === 'string' ? v.toLowerCase() === 'true' : undefined

		const name = str(body.Name)?.trim() ?? ''
		if (name === '') return c.json({ error: 'You must enter a name for your club.' }, 400)

		const club = await createClub(c.env.DB, id, {
			name,
			description: str(body.Description),
			category: str(body.Category),
			visibility: int(body.Visibility),
			joinability: int(body.Joinability),
			allowJuniors: bool(body.AllowJuniors),
			mainImageName: str(body.MainImageName),
			clubType: int(body.ClubType),
			minLevel: int(body.MinLevel),
		})
		return c.json(club)
	})

	// A single club by id. 404 when the club isn't in the DB. Public.
	.get('/club/:clubId{[0-9]+}', async (c) => {
		const club = await getClub(c.env.DB, Number.parseInt(c.req.param('clubId'), 10))
		return club ? c.json(club) : c.notFound()
	})

	// Join / leave a club (auth-gated, idempotent). Both return the club with its
	// refreshed MemberCount; 404 when the club doesn't exist.
	.post('/club/:clubId{[0-9]+}/join', async (c) => {
		const id = await authedId(c)
		if (id === null) return c.body(null, 401)
		const club = await joinClub(c.env.DB, Number.parseInt(c.req.param('clubId'), 10), id)
		return club ? c.json(club) : c.notFound()
	})
	.post('/club/:clubId{[0-9]+}/leave', async (c) => {
		const id = await authedId(c)
		if (id === null) return c.body(null, 401)
		const club = await leaveClub(c.env.DB, Number.parseInt(c.req.param('clubId'), 10), id)
		return club ? c.json(club) : c.notFound()
	})

export default app
