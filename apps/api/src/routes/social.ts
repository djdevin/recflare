import { Hono } from 'hono'
import { describeRoute } from 'hono-openapi'

import { logger } from '@repo/hono-helpers'

import { authedId, unauthorized } from '../http'
import {
	AckResponse,
	AUTHED,
	ErrorResponse,
	intQuery,
	json,
	JsonArray,
	RelationshipDto,
	UNAUTHORIZED_RESPONSE,
} from '../openapi'
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
import type {
	RelationshipChange,
	RelationshipFlag,
	RelationshipResponse,
} from '../relationships-db'

/** The notifications hub is a single global DO instance (see the `notify` worker). */
const HUB_INSTANCE = 'global'

/** NotificationType.RelationshipChanged (see apps/notify/src/notification-types.ts). */
const RELATIONSHIP_CHANGED = 1

/**
 * Push a `RelationshipChanged` notification carrying `rel` to one player. Hub failures are
 * logged and swallowed — the DB write has already committed, so a hub hiccup must not fail
 * the request.
 */
async function notifyRelationship(
	c: Context<App>,
	playerId: number,
	rel: RelationshipResponse
): Promise<void> {
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
}

/**
 * Notify both players of a friend-graph change, each with the relationship projected from
 * their own point of view — the target of a request sees `FriendRequestReceived` where the
 * sender sees `Sent`, so the two payloads differ. A no-op mutation notifies nobody.
 */
async function notifyBoth(
	c: Context<App>,
	playerId: number,
	otherId: number,
	change: RelationshipChange
): Promise<void> {
	if (!change.changed) return
	await notifyRelationship(c, playerId, change.self)
	await notifyRelationship(c, otherId, change.other)
}

/**
 * Apply a per-player relationship flag toggle (favorited/ignored/muted). The flags are
 * private to the caller's own side of the row, so only the caller is notified. The
 * resulting relationship rides the notification and the HTTP body is just the
 * `{ Success, Message }` ack.
 */
