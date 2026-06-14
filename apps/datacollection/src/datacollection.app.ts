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
	// without persisting (no binding yet). Body shape is unknown/unused.
	.post('/data/event', (c) => c.body(null, 200))

	// Periodic session heartbeat. Same deal — accept and ack with 200.
	.post('/data/heartbeat', (c) => c.body(null, 200))

export default app
