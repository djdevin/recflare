import { Hono } from 'hono'
import { useWorkersLogger } from 'workers-tagged-logger'

import { withNotFound, withOnError } from '@repo/hono-helpers'

import { createAccount, defaultAccount, getAccount, getAccountsByIds, updateAccount } from './accounts-db'
import { validateAndGetAccountId } from './jwt'

import type { Context } from 'hono'
import type { Account } from './accounts-db'
import type { App } from './context'

/**
 * Account reads/writes are backed by the shared `accounts` table in D1 (schema
 * owned by the `auth` worker). Accounts not in the table fall back to a
 * synthesized default (every column has a fallback anyway). Profile mutations
 * still accept-and-ack (marked `TODO`).
 *
 * Auth-gated routes still validate the Bearer JWT issued by the `auth` worker.
 */

/**
 * Resolve the account id from a Bearer token, mirroring the repeated
 * auth-header check. Returns `null` when the header is missing,
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

/**
 * Project a stored account into the public account DTO — the client's camelCase
 * shape, excluding private fields like `email` (surfaced only by /account/me).
 */
function toAccountDto(account: Account) {
	return {
		accountId: account.accountId,
		username: account.username,
		displayName: account.displayName,
		profileImage: account.profileImage,
		isJunior: account.isJunior,
		platforms: account.platforms,
		personalPronouns: account.personalPronouns,
		identityFlags: account.identityFlags,
		createdAt: account.createdAt,
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

	// Root health check.
	.get('/', (c) => c.json({ service: 'accounts', status: 'ok' }))

	// ---- Self account --------------------------------------------------------
	.get('/account/me', async (c) => {
		const id = await authedId(c)
		if (id === null) return unauthorized(c)
		// Load the stored account, falling back to a synthesized default.
		const account = (await getAccount(c.env.DB, id)) ?? defaultAccount(id)
		// `juniorState` (an enum) and `parentAccountId` are OMITTED when null —
		// emitting `"juniorState":null` makes the client's enum parser throw
		// ("Can't parse JSON to Enum format"). `email`/`birthday` are kept as null
		// (they aren't enums, so null is fine).
		return c.json({
			...toAccountDto(account),
			email: account.email ?? null,
			birthday: null,
			availableUsernameChanges: 1,
		})
	})

	// ---- Bulk / single lookup ------------------------------------------------
	// Register the static `bulk` path before the `/account/:id` param route.
	.get('/account/bulk', async (c) => {
		// Reads repeated `id` query params; also accept a comma-separated list.
		const ids =
			c.req
				.queries('id')
				?.flatMap((v) => v.split(','))
				.map((s) => Number.parseInt(s.trim(), 10))
				.filter((n) => !Number.isNaN(n)) ?? []
		// Resolve stored accounts, synthesizing a default for any id not in the DB
		// so every requested id is present in the response.
		const stored = new Map((await getAccountsByIds(c.env.DB, ids)).map((a) => [a.accountId, a]))
		return c.json(ids.map((id) => toAccountDto(stored.get(id) ?? defaultAccount(id))))
	})

	.get('/account/:id/bio', async (c) => {
		const accountId = Number.parseInt(c.req.param('id'), 10)
		if (Number.isNaN(accountId)) return c.body(null, 400)
		// Bio is stored on the account JSON (set via PUT /account/me/bio).
		const account = await getAccount(c.env.DB, accountId)
		return c.json({ accountId, bio: account?.bio ?? '' })
	})

	.get('/account/:id', async (c) => {
		const accountId = Number.parseInt(c.req.param('id'), 10)
		if (Number.isNaN(accountId)) return c.body(null, 400)
		// Load the stored account, falling back to a synthesized default.
		return c.json(toAccountDto((await getAccount(c.env.DB, accountId)) ?? defaultAccount(accountId)))
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
			platforms: Number.isNaN(platforms) ? 0 : platforms,
		})
		// TODO: also create a dorm Room/SubRoom for the new account.
		return c.json({ success: true, value: toAccountDto(account) })
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

	// Set the player's email (persisted on the account row; surfaced by /account/me).
	.post('/account/me/email', async (c) => {
		const id = await authedId(c)
		if (id === null) return unauthorized(c)
		const email = (await formField(c, 'email')).trim()
		if (!email.includes('@')) return c.body(null, 400)
		await updateAccount(c.env.DB, id, { email })
		return c.json({ success: true })
	})

	// Set the player's identityFlags bitmask (persisted; surfaced by /account/me).
	.put('/account/me/identityflags', async (c) => {
		const id = await authedId(c)
		if (id === null) return unauthorized(c)
		const identityFlags = Number.parseInt((await formField(c, 'identityFlags')).trim(), 10)
		if (Number.isNaN(identityFlags)) return c.body(null, 400)
		await updateAccount(c.env.DB, id, { identityFlags })
		return c.json({ success: true })
	})

	.put('/account/me/bio', async (c) => {
		const id = await authedId(c)
		if (id === null) return unauthorized(c)
		const bio = await formField(c, 'bio')
		await updateAccount(c.env.DB, id, { bio })
		return c.json({ success: true })
	})

	.put('/account/me/profileimage', async (c) => {
		const id = await authedId(c)
		if (id === null) return unauthorized(c)
		const imageName = await formField(c, 'imageName')
		if (!imageName) return c.body(null, 400)
		// Persist the new avatar key on the account row (the C# also fires an
		// AccountUpdate websocket — no notify binding here, so it's omitted).
		await updateAccount(c.env.DB, id, { profileImage: imageName })
		return c.json({ success: true })
	})

export default app
