import { Hono } from 'hono'

import {
	acceptFriendRequest,
	addFriend,
	getRelationshipsForPlayer,
	removeFriend,
	sendFriendRequest,
	setRelationshipFlag,
} from '../relationships-db'
import { authedId, unauthorized } from '../http'

import type { Context } from 'hono'
import type { App } from '../context'

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

	// Ignore / mute another player (target arrives as `PlayerId` in the POST body).
	// These set a per-player flag on the *caller's* side of the relationship row,
	// creating a bare (None) row when the pair aren't otherwise related — so you can
	// ignore/mute someone you've never friended. Auth-gated. Returns the resulting
	// relationship from the caller's point of view.
	.on(['GET', 'POST'], '/api/relationships/v1/ignore', async (c) => {
		const id = await authedId(c)
		if (id === null) return unauthorized(c)
		const target = await targetPlayerId(c)
		if (target === null || target === id) return c.json({ error: 'invalid player id' }, 400)
		return c.json(await setRelationshipFlag(c.env.DB, id, target, 'ignored', true))
	})
	.on(['GET', 'POST'], '/api/relationships/v1/mute', async (c) => {
		const id = await authedId(c)
		if (id === null) return unauthorized(c)
		const target = await targetPlayerId(c)
		if (target === null || target === id) return c.json({ error: 'invalid player id' }, 400)
		return c.json(await setRelationshipFlag(c.env.DB, id, target, 'muted', true))
	})

	.get('/api/messages/v2/get', (c) => c.json([]))
	.get('/api/messages/v1/favoriteFriendOnlineStatus', (c) => c.json([]))
