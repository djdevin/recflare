import { Hono } from 'hono'

import type { App } from '../context'

// ---- Social ----------------------------------------------------------------
export const socialRoutes = new Hono<App>({ strict: false })
	.get('/api/relationships/v2/get', (c) => c.json([]))
	.get('/api/messages/v2/get', (c) => c.json([]))
	.get('/api/messages/v1/favoriteFriendOnlineStatus', (c) => c.json([]))
