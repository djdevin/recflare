import { Hono } from 'hono'
import { useWorkersLogger } from 'workers-tagged-logger'

import { withNotFound, withOnError } from '@repo/hono-helpers'

import { createAccount, defaultAccount, getAccount, getAccountsByIds, updateAccount } from './accounts-db'
import { validateAndGetAccountId } from './jwt'

import type { Context } from 'hono'
import type { App } from './context'

/**
 * Ported from the C# `AccountsController`. Account reads/writes are backed by the
 * shared `accounts` table in D1 (schema owned by the `auth` worker). Accounts not
 * in the table fall back to a synthesized default (the C# fills every column with
 * a fallback anyway). Profile mutations still accept-and-ack (marked `TODO`).
 *
 * Auth-gated routes still validate the Bearer JWT issued by the `auth` worker.
 */

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

/** Read a single string field from a form-urlencoded / multipart body. */
async function formField(c: Context<App>, name: string): Promise<string> {
	const body = await c.req.parseBody().catch(() => ({}) as Record<string, unknown>)
	const value = body[name]
	return typeof value === 'string' ? value : ''
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
		// Load the stored account, falling back to a synthesized default.
		const account = (await getAccount(c.env.DB, id)) ?? defaultAccount(id)
		// The C# `SelfAccount` marks `JuniorState` (an enum) and `ParentAccountId`
		// with `[JsonIgnore(WhenWritingNull)]`, so they're OMITTED when null —
		// emitting `"juniorState":null` makes the client's enum parser throw
		// ("Can't parse JSON to Enum format"). `Email`/`Phone`/`Birthday` are kept
		// as null (the C# has no JsonIgnore on those, and they aren't enums).
		return c.json({
			...account,
			Email: null,
			Phone: null,
			Birthday: null,
			AvailableUsernameChanges: 1,
		})
	})

	// ---- Bulk / single lookup ------------------------------------------------
	// Register the static `bulk` path before the `/account/:id` param route.
	.get('/account/bulk', async (c) => {
		// C# reads repeated `id` query params; also accept a comma-separated list.
		const ids =
			c.req
				.queries('id')
				?.flatMap((v) => v.split(','))
				.map((s) => Number.parseInt(s.trim(), 10))
				.filter((n) => !Number.isNaN(n)) ?? []
		// Resolve stored accounts, synthesizing a default for any id not in the DB
		// so every requested id is present in the response (matches the C#).
		const stored = new Map((await getAccountsByIds(c.env.DB, ids)).map((a) => [a.AccountId, a]))
		return c.json(ids.map((id) => stored.get(id) ?? defaultAccount(id)))
	})

	.get('/account/:id/bio', (c) => {
		const accountId = Number.parseInt(c.req.param('id'), 10)
		if (Number.isNaN(accountId)) return c.body(null, 400)
		// TODO: query PlayerBios; no binding yet so the bio is always empty.
		return c.json({ accountId, bio: '' })
	})

	.get('/account/:id', async (c) => {
		const accountId = Number.parseInt(c.req.param('id'), 10)
		if (Number.isNaN(accountId)) return c.body(null, 400)
		// Load the stored account, falling back to a synthesized default.
		return c.json((await getAccount(c.env.DB, accountId)) ?? defaultAccount(accountId))
	})

	// ---- Create --------------------------------------------------------------
	.post('/account/create', async (c) => {
		// Parsed for fidelity; unused until there's a DB to persist CachedLogins.
		const platform = await formField(c, 'platform')
		await formField(c, 'platformId')

		// Persist a new account with an auto-assigned random username (players
		// don't choose one initially).
		const platforms = Number.parseInt(platform, 10)
		const account = await createAccount(c.env.DB, {
			Platforms: Number.isNaN(platforms) ? 0 : platforms,
		})
		// TODO: also create a dorm Room/SubRoom for the new account.
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
		const imageName = await formField(c, 'imageName')
		if (!imageName) return c.body(null, 400)
		// Persist the new avatar key on the account row (the C# also fires an
		// AccountUpdate websocket — no notify binding here, so it's omitted).
		await updateAccount(c.env.DB, id, { ProfileImage: imageName })
		return c.json({ success: true })
	})

export default app
