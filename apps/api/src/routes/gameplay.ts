import { Hono } from 'hono'

import { authedId, unauthorized } from '../http'

import type { App } from '../context'

// ---- 2023 client loading-path endpoints ------------------------------------
// NUX checklist, text sanitization, keepsakes, objectives/events/rewards, and
// the misc analytics/subscription sinks the client hits during load.
export const gameplayRoutes = new Hono<App>({ strict: false })
	// NUX checklist — empty list with no DB.
	.get('/api/checklist/v1/current', async (c) => {
		const id = await authedId(c)
		if (id === null) return unauthorized(c)
		return c.json([])
	})

	// Text sanitization (display names, room names, chat). `v1` echoes the input
	// value back; `isPure` reports the text is clean. The client sanitizes text
	// during load/display, so a 404 here can stall room entry.
	.post('/api/sanitize/v1', async (c) => {
		const body = await c.req.json<{ Value?: unknown }>().catch(() => ({}) as { Value?: unknown })
		return c.json(typeof body.Value === 'string' ? body.Value : '')
	})
	.post('/api/sanitize/v1/isPure', (c) => c.json({ IsPure: true }))

	// Keepsakes (room mementos). Shapes from the 2025 reference; categories isn't
	// in any reference, so it's stubbed empty. The client fetches these on room
	// entry — a 404 stalls the load.
	.get('/api/keepsakes/globalconfig', (c) =>
		c.json({ KeepsakeFeatureEnabled: true, KeepsakeRoomLimit: 10, SocialXpBoostEnabled: false })
	)
	.get('/api/keepsakes/rooms/:roomId', (c) => c.body(null, 204))
	.get('/api/keepsakes/categories', (c) => c.json([]))

	// ---- Objectives / events / rewards ---------------------------------------
	.get('/api/objectives/v1/myprogress', (c) => c.json({})) // TODO: hydrate from JSON/tempmyprogress.json
	.post('/api/objectives/v1/updateobjective', (c) => c.body(null, 200))
	.get('/api/gamerewards/v1/pending', (c) => c.json([]))
	.get('/api/communityboard/v2/current', (c) => c.json({})) // TODO: hydrate from JSON/communityboard.json
	.get('/api/playerevents/v1/all', (c) => c.json({ Created: [], Responses: [] }))
	.get('/api/challenge/v2/getCurrent', (c) => c.json({})) // TODO: hydrate from JSON/weeklychallenge.json
	.get('/api/announcement/v1/get', (c) => c.json([])) // TODO: hydrate from JSON/announcements.json

	// GameSight attribution/analytics event sink. Accept and ack without persisting.
	.post('/api/gamesight/event', (c) => c.body(null, 200))

	// ---- Subscription ---------------------------------------------------------
	.post('/api/CampusCard/v1/UpdateAndGetSubscription', (c) =>
		c.json({ subscription: null, platformAccountSubscribedPlayerId: null })
	)
