import { Hono } from 'hono'
import { useWorkersLogger } from 'workers-tagged-logger'

import { withNotFound, withOnError } from '@repo/hono-helpers'

import endpoints from '../static/endpoints.json'

import type { App } from './context'

/**
 * Name-server / service-discovery worker served at the apex domain.
 * Returns the endpoints document the game client fetches to discover every
 * service host. Generated from `env.json` by `runx sync` — run it after
 * changing the domain (see `apps/ns/static/endpoints.json`).
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

	// Endpoints document. TODO: generate this dynamically per environment.
	.get('/', (c) => c.json(endpoints))

export default app
