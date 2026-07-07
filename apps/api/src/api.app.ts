import { Hono } from 'hono'
import { useWorkersLogger } from 'workers-tagged-logger'

import { withNotFound, withOnError } from '@repo/hono-helpers'

import { avatarRoutes } from './routes/avatar'
import { configRoutes } from './routes/config'
import { gameplayRoutes } from './routes/gameplay'
import { imageRoutes } from './routes/images'
import { inventoryRoutes } from './routes/inventory'
import { moderationRoutes } from './routes/moderation'
import { progressionRoutes } from './routes/progression'
import { roomRoutes } from './routes/rooms'
import { socialRoutes } from './routes/social'

import type { App } from './context'

/**
 * The Game API surface. Endpoints that would be backed by a database or on-disk
 * JSON files are stubbed here — no bindings yet.
 * Auth-gated routes still validate the Bearer JWT issued by the `auth` worker.
 *
 * Placeholder responses for file-backed endpoints are marked `TODO: hydrate`.
 *
 * Routes are grouped into per-domain controllers under `./routes` and mounted
 * at `/` below. Shared request helpers live in `./http`.
 */

// strict: false so trailing-slash routes (e.g. `/gifts/consume/`) match either form.
const app = new Hono<App>({ strict: false })
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

	// ---- Controllers ----------------------------------------------------------
	.route('/', configRoutes)
	.route('/', socialRoutes)
	.route('/', progressionRoutes)
	.route('/', avatarRoutes)
	.route('/', gameplayRoutes)
	.route('/', moderationRoutes)
	.route('/', inventoryRoutes)
	.route('/', roomRoutes)
	.route('/', imageRoutes)

export default app
