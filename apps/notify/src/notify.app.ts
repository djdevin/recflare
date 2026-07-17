import { Hono } from 'hono'
import { useWorkersLogger } from 'workers-tagged-logger'

import { logger, withNotFound, withOnError } from '@repo/hono-helpers'
import { validateAndGetRoles } from '@repo/jwt'

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
 * Roles allowed to call the internal send/broadcast endpoints. These are the
 * operator-granted elevated roles (see the auth worker's `role` claim, set from an
 * account's isDeveloper/isModerator flags via the admin CLI) — so a staffer grants
 * themselves the role and can then push notifications through the shared hub, e.g.
 * from the accounts web UI's maintenance control.
 */
const ADMIN_ROLES = new Set(['developer', 'moderator'])

/**
 * Gates the `/internal/*` endpoints on a valid Bearer token that carries one of the
 * {@link ADMIN_ROLES} in its `role` claim. 401 for a missing/invalid token, 403 for a
 * valid token that lacks an admin role.
 */
const requireAdmin: MiddlewareHandler<App> = async (c, next) => {
	const roles = await validateAndGetRoles(c.req.raw, await c.env.JWT_SECRET.get())
	if (roles === null) return c.json({ error: 'Unauthorized' }, 401)
	if (!roles.some((role) => ADMIN_ROLES.has(role))) return c.json({ error: 'Forbidden' }, 403)
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

	// Send a coach/system direct message to every currently-online player.
	.post('/internal/coach-message-all', async (c) => {
		const body = await c.req.json<{ messageContent?: string }>().catch(() => null)
		const content = typeof body?.messageContent === 'string' ? body.messageContent.trim() : ''
		if (content === '') return c.json({ error: 'messageContent is required' }, 400)
		const result =
			await c.env.RECFLARE_NOTIFICATIONS_HUB.getByName(HUB_INSTANCE).coachMessageAll(content)
		return c.json({ success: true, ...result })
	})

export { NotificationsHub }
export default app
