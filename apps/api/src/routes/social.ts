import { Hono } from 'hono'

import { logger } from '@repo/hono-helpers'

import { authedId, unauthorized } from '../http'
import {
	acceptFriendRequest,
	addFriend,
	getRelationshipsForPlayer,
	removeFriend,
	sendFriendRequest,
	setRelationshipFlag,
} from '../relationships-db'

import type { Context } from 'hono'
import type { App } from '../context'
import type { RelationshipFlag } from '../relationships-db'

/** The notifications hub is a single global DO instance (see the `notify` worker). */
const HUB_INSTANCE = 'global'

/** NotificationType.RelationshipChanged (see apps/notify/src/notification-types.ts). */
const RELATIONSHIP_CHANGED = 1

/**
 * Apply a per-player relationship flag toggle (favorited/ignored/muted) and hand the
 * result to the client the way the Go server does: the resulting relationship rides a
 * `RelationshipChanged` hub notification to the caller, and the HTTP body is just the
 * `{ Success, Message }` ack. Hub failures are logged and swallowed — the DB write has
 * already committed, so a hub hiccup must not fail the request.
 */
async function applyFlag(
	c: Context<App>,
	playerId: number,
	otherId: number,
	flag: RelationshipFlag,
	value: boolean
): Promise<Response> {
	const rel = await setRelationshipFlag(c.env.DB, playerId, otherId, flag, value)
	try {
		await c.env.RECFLARE_NOTIFICATIONS_HUB.getByName(HUB_INSTANCE).notifyPlayer(
			playerId,
			RELATIONSHIP_CHANGED,
			{ ...rel }
		)
	} catch (err) {
		logger.error('failed to push RelationshipChanged notification', {
			playerId,
			error: err instanceof Error ? err.message : String(err),
		})
	}
	return c.json({ Success: true, Message: '' })
}

/**
 * Read the other player's id from a relationship-mutation request. The exact wire
 * shape is still TBD, so this is liberal: it accepts `playerId`/`id` as a query
 * param and `PlayerId`/`playerId`/`Id` from a JSON or form body. Returns null when
 * no integer id is present.
 */
async function targetPlayerId(c: Context<App>): Promise<number | null> {
	const fromQuery = c.req.query('playerId') ?? c.req.query('id')
	if (fromQuery !== undefined) {
		const n = Number.parseInt(fromQuery, 10)
		if (!Number.isNaN(n)) return n
	}
	// Body may be JSON or form-encoded; Hono's parseBody only handles the latter.
	const contentType = c.req.header('content-type') ?? ''
	const body = contentType.includes('application/json')
		? await c.req.json<Record<string, unknown>>().catch(() => ({}) as Record<string, unknown>)
		: ((await c.req.parseBody().catch(() => ({}))) as Record<string, unknown>)
	const raw = body.PlayerId ?? body.playerId ?? body.Id
	if (typeof raw === 'number') return Number.isNaN(raw) ? null : raw
	if (typeof raw === 'string') {
		const n = Number.parseInt(raw, 10)
		if (!Number.isNaN(n)) return n
	}
	return null
}

