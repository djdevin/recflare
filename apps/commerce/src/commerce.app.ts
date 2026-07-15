import { Hono } from 'hono'
import { useWorkersLogger } from 'workers-tagged-logger'

import { withNotFound, withOnError } from '@repo/hono-helpers'

import catalog from '../static/catalog-v1-all.json'

import type { App } from './context'

/**
 * Commerce routes. The `commerce` prefix maps to this worker's subdomain, so
 * method routes are served bare.
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

	// Whether the player has ever spent money. A 404 here makes the client treat
	// it as an error, so we return `false` (no purchases).
	.get('/purchase/v1/hasspentmoney', (c) => c.json(false))

	// The purchasable SKU catalog (token packs, special offers), served from the
	// bundled static JSON. The client passes `?onlyAvailableSkus=true`; the bundled
	// catalog is already only the available SKUs, so the param doesn't change the
	// response.
	.get('/api/catalog/v1/all', (c) => c.json(catalog))

	// Current purchase campaigns (limited-time offers/promos). None exist, and
	// an empty list is the client's "no active campaigns" state.
	.get('/purchasecampaign/allcurrent/v2', (c) => c.json([]))

export default app
