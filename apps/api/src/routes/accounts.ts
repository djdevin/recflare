import { Hono } from 'hono'

import { authedId, parseFormIds, unauthorized } from '../http'

import type { App } from '../context'

// ---- Accounts --------------------------------------------------------------
export const accountRoutes = new Hono<App>({ strict: false })
	.get('/api/accounts/v1/getBio', async (c) => {
		const id = await authedId(c)
		if (id === null) return unauthorized(c)
		return c.json([]) // TODO: query PlayerBios
	})
	.post('/api/accounts/v1/forplatformids', async (c) => {
		await parseFormIds(c) // reads `Ids` then looks up CachedLogins
		return c.json([])
	})
