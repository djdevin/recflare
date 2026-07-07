import { Hono } from 'hono'

import storefrontGiftDrop2 from '../../static/storefronts-v3-giftdropstore-2.json'
import storefrontGiftDrop3 from '../../static/storefronts-v3-giftdropstore-3.json'
import storefrontGiftDrop300 from '../../static/storefronts-v3-giftdropstore-300.json'
import { authedId, unauthorized } from '../http'

import type { App } from '../context'

// ---- Storefronts -----------------------------------------------------------
export const storefrontRoutes = new Hono<App>({ strict: false })
	.get('/api/storefronts/v4/balance/2', async (c) => {
		const id = await authedId(c)
		if (id === null) return unauthorized(c)
		return c.json([]) // TODO: query TokenBalances
	})
	.get('/api/storefronts/v1/p2p/betaEnabled', (c) => c.json(false))
	.get('/api/storefronts/v3/giftdropstore/3', (c) => c.json(storefrontGiftDrop3))
	.get('/api/storefronts/v3/giftdropstore/300', (c) => c.json(storefrontGiftDrop300))
	.get('/api/storefronts/v3/giftdropstore/2', (c) => c.json(storefrontGiftDrop2))
	.post('/api/storefronts/v2/buyItem', async (c) => {
		const id = await authedId(c)
		if (id === null) return unauthorized(c)
		// No StorefrontItems binding → item can never be found.
		return c.json({ error: 'Item not found' }, 404)
	})
