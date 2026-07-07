import { Hono } from 'hono'

import { defaultSettings } from '../default-settings'
import { authedId, unauthorized } from '../http'

import type { App } from '../context'

// ---- Settings / inventory --------------------------------------------------
export const inventoryRoutes = new Hono<App>({ strict: false })
	// ---- Settings -------------------------------------------------------------
	.get('/api/settings/v2', async (c) => {
		const id = await authedId(c)
		if (id === null) return unauthorized(c)
		// TODO: load stored settings; seed defaults on first access.
		return c.json(defaultSettings(id))
	})
	.post('/api/settings/v2/set', async (c) => {
		const id = await authedId(c)
		if (id === null) return unauthorized(c)
		// TODO: replace stored settings for `id`.
		return c.body(null, 200)
	})

	// ---- Inventory ------------------------------------------------------------
	.get('/api/equipment/v2/getUnlocked', (c) => c.json([]))
	.get('/api/consumables/v2/getUnlocked', async (c) => {
		const id = await authedId(c)
		if (id === null) return unauthorized(c)
		return c.json([]) // TODO: query ConsumableItems
	})
