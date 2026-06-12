import { Hono } from 'hono'
import { useWorkersLogger } from 'workers-tagged-logger'

import { withNotFound, withOnError } from '@repo/hono-helpers'

import { validateAndGetAccountId } from './jwt'

import type { Context } from 'hono'
import type { App } from './context'

/**
 * Ported from the C# `AccountsController`. Endpoints that the C# backs with EF
 * Core (`AppDbContext`) are stubbed here — there's no DB binding yet, so reads
 * return synthesized defaults (the C# fills every field with a fallback anyway)
 * and writes accept-and-ack without persisting. Each stub is marked `TODO`.
 *
 * Auth-gated routes still validate the Bearer JWT issued by the `auth` worker.
 */

/** Account shape returned by the public lookup endpoints. */
interface Account {
	AccountId: number
	ProfileImage: string
	IsJunior: boolean
	Platforms: number
	PersonalPronouns: number
	IdentityFlags: number
	Username: string
	DisplayName: string
	CreatedAt: string
}

/**
 * Resolve the account id from a Bearer token, mirroring the repeated
 * auth-header check in the C#. Returns `null` when the header is missing,
 * the token is invalid, or the `sub` claim isn't an integer.
 */
async function authedId(c: Context<App>): Promise<number | null> {
	const authHeader = c.req.header('Authorization') ?? ''
	console.log(authHeader)
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

/** Read a single string field from a form-urlencoded / multipart body. */
async function formField(c: Context<App>, name: string): Promise<string> {
	const body = await c.req.parseBody().catch(() => ({}) as Record<string, unknown>)
	const value = body[name]
	return typeof value === 'string' ? value : ''
}

/**
 * Synthesize an `Account` from an id using the same fallbacks the C# applies
 * when a column is null. Stands in for `db.Accounts.FindAsync(id)`.
 */
function defaultAccount(id: number): Account {
	return {
		AccountId: id,
		ProfileImage: 'DefaultProfileImage.jpg',
		IsJunior: false,
		Platforms: 0,
		PersonalPronouns: 0,
		IdentityFlags: 0,
		Username: `Player${id}`,
		DisplayName: `Player${id}`,
		CreatedAt: new Date().toISOString(),
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

	// Root health check (the C# source returned a placeholder string here).
	.get('/', (c) => c.json({ service: 'accounts', status: 'ok' }))

	// ---- Self account --------------------------------------------------------
	.get('/account/me', async (c) => {
		const id = await authedId(c)
		if (id === null) return unauthorized(c)
		// TODO: load the real account; the C# 404s when the row is missing.
		const account = defaultAccount(id)
		// The C# `SelfAccount` marks `JuniorState` (an enum) and `ParentAccountId`
		// with `[JsonIgnore(WhenWritingNull)]`, so they're OMITTED when null —
		// emitting `"juniorState":null` makes the client's enum parser throw
		// ("Can't parse JSON to Enum format"). `Email`/`Phone`/`Birthday` are kept
		// as null (the C# has no JsonIgnore on those, and they aren't enums).
		return c.json({
			...account,
			ProfileImage: 'hdqeamlcmatc6qzoi2ybgf0ddijjcf.jpg',
			Email: null,
			Phone: null,
			Birthday: null,
			AvailableUsernameChanges: 1,
		})
	})

	// ---- Bulk / single lookup ------------------------------------------------
	// Register the static `bulk` path before the `/account/:id` param route.
	.get('/account/bulk', (c) => {
		// C# reads repeated `id` query params; also accept a comma-separated list.
		const ids = c.req
			.queries('id')
			?.flatMap((v) => v.split(','))
			.map((s) => Number.parseInt(s.trim(), 10))
			.filter((n) => !Number.isNaN(n))
		// TODO: query Accounts for these ids instead of synthesizing.
		return c.json((ids ?? []).map(defaultAccount))
	})

	.get('/account/:id/bio', (c) => {
		const accountId = Number.parseInt(c.req.param('id'), 10)
		if (Number.isNaN(accountId)) return c.body(null, 400)
		// TODO: query PlayerBios; no binding yet so the bio is always empty.
		return c.json({ accountId, bio: '' })
	})

	.get('/account/:id', (c) => {
		const accountId = Number.parseInt(c.req.param('id'), 10)
		if (Number.isNaN(accountId)) return c.body(null, 400)
		// TODO: load the real account; the C# 404s when the row is missing.
		return c.json(defaultAccount(accountId))
	})

	// ---- Create --------------------------------------------------------------
	.post('/account/create', async (c) => {
		// Parsed for fidelity; unused until there's a DB to persist CachedLogins.
		await formField(c, 'platform')
		await formField(c, 'platformId')

		const accountId = Math.floor(Math.random() * (99999 - 10000 + 1)) + 10000
		const account = defaultAccount(accountId)
		// TODO: persist the account + a dorm Room/SubRoom once a DB binding exists.
		return c.json({ success: true, value: account })
	})

	// ---- Parental control ----------------------------------------------------
	.get('/parentalcontrol/me', async (c) => {
		const id = await authedId(c)
		if (id === null) return unauthorized(c)
		return c.json({ accountId: id, disallowInAppPurchases: false })
	})

	// ---- Profile mutations ---------------------------------------------------
	.put('/account/me/displayname', async (c) => {
		const id = await authedId(c)
		if (id === null) return unauthorized(c)
		await formField(c, 'displayName') // TODO: persist on the account row.
		return c.json({ success: true })
	})

	.put('/account/me/username', async (c) => {
		const id = await authedId(c)
		if (id === null) return unauthorized(c)
		await formField(c, 'username') // TODO: persist on the account row.
		return c.json({ success: true })
	})

	.put('/account/me/bio', async (c) => {
		const id = await authedId(c)
		if (id === null) return unauthorized(c)
		await formField(c, 'bio') // TODO: upsert into PlayerBios.
		return c.json({ success: true })
	})

	.put('/account/me/profileimage', async (c) => {
		const id = await authedId(c)
		if (id === null) return unauthorized(c)
		await formField(c, 'imageName') // TODO: persist on the account row.
		return c.json({ success: true })
	})

export default app
