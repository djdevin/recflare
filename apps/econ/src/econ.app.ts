import { Hono } from 'hono'
import { useWorkersLogger } from 'workers-tagged-logger'

import { withNotFound, withOnError } from '@repo/hono-helpers'

import defaultAvatarItems from '../static/default-avatar-items.json'

import type { App } from './context'

/**
 * Economy Worker. Hosts the avatar/economy endpoints the game client calls on
 * the `econ` service (these are separate from the main `api` worker). DB-backed
 * data is stubbed for now — no bindings yet.
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

	// Default-unlocked avatar items, served from the bundled static JSON.
	.get('/api/avatar/v1/defaultunlocked', (c) => c.json(defaultAvatarItems))

export default app