async function applyFlag(
	c: Context<App>,
	playerId: number,
	otherId: number,
	flag: RelationshipFlag,
	value: boolean
): Promise<Response> {
	const rel = await setRelationshipFlag(c.env.DB, playerId, otherId, flag, value)
	await notifyRelationship(c, playerId, rel)
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

/**
 * How every relationship mutation names its target. The handler is liberal — it also
 * accepts `PlayerId`/`playerId`/`Id` from a JSON or form body — but the client sends the
 * query param, so that's what the spec documents.
 */
const TARGET_PARAMS = [
	intQuery('id', 'The other player. The client uses this form.'),
	intQuery('playerId', 'Accepted as an alias for `id`'),
]

/**
 * A `describeRoute` spec for one of the four friend-graph mutations. These change state
 * both players can see, so each also pushes a RelationshipChanged notification to both
 * sides; the HTTP body is the caller's own projection.
 */
function friendMutation(summary: string, description: string) {
	return describeRoute({
		tags: ['Social'],
		summary,
		description,
		security: AUTHED,
		parameters: TARGET_PARAMS,
		responses: {
			200: json(RelationshipDto, 'The relationship, from the caller’s point of view'),
			400: json(ErrorResponse, 'No target id, or the caller targeting themselves'),
			401: UNAUTHORIZED_RESPONSE,
		},
	})
}

/**
 * A `describeRoute` spec for a per-side flag toggle (favorite / ignore / mute and their
 * inverses). The write lands on the caller's own side of the row, so only the caller is
 * notified — and the resulting relationship rides that notification, not the response,
 * which is just the ack.
 */
function flagToggle(summary: string, description: string) {
	return describeRoute({
		tags: ['Social'],
		summary,
		description,
		security: AUTHED,
		parameters: TARGET_PARAMS,
		responses: {
			200: json(AckResponse, 'The ack; the relationship arrives over the notification hub'),
			400: json(ErrorResponse, 'No target id, or the caller targeting themselves'),
			401: UNAUTHORIZED_RESPONSE,
		},
	})
}

// ---- Social ----------------------------------------------------------------
export const socialRoutes = new Hono<App>({ strict: false })
	// The authed player's relationships, projected from their point of view — a bare
	// array of RelationshipResponse. Auth-gated.
	.get(
		'/api/relationships/v2/get',
		describeRoute({
			tags: ['Social'],
			summary: 'The caller’s relationships',
			description:
				'Every relationship the signed-in player has, projected from their point of view — ' +
				'a bare array. `None` rows are included: that is how an unfriending, or an ' +
				'ignore/mute of someone you were never friends with, is recorded, and they still ' +
				'carry the caller’s favorited/ignored/muted flags.',
			security: AUTHED,
			responses: {
				200: json(RelationshipDto.array(), 'The caller’s relationships'),
				401: UNAUTHORIZED_RESPONSE,
			},
		}),
		async (c) => {
			const id = await authedId(c)
			if (id === null) return unauthorized(c)
			return c.json(await getRelationshipsForPlayer(c.env.DB, id))
		}
	)

	// Send a friend request to another player (the target arrives as `?id=`). The
	// client calls this as a GET; the mutations accept GET or POST (the Go handlers
	// matched any method). Auth-gated. Returns the resulting relationship from the
	// caller's point of view.
	//
	// The four friend-graph mutations below change state both players can see, so each
	// notifies BOTH sides with their own projection (see notifyBoth) on top of the HTTP
	// response. A no-op — re-sending an outstanding request, accepting nothing pending —
	// notifies nobody.
	.on(
		['GET', 'POST'],
		'/api/relationships/v2/sendfriendrequest',
		friendMutation(
			'Send a friend request',
			'Offer friendship to another player. Re-sending an outstanding request is a no-op ' +
				'and notifies nobody.'
		),
		async (c) => {
			const id = await authedId(c)
			if (id === null) return unauthorized(c)
			const target = await targetPlayerId(c)
			if (target === null || target === id) return c.json({ error: 'invalid player id' }, 400)
			const change = await sendFriendRequest(c.env.DB, id, target)
			await notifyBoth(c, id, target, change)
			return c.json(change.self)
		}
	)

	// Accept a pending friend request from another player (`?id=`). Auth-gated.
	.on(
		['GET', 'POST'],
		'/api/relationships/v2/acceptfriendrequest',
		friendMutation(
			'Accept a friend request',
			'Turn a pending incoming request into a friendship. Accepting nothing pending is a ' +
				'no-op and notifies nobody.'
		),
		async (c) => {
			const id = await authedId(c)
			if (id === null) return unauthorized(c)
			const target = await targetPlayerId(c)
			if (target === null || target === id) return c.json({ error: 'invalid player id' }, 400)
			const change = await acceptFriendRequest(c.env.DB, id, target)
			await notifyBoth(c, id, target, change)
			return c.json(change.self)
		}
	)

	// Remove a friend / cancel a request / decline a request (`?id=`). The row is kept as
	// a None relationship so the per-side flags survive (see removeFriend). Auth-gated.
	.on(
		['GET', 'POST'],
		'/api/relationships/v2/removefriend',
		friendMutation(
			'Unfriend, or cancel/decline a request',
			'All three are the same operation. The row is kept as a `None` relationship so the ' +
				'per-side favorited/ignored/muted flags survive.'
		),
		async (c) => {
			const id = await authedId(c)
			if (id === null) return unauthorized(c)
			const target = await targetPlayerId(c)
			if (target === null || target === id) return c.json({ error: 'invalid player id' }, 400)
			const change = await removeFriend(c.env.DB, id, target)
			await notifyBoth(c, id, target, change)
			return c.json(change.self)
		}
	)

	// Directly add another player as a friend, no pending-request step (`?id=`). Auth-gated.
	.on(
		['GET', 'POST'],
		'/api/relationships/v2/addfriend',
		friendMutation(
			'Befriend directly',
			'Become friends with no pending-request step. Already being friends is a no-op.'
		),
		async (c) => {
			const id = await authedId(c)
			if (id === null) return unauthorized(c)
			const target = await targetPlayerId(c)
			if (target === null || target === id) return c.json({ error: 'invalid player id' }, 400)
			const change = await addFriend(c.env.DB, id, target)
			await notifyBoth(c, id, target, change)
			return c.json(change.self)
		}
	)

	// Ignore / mute another player, and their inverses unignore / unmute (target
	// arrives as `PlayerId` in the POST body). These set a per-player flag on the
	// *caller's* side of the relationship row, creating a bare (None) row when the
	// pair aren't otherwise related — so you can ignore/mute someone you've never
	// friended. The un- variants just clear the same flag. Auth-gated. The resulting
	// relationship is delivered via a RelationshipChanged hub notification (see
	// applyFlag); the HTTP body is just the { Success, Message } ack.
	.on(
		['GET', 'POST'],
		'/api/relationships/v1/ignore',
		flagToggle(
			'Ignore a player',
			'Sets the caller’s `ignored` flag. Ignoring someone you have no relationship with ' +
				'creates a bare (`None`) row to hold the flag.'
		),
		async (c) => {
			const id = await authedId(c)
			if (id === null) return unauthorized(c)
			const target = await targetPlayerId(c)
			if (target === null || target === id) return c.json({ error: 'invalid player id' }, 400)
			return applyFlag(c, id, target, 'ignored', true)
		}
	)
	.on(
		['GET', 'POST'],
		'/api/relationships/v1/unignore',
		flagToggle('Stop ignoring a player', 'Clears the caller’s `ignored` flag.'),
		async (c) => {
			const id = await authedId(c)
			if (id === null) return unauthorized(c)
			const target = await targetPlayerId(c)
			if (target === null || target === id) return c.json({ error: 'invalid player id' }, 400)
			return applyFlag(c, id, target, 'ignored', false)
		}
	)
	.on(
		['GET', 'POST'],
		'/api/relationships/v1/mute',
		flagToggle(
			'Mute a player',
			'Sets the caller’s `muted` flag. Like ignore, this works on a player you have no ' +
				'relationship with.'
		),
		async (c) => {
			const id = await authedId(c)
			if (id === null) return unauthorized(c)
			const target = await targetPlayerId(c)
			if (target === null || target === id) return c.json({ error: 'invalid player id' }, 400)
			return applyFlag(c, id, target, 'muted', true)
		}
	)
	.on(
		['GET', 'POST'],
		'/api/relationships/v1/unmute',
		flagToggle('Unmute a player', 'Clears the caller’s `muted` flag.'),
		async (c) => {
			const id = await authedId(c)
			if (id === null) return unauthorized(c)
			const target = await targetPlayerId(c)
			if (target === null || target === id) return c.json({ error: 'invalid player id' }, 400)
			return applyFlag(c, id, target, 'muted', false)
		}
	)

	// Favorite / unfavorite another player (the client calls these as a GET with the
	// target in `?id=`). Same per-side flag mechanics as ignore/mute above: the write
	// lands on the *caller's* side of the row, and favoriting someone you have no
	// relationship with creates a bare (None) row. Auth-gated. Result rides a
	// RelationshipChanged notification; the body is the { Success, Message } ack.
	.on(
		['GET', 'POST'],
		'/api/relationships/v1/favorite',
		flagToggle(
			'Favorite a player',
			'Sets the caller’s `favorited` flag — what pins a player to the top of their friends ' +
				'list. Works on a player you have no relationship with.'
		),
		async (c) => {
			const id = await authedId(c)
			if (id === null) return unauthorized(c)
			const target = await targetPlayerId(c)
			if (target === null || target === id) return c.json({ error: 'invalid player id' }, 400)
			return applyFlag(c, id, target, 'favorited', true)
		}
	)
	.on(
		['GET', 'POST'],
		'/api/relationships/v1/unfavorite',
		flagToggle('Unfavorite a player', 'Clears the caller’s `favorited` flag.'),
		async (c) => {
			const id = await authedId(c)
			if (id === null) return unauthorized(c)
			const target = await targetPlayerId(c)
			if (target === null || target === id) return c.json({ error: 'invalid player id' }, 400)
			return applyFlag(c, id, target, 'favorited', false)
		}
	)

	.get(
		'/api/messages/v2/get',
		describeRoute({
			tags: ['Social'],
			summary: 'Direct messages',
			description: 'There is no message store yet, so this is always an empty list.',
			responses: { 200: json(JsonArray, 'An empty list') },
		}),
		(c) => c.json([])
	)
	.get(
		'/api/messages/v1/favoriteFriendOnlineStatus',
		describeRoute({
			tags: ['Social'],
			summary: 'Online status of favorited friends',
			description:
				'Presence for the caller’s favorited friends. Presence lives in the `match` ' +
				'worker and is not joined in here yet, so this is an empty list.',
			responses: { 200: json(JsonArray, 'An empty list') },
		}),
		(c) => c.json([])
	)
