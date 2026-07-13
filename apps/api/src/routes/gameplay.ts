import { Hono } from 'hono'

import type { App } from '../context'

// Text sanitization, keepsakes, objectives/events/rewards, and the misc
// analytics/subscription sinks the client hits during load.
export const gameplayRoutes = new Hono<App>({ strict: false })
	// Text sanitization (display names, room names, chat). `v1` echoes the input
	// value back; `isPure` reports the text is clean.
	.post('/api/sanitize/v1', async (c) => {
		const body = await c.req.json<{ Value?: unknown }>().catch(() => ({}) as { Value?: unknown })
		return c.json(typeof body.Value === 'string' ? body.Value : '')
	})
	.post('/api/sanitize/v1/isPure', (c) => c.json({ IsPure: true }))

	// Keepsakes (room mementos). Stubbed empty.
	.get('/api/keepsakes/globalconfig', (c) =>
		c.json({ KeepsakeFeatureEnabled: true, KeepsakeRoomLimit: 10, SocialXpBoostEnabled: false })
	)
	.get('/api/keepsakes/rooms/:roomId', (c) => c.body(null, 204))
	.get('/api/keepsakes/categories', (c) => c.json([]))

	// ---- Objectives / events / rewards ---------------------------------------
	// Objectives live on the `econ` host (`updateobjective` / `myprogress`), which is
	// where the client calls them — they are not served here.
	.get('/api/communityboard/v2/current', (c) => c.json({})) // TODO: hydrate from JSON/communityboard.json
	.get('/api/playerevents/v1/all', (c) => c.json({ Created: [], Responses: [] }))

	// The tag filter chips on the player-events browse screen. Derived from the tags in
	// use across events — we store no events, so there are no chips to offer.
	// `TrendingFilters` is null even in the reference (it needs recent-activity data).
	.get('/api/playerevents/v1/tagfilters', (c) =>
		c.json({ PinnedFilters: [], PopularFilters: [], TrendingFilters: null })
	)

	// Player events for a set of clubs (`?id=1&id=2`) — the events shelf on a club's
	// page. A bare array: the client deserializes this one as a list, and chokes on the
	// `{ ContinuationToken, Events }` envelope the single-club form uses. No
	// player-event storage yet, so the feed is empty.
	.get('/api/playerevents/v1/clubs', (c) => c.json([]))

	// The same feed for a single club (`/club/1`) — the form the reference serves,
	// which *does* wrap the events with a paging cursor (empty = no next page).
	.get('/api/playerevents/v1/club/:clubId{[0-9]+}', (c) =>
		c.json({ ContinuationToken: '', Events: [] })
	)
	.get('/api/announcement/v1/get', (c) => c.json([])) // TODO: hydrate from JSON/announcements.json

	// GameSight attribution/analytics event sink. Accept and ack without persisting.
	.post('/api/gamesight/event', (c) => c.body(null, 200))

	// ---- Subscription ---------------------------------------------------------
	.post('/api/CampusCard/v1/UpdateAndGetSubscription', (c) =>
		c.json({ subscription: null, platformAccountSubscribedPlayerId: null })
	)
