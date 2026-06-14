import { Hono } from 'hono'
import { useWorkersLogger } from 'workers-tagged-logger'

import { withNotFound, withOnError } from '@repo/hono-helpers'

import type { App } from './context'

/**
 * Ported from the C# `CommerceController`. The class `[Route("commerce")]` prefix
 * maps to this worker's subdomain, so method routes are served bare.
 */
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

	.get('/', (c) => c.json({ service: 'commerce', status: 'ok' }))

	// Whether the player has ever spent money. The C# returns NotFound(), but the
	// client treats that 404 as an error, so we return `false` (no purchases).
	.get('/purchase/v1/hasspentmoney', (c) => c.json(false))

export default app
