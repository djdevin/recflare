import { Hono } from 'hono'
import { useWorkersLogger } from 'workers-tagged-logger'

import { withNotFound, withOnError } from '@repo/hono-helpers'

import { DEFAULT_SETTINGS } from './default-settings'
import { validateAndGetAccountId } from './jwt'

import type { Context } from 'hono'
import type { App } from './context'

/**
 * Resolve the account id from a Bearer token (the C# action is `[Authorize]`).
 * Returns `null` when the header is missing, the token is invalid, or the `sub`
 * claim isn't an integer.
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

/**
 * Pull `{ key, value }` pairs out of a PUT body. Mirrors the C#: a
 * form-urlencoded `key`/`value`, or a JSON body (single object or array).
 * Entries with an empty key are dropped.
 */
async function parseSettings(c: Context<App>): Promise<Array<{ key: string; value: string }>> {
	const contentType = c.req.header('content-type') ?? ''

	if (contentType.includes('application/json')) {
		const body = await c.req.json<unknown>().catch(() => null)
		const list = Array.isArray(body) ? body : body == null ? [] : [body]
		return list
			.map((o) => {
				const rec = o as Record<string, unknown>
				const key = rec.key ?? rec.Key
				const value = rec.value ?? rec.Value
				return {
					key: typeof key === 'string' ? key : '',
					value:
						typeof value === 'string'
							? value
							: typeof value === 'number' || typeof value === 'boolean'
								? String(value)
								: '',
				}
			})
			.filter((s) => s.key !== '')
	}

	// form-urlencoded / multipart
	const form = await c.req.parseBody().catch(() => ({}) as Record<string, unknown>)
	const key = typeof form.key === 'string' ? form.key : ''
	const value = typeof form.value === 'string' ? form.value : ''
	return key ? [{ key, value }] : []
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

	.get('/', (c) => c.json({ service: 'playersettings', status: 'ok' }))

	// The authenticated player's settings as `{ PlayerId, Key, Value }`. Reads
	// the per-player KV map; seeds (and persists) the C# defaults on first read.
	.get('/playersettings', async (c) => {
		const id = await authedId(c)
		if (id === null) return unauthorized(c)

		const kvKey = `player:${id}`
		let stored = await c.env.PLAYER_SETTINGS.get<Record<string, string>>(kvKey, 'json')
		if (!stored || Object.keys(stored).length === 0) {
			stored = Object.fromEntries(DEFAULT_SETTINGS.map((s) => [s.Key, s.Value]))
			await c.env.PLAYER_SETTINGS.put(kvKey, JSON.stringify(stored))
		}

		return c.json(Object.entries(stored).map(([Key, Value]) => ({ PlayerId: id, Key, Value })))
	})

	// Upsert player settings into KV, keyed by the authenticated player id.
	// The C# replaces the player's entire set; we merge so individual key PUTs
	// (e.g. `key=PlayerSessionCount&value=1`) don't wipe the rest.
	.put('/playersettings', async (c) => {
		const id = await authedId(c)
		if (id === null) return unauthorized(c)

		const incoming = await parseSettings(c)
		if (incoming.length === 0) return c.body(null, 200)

		const kvKey = `player:${id}`
		const existing = await c.env.PLAYER_SETTINGS.get<Record<string, string>>(kvKey, 'json')
		const merged: Record<string, string> = { ...existing }
		for (const { key, value } of incoming) merged[key] = value

		await c.env.PLAYER_SETTINGS.put(kvKey, JSON.stringify(merged))
		return c.body(null, 200)
	})

export default app
