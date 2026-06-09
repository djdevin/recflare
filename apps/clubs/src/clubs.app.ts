import { Hono } from 'hono'
import { useWorkersLogger } from 'workers-tagged-logger'

import { withNotFound, withOnError } from '@repo/hono-helpers'

import type { App } from './context'

/**
 * Ported from the C# `ClubsController`. The only endpoint always returned
 * `Results.NotFound()` in the source — no DB binding involved.
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

	// No club home yet — the C# source returns NotFound here unconditionally.
	.get('/club/home/me', (c) => c.notFound())

export default app
