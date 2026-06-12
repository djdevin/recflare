import { Hono } from 'hono'
import { useWorkersLogger } from 'workers-tagged-logger'

import { logger, withNotFound, withOnError } from '@repo/hono-helpers'

import { NotificationsHub } from './notifications-hub'

import type { App } from './context'

/**
 * Ported from the C# `NotifyController`, which maps a SignalR hub at `/hub/v1`
 * (see `NotificationsHub` / `NotificationService`). The hub itself — WebSocket
 * transport, the SignalR JSON Hub Protocol, and the shared connection state —
 * lives in the `NotificationsHub` Durable Object; this worker handles the
 * SignalR negotiate handshake, forwards the WebSocket upgrade to the DO, and
 * exposes internal send/broadcast endpoints for other workers.
 */

/** The hub state is global in the C# (static dictionaries) → one DO instance. */
const HUB_INSTANCE = 'global'

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
	.get('/hub/v1', (c) => {
		if ((c.req.header('upgrade') ?? '').toLowerCase() !== 'websocket') {
			return c.json({ error: 'Expected a WebSocket upgrade request' }, 426)
		}
		return c.env.NOTIFICATIONS_HUB.getByName(HUB_INSTANCE).fetch(c.req.raw)
	})

	// ---- Internal service-to-service send/broadcast --------------------------
	// Lets other workers push notifications, the way the C# controllers called
	// the shared NotificationService. TODO: protect these before production.
	.post('/internal/notify', async (c) => {
		const body = await c.req
			.json<{ playerId?: number; notificationType?: number; data?: Record<string, unknown> }>()
			.catch(() => null)
		if (!body || typeof body.playerId !== 'number' || typeof body.notificationType !== 'number') {
			return c.json({ error: 'playerId and notificationType are required' }, 400)
		}
		const result = await c.env.NOTIFICATIONS_HUB.getByName(HUB_INSTANCE).notifyPlayer(
			body.playerId,
			body.notificationType,
			body.data
		)
		return c.json({ success: true, ...result })
	})

	.post('/internal/broadcast', async (c) => {
		const body = await c.req
			.json<{ notificationType?: number; data?: Record<string, unknown> }>()
			.catch(() => null)
		if (!body || typeof body.notificationType !== 'number') {
			return c.json({ error: 'notificationType is required' }, 400)
		}
		const result = await c.env.NOTIFICATIONS_HUB.getByName(HUB_INSTANCE).broadcast(
			body.notificationType,
			body.data
		)
		return c.json({ success: true, ...result })
	})

export { NotificationsHub }
export default app
