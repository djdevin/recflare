import { Hono } from 'hono'
import { useWorkersLogger } from 'workers-tagged-logger'

import { logger, withNotFound, withOnError } from '@repo/hono-helpers'
import { validateAndGetAccountId } from '@repo/jwt'

import { NotificationsHub } from './notifications-hub'

import type { App } from './context'
import type { MiddlewareHandler } from 'hono'

/**
 * Maps a SignalR hub at `/hub/v1`. The hub itself — WebSocket transport, the
 * SignalR JSON Hub Protocol, and the shared connection state —
 * lives in the `NotificationsHub` Durable Object; this worker handles the
 * SignalR negotiate handshake, forwards the WebSocket upgrade to the DO, and
 * exposes internal send/broadcast endpoints for other workers.
 */

/** The hub state is global → one DO instance. */
const HUB_INSTANCE = 'global'

/**
 * A valid notification `Id` — a client-defined string tag (e.g. "AccountUpdate")
 * or a numeric code. An empty string is treated as missing.
 */
function isNotificationType(value: unknown): value is string | number {
	return (typeof value === 'string' && value !== '') || typeof value === 'number'
}

/**
 * Account ids allowed to call the internal send/broadcast endpoints. Temporary
 * lockdown until these are properly gated — for now only these admins can push
 * notifications through the shared hub.
 */
const ADMIN_ACCOUNT_IDS = new Set([1, 2])

/**
 * Gates the `/internal/*` endpoints on a valid Bearer token whose `sub` is an
 * allowed admin account. 401 for a missing/invalid token, 403 for a valid token
 * that isn't an admin.
 */
const requireAdmin: MiddlewareHandler<App> = async (c, next) => {
	const accountId = await validateAndGetAccountId(c.req.raw, await c.env.JWT_SECRET.get())
	if (accountId === null) return c.json({ error: 'Unauthorized' }, 401)
	if (!ADMIN_ACCOUNT_IDS.has(accountId)) return c.json({ error: 'Forbidden' }, 403)
	await next()
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

	// SignalR negotiation. Clients POST here first; we hand back an id that is
	// then passed as `?id=` on the WebSocket connect. We don't pre-register it —
	// the DO adopts whatever id arrives — so negotiate stays stateless.
	.post('/hub/v1/negotiate', (c) => {
		const negotiateVersion = Number(c.req.query('negotiateVersion')) || 0
		const id = crypto.randomUUID()
		logger.info('signalr negotiate', { negotiateVersion })
		return c.json({
			negotiateVersion,
			connectionId: id,
			connectionToken: id,
			availableTransports: [{ transport: 'WebSockets', transferFormats: ['Text'] }],
		})
	})

	// The hub WebSocket. Upgrade requests are forwarded to the Durable Object.
	.get('/hub/v1', async (c) => {
		if ((c.req.header('upgrade') ?? '').toLowerCase() !== 'websocket') {
			return c.json({ error: 'Expected a WebSocket upgrade request' }, 426)
		}
		return c.env.RECFLARE_NOTIFICATIONS_HUB.getByName(HUB_INSTANCE).fetch(c.req.raw)
	})

	// ---- Internal service-to-service send/broadcast --------------------------
	// Lets other workers push notifications through the shared hub. Gated to admin
	// accounts (see requireAdmin) as a temporary lockdown.
	.use('/internal/*', requireAdmin)

	.post('/internal/notify', async (c) => {
		const body = await c.req
			.json<{
				playerId?: number
				notificationType?: string | number
				data?: Record<string, unknown>
			}>()
			.catch(() => null)
		if (!body || typeof body.playerId !== 'number' || !isNotificationType(body.notificationType)) {
			return c.json({ error: 'playerId and notificationType are required' }, 400)
		}
		const result = await c.env.RECFLARE_NOTIFICATIONS_HUB.getByName(HUB_INSTANCE).notifyPlayer(
			body.playerId,
			body.notificationType,
			body.data
		)
		return c.json({ success: true, ...result })
	})

	.post('/internal/broadcast', async (c) => {
		const body = await c.req
			.json<{ notificationType?: string | number; data?: Record<string, unknown> }>()
			.catch(() => null)
		if (!body || !isNotificationType(body.notificationType)) {
			return c.json({ error: 'notificationType is required' }, 400)
		}
		const result = await c.env.RECFLARE_NOTIFICATIONS_HUB.getByName(HUB_INSTANCE).broadcast(
			body.notificationType,
			body.data
		)
		return c.json({ success: true, ...result })
	})

export { NotificationsHub }
export default app
