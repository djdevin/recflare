import { Hono } from 'hono'
import { describeRoute } from 'hono-openapi'

import charadesWords from '../../static/charades.json'
import {
	BareString,
	idParam,
	intQuery,
	IsPureResponse,
	json,
	JsonArray,
	jsonBody,
	JsonObject,
	KeepsakeConfig,
	PlayerEventsAll,
	PlayerEventsPage,
	SanitizeRequest,
	stringParam,
	SubscriptionResponse,
	TagFilters,
} from '../openapi'

import type { App } from '../context'

// Text sanitization, keepsakes, objectives/events/rewards, and the misc
// analytics/subscription sinks the client hits during load.
export const gameplayRoutes = new Hono<App>({ strict: false })
	// Text sanitization (display names, room names, chat). `v1` echoes the input
	// value back; `isPure` reports the text is clean.
	.post(
		'/api/sanitize/v1',
		describeRoute({
			tags: ['Gameplay'],
			summary: 'Sanitize a string',
			description:
				'Runs display names, room names and chat through the profanity filter. There is ' +
				'no filter here — the input `Value` is echoed back verbatim as a bare JSON string ' +
				'(an empty string if the body has no `Value`).',
			requestBody: jsonBody(SanitizeRequest, 'The text to clean'),
			responses: { 200: json(BareString, 'The input text, unchanged (a bare JSON string)') },
		}),
		async (c) => {
			const body = await c.req.json<{ Value?: unknown }>().catch(() => ({}) as { Value?: unknown })
			return c.json(typeof body.Value === 'string' ? body.Value : '')
		}
	)
	.post(
		'/api/sanitize/v1/isPure',
		describeRoute({
			tags: ['Gameplay'],
			summary: 'Whether a string is clean',
			description: 'The yes/no form of the filter. Always `true` — nothing is filtered here.',
			requestBody: jsonBody(SanitizeRequest, 'The text to check'),
			responses: { 200: json(IsPureResponse, 'Always pure') },
		}),
		(c) => c.json({ IsPure: true })
	)

	// ---- Activities -----------------------------------------------------------
	// Word bank for the Charades activity. The client requests the list by
	// activity name (`.../words/Charades`); other activities have no data yet.
	.get(
		'/api/activities/charades/v1/words/:activity',
		describeRoute({
			tags: ['Gameplay'],
			summary: 'An activity’s word bank',
			description:
				'The words the Charades activity draws from. The client asks by activity name ' +
				'(`.../words/Charades`); the name is not matched on, so every activity gets the ' +
				'charades list — no other activity has data yet.',
			parameters: [stringParam('activity', 'Activity name, e.g. `Charades`. Not matched on.')],
			responses: { 200: json(JsonArray, 'The word list') },
		}),
		(c) => c.json(charadesWords)
	)

	// Keepsakes (room mementos). Stubbed empty.
	.get(
		'/api/keepsakes/globalconfig',
		describeRoute({
			tags: ['Gameplay'],
			summary: 'Keepsake feature switches',
			description:
				'Whether keepsakes (room mementos) are on and how many a room may hold. The ' +
				'feature reports as enabled, but nothing stores keepsakes yet.',
			responses: { 200: json(KeepsakeConfig, 'The keepsake config') },
		}),
		(c) =>
			c.json({ KeepsakeFeatureEnabled: true, KeepsakeRoomLimit: 10, SocialXpBoostEnabled: false })
	)
	.get(
		'/api/keepsakes/rooms/:roomId',
		describeRoute({
			tags: ['Gameplay'],
			summary: 'A room’s keepsakes',
			description:
				'No keepsake storage yet. Answers 204 with no body rather than an empty list — ' +
				'that is what the reference does, and the client treats a body here as data.',
			parameters: [idParam('roomId', 'Room id')],
			responses: { 204: { description: 'No keepsakes (empty body)' } },
		}),
		(c) => c.body(null, 204)
	)
	.get(
		'/api/keepsakes/categories',
		describeRoute({
			tags: ['Gameplay'],
			summary: 'Keepsake categories',
			description: 'No keepsake catalog yet, so this is an empty list.',
			responses: { 200: json(JsonArray, 'An empty list') },
		}),
		(c) => c.json([])
	)

	// ---- Objectives / events / rewards ---------------------------------------
	// Objectives live on the `econ` host (`updateobjective` / `myprogress`), which is
	// where the client calls them — they are not served here.
	.get(
		'/api/communityboard/v2/current',
		describeRoute({
			tags: ['Gameplay'],
			summary: 'The current community board',
			description:
				'The rotating community board on the home screen. Not hydrated yet, so it is an ' +
				'empty object.',
			responses: { 200: json(JsonObject, 'An empty object') },
		}),
		(c) => c.json({})
	) // TODO: hydrate from JSON/communityboard.json
	.get(
		'/api/playerevents/v1/all',
		describeRoute({
			tags: ['Gameplay'],
			summary: 'The caller’s player events',
			description:
				'Events the player created and events they have RSVP’d to. No player-event ' +
				'storage yet, so both lists are empty.',
			responses: { 200: json(PlayerEventsAll, 'Two empty lists') },
		}),
		(c) => c.json({ Created: [], Responses: [] })
	)

	// The tag filter chips on the player-events browse screen. Derived from the tags in
	// use across events — we store no events, so there are no chips to offer.
	// `TrendingFilters` is null even in the reference (it needs recent-activity data).
	.get(
		'/api/playerevents/v1/tagfilters',
		describeRoute({
			tags: ['Gameplay'],
			summary: 'Player-event filter chips',
			description:
				'The filter chips on the player-events browse screen, derived from the tags in use ' +
				'across events. We store no events, so there are no chips to offer. ' +
				'`TrendingFilters` is null even in the reference — it needs recent-activity data.',
			responses: { 200: json(TagFilters, 'Empty chip lists') },
		}),
		(c) => c.json({ PinnedFilters: [], PopularFilters: [], TrendingFilters: null })
	)

	// Player events for a set of clubs (`?id=1&id=2`) — the events shelf on a club's
	// page. A bare array: the client deserializes this one as a list, and chokes on the
	// `{ ContinuationToken, Events }` envelope the single-club form uses. No
	// player-event storage yet, so the feed is empty.
	.get(
		'/api/playerevents/v1/clubs',
		describeRoute({
			tags: ['Gameplay'],
			summary: 'Player events across several clubs',
			description:
				'The events shelf for a set of clubs (`?id=1&id=2`). This form returns a BARE ' +
				'ARRAY — the client deserializes it as a list and chokes on the paged envelope the ' +
				'single-club form below uses. Do not unify the two. No player-event storage yet, ' +
				'so the feed is empty.',
			parameters: [intQuery('id', 'Repeatable club id')],
			responses: { 200: json(JsonArray, 'An empty list') },
		}),
		(c) => c.json([])
	)

	// The same feed for a single club (`/club/1`) — the form the reference serves,
	// which *does* wrap the events with a paging cursor (empty = no next page).
	.get(
		'/api/playerevents/v1/club/:clubId{[0-9]+}',
		describeRoute({
			tags: ['Gameplay'],
			summary: 'Player events for one club',
			description:
				'The same feed for a single club — and this form DOES wrap the events with a ' +
				'paging cursor, matching the reference. An empty `ContinuationToken` means no next ' +
				'page.',
			parameters: [idParam('clubId', 'Club id')],
			responses: { 200: json(PlayerEventsPage, 'An empty page') },
		}),
		(c) => c.json({ ContinuationToken: '', Events: [] })
	)
	.get(
		'/api/announcement/v1/get',
		describeRoute({
			tags: ['Gameplay'],
			summary: 'Announcements',
			description: 'The announcement banners on the home screen. Not hydrated yet.',
			responses: { 200: json(JsonArray, 'An empty list') },
		}),
		(c) => c.json([])
	) // TODO: hydrate from JSON/announcements.json

	// GameSight attribution/analytics event sink. Accept and ack without persisting.
	.post(
		'/api/gamesight/event',
		describeRoute({
			tags: ['Gameplay'],
			summary: 'Analytics event sink',
			description:
				'The client’s GameSight attribution/analytics events. Accepted and dropped — ' +
				'nothing is persisted. Answers 200 with an empty body.',
			responses: { 200: { description: 'Accepted (empty body)' } },
		}),
		(c) => c.body(null, 200)
	)

	// ---- Subscription ---------------------------------------------------------
	.post(
		'/api/CampusCard/v1/UpdateAndGetSubscription',
		describeRoute({
			tags: ['Gameplay'],
			summary: 'The caller’s subscription',
			description:
				'Rec Room Plus subscription state. There are no subscriptions on this server, so ' +
				'both fields are null. Also served by the `econ` worker on its own host.',
			responses: { 200: json(SubscriptionResponse, 'No subscription') },
		}),
		(c) => c.json({ subscription: null, platformAccountSubscribedPlayerId: null })
	)
