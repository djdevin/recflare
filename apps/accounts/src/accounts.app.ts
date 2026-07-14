import { Hono } from 'hono'
import { useWorkersLogger } from 'workers-tagged-logger'

import {
	createAccount,
	defaultAccount,
	getAccount,
	getAccountByUsername,
	getAccountsByIds,
	searchAccounts,
	updateAccount,
} from '@repo/domain'
import { logger, withNotFound, withOnError } from '@repo/hono-helpers'
import { validateAndGetAccountId } from '@repo/jwt'

import type { Context } from 'hono'
import type { Account } from '@repo/domain'
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
	return validateAndGetAccountId(c.req.raw, await c.env.JWT_SECRET.get())
}

/** Results.Unauthorized() equivalent — 401 with empty body. */
function unauthorized(c: Context<App>) {
	return c.body(null, 401)
}

/** Username changes a fresh account starts with (until one has been consumed). */
const DEFAULT_USERNAME_CHANGES = 1

/**
 * Username-change result envelope: `{ success, error, value }`, always HTTP 200.
 * On success `value` is the updated account; on error `error` carries the message
 * and `value` is an empty string.
 */
function usernameResult(c: Context<App>, error = '', value: unknown = '') {
	return c.json({ success: error === '', error, value })
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

/**
 * Project a stored account into the private self DTO (the /account/me shape) —
 * the public DTO plus owner-only fields. `juniorState`/`parentAccountId` are
 * OMITTED when null (emitting `null` makes the client's enum parser throw);
 * `email`/`birthday` are kept as null (not enums, so null is fine).
 */
function toSelfAccountDto(account: Account) {
	return {
		...toAccountDto(account),
		email: account.email ?? null,
		birthday: null,
		availableUsernameChanges: account.availableUsernameChanges ?? DEFAULT_USERNAME_CHANGES,
	}
}

/** The notifications hub is a single global DO instance (see the `notify` worker). */
const HUB_INSTANCE = 'global'

/**
 * Push the notifications that follow an account mutation, mirroring the C#/Go
 * hub behavior: the owner receives `SelfAccountUpdate` and `AccountUpdate`, and
 * every connected client receives an `AccountUpdate` broadcast. Hub failures are
 * logged and swallowed — the account write has already committed, so a hub
 * hiccup must not fail the request.
 */
async function pushAccountUpdate(c: Context<App>, account: Account): Promise<void> {
	try {
		const hub = c.env.RECFLARE_NOTIFICATIONS_HUB.getByName(HUB_INSTANCE)
		const publicDto = toAccountDto(account)
		await hub.notifyPlayer(account.accountId, 'SelfAccountUpdate', toSelfAccountDto(account))
		await hub.notifyPlayer(account.accountId, 'AccountUpdate', publicDto)
		await hub.broadcast('AccountUpdate', publicDto)
	} catch (err) {
		logger.error('failed to push account update notifications', {
			accountId: account.accountId,
			error: err instanceof Error ? err.message : String(err),
		})
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
		return c.json(toSelfAccountDto(account))
	})

	// ---- Search --------------------------------------------------------------
	// Prefix-search accounts by username (`?name=`). Returns a bare array of public
	// account DTOs, ordered alphabetically. Registered before `/account/:id` so the
	// static `search` path wins over the param route.
	.get('/account/search', async (c) => {
		const name = c.req.query('name') ?? ''
		const accounts = await searchAccounts(c.env.DB, name)
		return c.json(accounts.map(toAccountDto))
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
		return c.json(
			toAccountDto((await getAccount(c.env.DB, accountId)) ?? defaultAccount(accountId))
		)
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

	// Privacy settings for an account. A bare `{}` fails the client's deserializer
	// ("Deserialization returned null") — it needs the fields, so echo the id back and
	// report recent history as visible. Nothing stores per-player privacy yet.
	.get('/accountprivacysettings/:id{[0-9]+}', (c) =>
		c.json({
			accountId: Number.parseInt(c.req.param('id'), 10),
			isRecentHistoryVisible: true,
		})
	)

	// ---- Profile mutations ---------------------------------------------------
	// Set the player's display name (persisted on the account row).
	.put('/account/me/displayname', async (c) => {
		const id = await authedId(c)
		if (id === null) return unauthorized(c)
		const displayName = (await formField(c, 'displayName')).trim()
		if (displayName === '') return c.body(null, 400)
		const account = await updateAccount(c.env.DB, id, { displayName })
		await pushAccountUpdate(c, account)
		return c.json({ success: true })
	})

	// Change the caller's username. Rejects a name already taken by another account,
	// and requires the account to have username changes remaining. On success the
	// new name is persisted and the remaining-changes counter is decremented.
	.put('/account/me/username', async (c) => {
		const id = await authedId(c)
		if (id === null) return unauthorized(c)

		const username = (await formField(c, 'username')).trim()
		if (username === '') return usernameResult(c, 'You must enter a username.')

		// Duplicate check first (case-insensitive); keeping your own name is allowed.
		const existing = await getAccountByUsername(c.env.DB, username)
		if (existing && existing.accountId !== id) {
			return usernameResult(c, 'That username is already taken.')
		}

		// Then require a remaining change.
		const account = (await getAccount(c.env.DB, id)) ?? defaultAccount(id)
		const remaining = account.availableUsernameChanges ?? DEFAULT_USERNAME_CHANGES
		if (remaining <= 0) {
			return usernameResult(c, 'You have no username changes remaining.')
		}

		const updated = await updateAccount(c.env.DB, id, {
			username,
			availableUsernameChanges: remaining - 1,
		})
		await pushAccountUpdate(c, updated)
		return usernameResult(c, '', toAccountDto(updated))
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

	// Set the player's phone (persisted on the account row).
	.post('/account/me/phone', async (c) => {
		const id = await authedId(c)
		if (id === null) return unauthorized(c)
		const phone = (await formField(c, 'phone')).trim()
		if (phone === '') return c.body(null, 400)
		await updateAccount(c.env.DB, id, { phone })
		return c.json({ success: true })
	})

	// Set the player's identityFlags bitmask (persisted; surfaced by /account/me).
	// `identityFlags` is part of the public account DTO, so the update has to be pushed
	// — see the note on personalpronouns below.
	.put('/account/me/identityflags', async (c) => {
		const id = await authedId(c)
		if (id === null) return unauthorized(c)
		const identityFlags = Number.parseInt((await formField(c, 'identityFlags')).trim(), 10)
		if (Number.isNaN(identityFlags)) return c.body(null, 400)
		const account = await updateAccount(c.env.DB, id, { identityFlags })
		await pushAccountUpdate(c, account)
		return c.json({ success: true })
	})

	// Set the player's personalPronouns (posted as `pronounFlags`; persisted).
	// The response body carries no account, so the client only learns the new value from
	// the `SelfAccountUpdate`/`AccountUpdate` the hub pushes — without it the player's own
	// UI (and every other client, since personalPronouns is in the public DTO) keeps
	// showing the old pronouns until something else refetches the account.
	.put('/account/me/personalpronouns', async (c) => {
		const id = await authedId(c)
		if (id === null) return unauthorized(c)
		const personalPronouns = Number.parseInt((await formField(c, 'pronounFlags')).trim(), 10)
		if (Number.isNaN(personalPronouns)) return c.body(null, 400)
		const account = await updateAccount(c.env.DB, id, { personalPronouns })
		await pushAccountUpdate(c, account)
		return c.json({ success: true })
	})

	.put('/account/me/bio', async (c) => {
		const id = await authedId(c)
		if (id === null) return unauthorized(c)
		const bio = await formField(c, 'bio')
		const account = await updateAccount(c.env.DB, id, { bio })
		await pushAccountUpdate(c, account)
		return c.json({ success: true })
	})

	.put('/account/me/profileimage', async (c) => {
		const id = await authedId(c)
		if (id === null) return unauthorized(c)
		const imageName = await formField(c, 'imageName')
		if (!imageName) return c.body(null, 400)
		// Persist the new avatar key on the account row and fire the AccountUpdate
		// websocket (the new profileImage rides along in the DTO payload).
		const account = await updateAccount(c.env.DB, id, { profileImage: imageName })
		await pushAccountUpdate(c, account)
		return c.json({ success: true })
	})

export default app
