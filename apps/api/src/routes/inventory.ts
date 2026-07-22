import { Hono } from 'hono'
import { describeRoute } from 'hono-openapi'

import { authedId, unauthorized } from '../http'
import { AUTHED, json, JsonArray, UNAUTHORIZED_RESPONSE } from '../openapi'

import type { App } from '../context'

// ---- Inventory -------------------------------------------------------------
// The equipment/consumables the client actually reads are served by the `econ` worker,
// on the econ host. These are the same paths on this host, kept as stubs because some
// client builds probe them here first.
export const inventoryRoutes = new Hono<App>({ strict: false })
	.get(
		'/api/equipment/v2/getUnlocked',
		describeRoute({
			tags: ['Inventory'],
			summary: 'Unlocked equipment',
			description:
				'A stub on this host — the real inventory lives in the `econ` worker, which serves ' +
				'this same path with the player’s equipment. Always an empty list here, and ' +
				'unlike the econ route it does not require a token.',
			responses: { 200: json(JsonArray, 'An empty list') },
		}),
		(c) => c.json([])
	)
	.get(
		'/api/consumables/v2/getUnlocked',
		describeRoute({
			tags: ['Inventory'],
			summary: 'Unlocked consumables',
			description:
				'A stub on this host — the real consumables live in the `econ` worker. Auth-gated ' +
				'even so, then always an empty list.',
			security: AUTHED,
			responses: {
				200: json(JsonArray, 'An empty list'),
				401: UNAUTHORIZED_RESPONSE,
			},
		}),
		async (c) => {
			const id = await authedId(c)
			if (id === null) return unauthorized(c)
			return c.json([]) // TODO: query ConsumableItems
		}
	)
