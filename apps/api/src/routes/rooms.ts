import { Hono } from 'hono'

import { authedId } from '../http'
import { getRoomById } from '../rooms-db'

import type { App } from '../context'

// ---- Room keys / quick play / rooms ----------------------------------------
export const roomRoutes = new Hono<App>({ strict: false })
	.get('/api/roomkeys/v1/mine', (c) => c.json([]))
	.get('/api/roomkeys/v1/room', (c) => c.json([]))
	.get('/api/quickPlay/v1/getandclear', (c) =>
		c.json({ RoomName: null, ActionCode: null, TargetPlayerId: null })
	)

	// Room search filters. The client deserializes this into an object (not an
	// array) — shape from the 2025 reference.
	.get('/api/rooms/v1/filters', (c) =>
		c.json({
			PinnedFilters: [
				'recroomoriginal',
				'community',
				'featured',
				'quest',
				'pvp',
				'hangout',
				'game',
				'art',
				'store',
				'tutorial',
				'fandom',
				'performance',
				'action',
				'horror',
			],
			PopularFilters: ['pvp', 'quest', 'game', 'hangout', 'art'],
			TrendingFilters: ['roleplay', 'nomp', 'rp', 'casual', 'fun', 'action', 'military', 'sports'],
		})
	)

	// Verify the caller holds at least `role` in a room. Params come from the form
	// body (falling back to the query string). Returns a bare `true`/`false`: the
	// room creator always passes; otherwise the caller needs a Roles entry with
	// `Role >= role`. Any failure (no token, unknown room, insufficient role) is
	// `false`. The `context` field (e.g. MakerPen) is accepted and ignored.
	.post('/api/rooms/v1/verifyRole', async (c) => {
		const body = (await c.req.parseBody().catch(() => ({}))) as Record<string, unknown>
		const param = (name: string): string => {
			const form = body[name]
			if (typeof form === 'string' && form !== '') return form
			return c.req.query(name) ?? ''
		}
		const roomId = Number.parseInt(param('roomId'), 10)
		const role = Number.parseInt(param('role'), 10)

		const accountId = await authedId(c)
		if (accountId === null || Number.isNaN(roomId)) return c.json(false)

		const room = await getRoomById(c.env.DB, roomId)
		if (!room) return c.json(false)

		// The creator always passes.
		if (room.CreatorAccountId === accountId) return c.json(true)

		// Otherwise the caller needs a room role at least as high as requested.
		const roles = Array.isArray(room.Roles) ? (room.Roles as Array<Record<string, unknown>>) : []
		const hasRole = roles.some(
			(r) => r.AccountId === accountId && typeof r.Role === 'number' && r.Role >= (role || 0)
		)
		return c.json(hasRole)
	})
