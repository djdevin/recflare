import { Hono } from 'hono'

import { authedId, unauthorized } from '../http'

import type { App } from '../context'

// ---- Inventory -------------------------------------------------------------
export const inventoryRoutes = new Hono<App>({ strict: false })
	.get('/api/equipment/v2/getUnlocked', (c) => c.json([]))
	.get('/api/consumables/v2/getUnlocked', async (c) => {
		const id = await authedId(c)
		if (id === null) return unauthorized(c)
		return c.json([]) // TODO: query ConsumableItems
	})