// ---- Social ----------------------------------------------------------------
export const socialRoutes = new Hono<App>({ strict: false })
	// The authed player's relationships, projected from their point of view — a bare
	// array of RelationshipResponse. Auth-gated.
	.get('/api/relationships/v2/get', async (c) => {
		const id = await authedId(c)
		if (id === null) return unauthorized(c)
		return c.json(await getRelationshipsForPlayer(c.env.DB, id))
	})

	// Send a friend request to another player (the target arrives as `?id=`). The
	// client calls this as a GET; the mutations accept GET or POST (the Go handlers
	// matched any method). Auth-gated. Returns the resulting relationship from the
	// caller's point of view.
	.on(['GET', 'POST'], '/api/relationships/v2/sendfriendrequest', async (c) => {
		const id = await authedId(c)
		if (id === null) return unauthorized(c)
		const target = await targetPlayerId(c)
		if (target === null || target === id) return c.json({ error: 'invalid player id' }, 400)
		return c.json(await sendFriendRequest(c.env.DB, id, target))
	})

	// Accept a pending friend request from another player (`?id=`). Auth-gated.
	.on(['GET', 'POST'], '/api/relationships/v2/acceptfriendrequest', async (c) => {
		const id = await authedId(c)
		if (id === null) return unauthorized(c)
		const target = await targetPlayerId(c)
		if (target === null || target === id) return c.json({ error: 'invalid player id' }, 400)
		return c.json(await acceptFriendRequest(c.env.DB, id, target))
	})

	// Remove a friend / cancel a request / decline a request (`?id=`). Auth-gated.
	.on(['GET', 'POST'], '/api/relationships/v2/removefriend', async (c) => {
		const id = await authedId(c)
		if (id === null) return unauthorized(c)
		const target = await targetPlayerId(c)
		if (target === null || target === id) return c.json({ error: 'invalid player id' }, 400)
		await removeFriend(c.env.DB, id, target)
		return c.json({ success: true })
	})

	// Directly add another player as a friend, no pending-request step (`?id=`). Auth-gated.
	.on(['GET', 'POST'], '/api/relationships/v2/addfriend', async (c) => {
		const id = await authedId(c)
		if (id === null) return unauthorized(c)
		const target = await targetPlayerId(c)
		if (target === null || target === id) return c.json({ error: 'invalid player id' }, 400)
		return c.json(await addFriend(c.env.DB, id, target))
	})

	// Ignore / mute another player, and their inverses unignore / unmute (target
	// arrives as `PlayerId` in the POST body). These set a per-player flag on the
	// *caller's* side of the relationship row, creating a bare (None) row when the
	// pair aren't otherwise related — so you can ignore/mute someone you've never
	// friended. The un- variants just clear the same flag. Auth-gated. The resulting
	// relationship is delivered via a RelationshipChanged hub notification (see
	// applyFlag); the HTTP body is just the { Success, Message } ack.
	.on(['GET', 'POST'], '/api/relationships/v1/ignore', async (c) => {
		const id = await authedId(c)
		if (id === null) return unauthorized(c)
		const target = await targetPlayerId(c)
		if (target === null || target === id) return c.json({ error: 'invalid player id' }, 400)
		return applyFlag(c, id, target, 'ignored', true)
	})
	.on(['GET', 'POST'], '/api/relationships/v1/unignore', async (c) => {
		const id = await authedId(c)
		if (id === null) return unauthorized(c)
		const target = await targetPlayerId(c)
		if (target === null || target === id) return c.json({ error: 'invalid player id' }, 400)
		return applyFlag(c, id, target, 'ignored', false)
	})
	.on(['GET', 'POST'], '/api/relationships/v1/mute', async (c) => {
		const id = await authedId(c)
		if (id === null) return unauthorized(c)
		const target = await targetPlayerId(c)
		if (target === null || target === id) return c.json({ error: 'invalid player id' }, 400)
		return applyFlag(c, id, target, 'muted', true)
	})
	.on(['GET', 'POST'], '/api/relationships/v1/unmute', async (c) => {
		const id = await authedId(c)
		if (id === null) return unauthorized(c)
		const target = await targetPlayerId(c)
		if (target === null || target === id) return c.json({ error: 'invalid player id' }, 400)
		return applyFlag(c, id, target, 'muted', false)
	})

	// Favorite / unfavorite another player (the client calls these as a GET with the
	// target in `?id=`). Same per-side flag mechanics as ignore/mute above: the write
	// lands on the *caller's* side of the row, and favoriting someone you have no
	// relationship with creates a bare (None) row. Auth-gated. Result rides a
	// RelationshipChanged notification; the body is the { Success, Message } ack.
	.on(['GET', 'POST'], '/api/relationships/v1/favorite', async (c) => {
		const id = await authedId(c)
		if (id === null) return unauthorized(c)
		const target = await targetPlayerId(c)
		if (target === null || target === id) return c.json({ error: 'invalid player id' }, 400)
		return applyFlag(c, id, target, 'favorited', true)
	})
	.on(['GET', 'POST'], '/api/relationships/v1/unfavorite', async (c) => {
		const id = await authedId(c)
		if (id === null) return unauthorized(c)
		const target = await targetPlayerId(c)
		if (target === null || target === id) return c.json({ error: 'invalid player id' }, 400)
		return applyFlag(c, id, target, 'favorited', false)
	})

	.get('/api/messages/v2/get', (c) => c.json([]))
	.get('/api/messages/v1/favoriteFriendOnlineStatus', (c) => c.json([]))
