import { Hono } from 'hono'
import { useWorkersLogger } from 'workers-tagged-logger'

import { withNotFound, withOnError } from '@repo/hono-helpers'

import type { App } from './context'

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

	.get('/', (c) => c.json({ service: 'datacollection', status: 'ok' }))

	// Telemetry sink. The client POSTs analytics events here; we accept and ack
	// with an empty JSON object (no persistence — no binding yet).
	.post('/data/event', (c) => c.json({}))

	// Periodic session heartbeat. Same deal — accept and ack with `{}`.
	.post('/data/heartbeat', (c) => c.json({}))

	// Analytics identify call (player/device identification). Accept and ack.
	.post('/identify', (c) => c.json({}))

	// Generic analytics HTTP API sink. Accept and ack.
	.post('/httpapi', (c) => c.json({}))

export default app
