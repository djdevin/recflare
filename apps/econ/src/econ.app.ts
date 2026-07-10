import { Hono } from 'hono'
import { useWorkersLogger } from 'workers-tagged-logger'

import { withNotFound, withOnError } from '@repo/hono-helpers'
import { validateAndGetAccountId } from '@repo/jwt'

import defaultAvatarItems from '../static/default-avatar-items.json'
import defaultAvatar from '../static/default-avatar.json'
import myProgress from '../static/my-progress.json'
import weeklyChallenge from '../static/weekly-challenge.json'
import { getAvatar, setAvatar } from './avatar-db'

import type { Context } from 'hono'
import type { Avatar } from './avatar-db'
import type { App } from './context'

/**
 * Economy Worker. Hosts the avatar/economy endpoints the game client calls on
 * the `econ` service (these are separate from the main `api` worker). DB-backed
 * data is stubbed for now — no bindings yet.
 *
 * Auth-gated routes still validate the Bearer JWT issued by the `auth` worker.
 */

/**
 * Resolve the account id from a Bearer token. Returns `null` when the header is
 * missing, the token is invalid, or the `sub` claim isn't an integer.
 */
async function authedId(c: Context<App>): Promise<number | null> {
	const authHeader = c.req.header('Authorization') ?? ''
	if (!authHeader.toLowerCase().startsWith('bearer ')) return null

	const token = authHeader.slice('Bearer '.length)
	const accountId = await validateAndGetAccountId(token, await c.env.JWT_SECRET.get())
	if (!accountId) return null

	const id = Number.parseInt(accountId, 10)
	return Number.isNaN(id) ? null : id
}

/** Results.Unauthorized() equivalent — 401 with empty body. */
function unauthorized(c: Context<App>) {
	return c.body(null, 401)
}

/**
 * Project a stored avatar into the public render subset returned by
 * `GET /api/avatar/v2/:id` — the fields needed to draw another player's avatar
 * (the full blob also holds `OutfitSelectionsV2`/`CustomAvatarItems`, which this
 * view omits).
 */
function toAvatarV2Dto(avatar: Avatar) {
	return {
		OutfitSelections: avatar.OutfitSelections,
		FaceFeatures: avatar.FaceFeatures,
		SkinColor: avatar.SkinColor,
		HairColor: avatar.HairColor,
	}
}

/** RecNet currency types (the `CurrencyType` enum the client uses). */
const CurrencyType = {
	Invalid: 0,
	LaserTagTickets: 1,
	RecCenterTokens: 2,
	LostSkullsGold: 100,
	DraculaSilver: 101,
	RecRoyaleSeason1: 200,
	RoomCurrency: 300,
	RoomInventoryItem: 301,
	ProgressionEvent: 400,
} as const

const app = new Hono<App>()
	.use(
		'*',
		// middleware
		(c, next) =>
			useWorkersLogger(c.env.NAME, {
				environment: c.env.ENVIRONMENT,
				release: c.env.SENTRY_RELEASE,
			})(c, next)
	)

	.onError(withOnError())
	.notFound(withNotFound())

	// Default-unlocked avatar items, served from the bundled static JSON.
	.get('/api/avatar/v1/defaultunlocked', (c) => c.json(defaultAvatarItems))

	// Default base avatar items — empty stub for now. No auth.
	.get('/api/avatar/v1/defaultbaseavataritems', (c) => c.json([]))

	// The player's avatar items — owned items concatenated with the default
	// catalog. No DB binding yet, so owned is empty and this is just the catalog.
	.get('/api/avatar/v4/items', async (c) => {
		const id = await authedId(c)
		if (id === null) return unauthorized(c)
		// TODO: prepend the player's owned AvatarItems once a DB binding exists.
		return c.json(defaultAvatarItems)
	})

	// The player's owned custom avatar items. [Authorize]; paginated. Empty stub for
	// now (no DB binding). The client downloads these when custom-item creation is
	// allowed; a 404 here surfaces as "Failed to download unlocked avatar items".
	.get('/econ/customAvatarItems/v1/owned', async (c) => {
		const id = await authedId(c)
		if (id === null) return unauthorized(c)
		return c.json({ Results: [], TotalResults: 0 })
	})

	// The player's objectives progress. Serves a static JSON file verbatim with
	// no auth — same default for everyone until there's a DB binding to track
	// per-player progress.
	.get('/api/objectives/v1/myprogress', (c) => c.json(myProgress))

	// The player's avatar, stored as a JSON blob on their account row. Falls back
	// to the default outfit when they haven't saved one — the client's parser NREs
	// on an empty OutfitSelections (real RecNet never returns one).
	.get('/api/avatar/v2', async (c) => {
		const id = await authedId(c)
		if (id === null) return unauthorized(c)
		return c.json((await getAvatar(c.env.DB, id)) ?? defaultAvatar)
	})

	// Save the player's avatar. [Authorize]. Stores the posted JSON payload verbatim
	// on the account row and echoes it back. 400 on a non-object body; 404 when the
	// caller has no account row to attach it to.
	.post('/api/avatar/v2/set', async (c) => {
		const id = await authedId(c)
		if (id === null) return unauthorized(c)
		const avatar = (await c.req.json().catch(() => null)) as Record<string, unknown> | null
		if (avatar === null || typeof avatar !== 'object' || Array.isArray(avatar)) {
			return c.body(null, 400)
		}
		if (!(await setAvatar(c.env.DB, id, avatar))) return c.body(null, 404)
		return c.json(avatar)
	})

	// NUX checklist — the client fetches this on the econ host during load. []
	// with no DB. A 404 here can abort the load orchestration before matchmake.
	.get('/api/checklist/v1/current', async (c) => {
		const id = await authedId(c)
		if (id === null) return unauthorized(c)
		return c.json([])
	})

	// The player's item wishlist. [Authorize]; empty without a DB binding.
	.get('/api/itemWishlists/v1/wishlist/me', async (c) => {
		const id = await authedId(c)
		if (id === null) return unauthorized(c)
		return c.json([])
	})

	// The player's saved outfits. [Authorize]; empty without a DB binding.
	.get('/api/avatar/v3/saved', async (c) => {
		const id = await authedId(c)
		if (id === null) return unauthorized(c)
		// TODO: query SavedOutfits once a DB binding exists.
		return c.json([])
	})

	// Pending avatar gifts for the player. [Authorize]; empty without a DB binding.
	.get('/api/avatar/v2/gifts', async (c) => {
		const id = await authedId(c)
		if (id === null) return unauthorized(c)
		// TODO: query pending ReceivedGifts once a DB binding exists.
		return c.json([])
	})

	// A player's avatar by account id, projected to the public render subset (used
	// to draw other players' avatars). No auth — like the accounts `/account/:id`
	// lookup. Falls back to the default outfit when the player hasn't saved one.
	// Registered after the static `/api/avatar/v2/*` routes so `:id` can't shadow them.
	.get('/api/avatar/v2/:id', async (c) => {
		const accountId = Number.parseInt(c.req.param('id'), 10)
		if (Number.isNaN(accountId)) return c.body(null, 400)
		return c.json(toAvatarV2Dto((await getAvatar(c.env.DB, accountId)) ?? defaultAvatar))
	})

	// Unlocked equipment. Returns "[]" with no auth.
	.get('/api/equipment/v2/getUnlocked', (c) => c.json([]))

	// Room consumables/currencies for a given room. Stubbed as empty lists so the
	// client doesn't 404.
	.get('/api/roomconsumables/v1/roomConsumable/room/:roomId', (c) => c.json([]))
	.get('/api/roomconsumables/v1/roomConsumable/room/:roomId/me', (c) => c.json([]))
	.get('/api/roomcurrencies/v1/currencies', (c) => c.json([]))
	.get('/api/roomcurrencies/v1/getAllBalances', (c) => c.json([]))

	// Persist player settings. [Authorize]; would replace the player's settings.
	// No DB binding yet, so accept-and-ack.
	.post('/api/settings/v2/set', async (c) => {
		const id = await authedId(c)
		if (id === null) return unauthorized(c)
		// TODO: replace stored settings for `id` once a DB binding exists.
		return c.body(null, 200)
	})

	// Unlocked consumables. [Authorize]; empty without a DB binding.
	.get('/api/consumables/v2/getUnlocked', async (c) => {
		const id = await authedId(c)
		if (id === null) return unauthorized(c)
		// TODO: query ConsumableItems once a DB binding exists.
		return c.json([])
	})

	// Token balance. [Authorize]. The `2` in the path is the RecCenterTokens
	// CurrencyType. The balance is a fake test value (a large amount) until a DB
	// binding tracks real balances; Platform -2 means "all platforms".
	.get('/api/storefronts/v4/balance/2', async (c) => {
		const id = await authedId(c)
		if (id === null) return unauthorized(c)
		// TODO: query TokenBalances once a DB binding exists.
		return c.json([
			{ CurrencyType: CurrencyType.RecCenterTokens, Platform: -2, Balance: 2147483648 },
		])
	})

	// Gift-drop storefront. Serves `static/storefronts/sf{id}.json` for the requested
	// storefront id via the ASSETS binding; 404s when no such catalog exists.
	.get('/api/storefronts/v3/giftdropstore/:id', async (c) => {
		const id = c.req.param('id')
		const res = await c.env.ASSETS.fetch(new URL(`/sf${id}.json`, c.req.url))
		if (!res.ok) return c.notFound()
		return c.json(await res.json())
	})

	// Current weekly challenge. Served from the bundled static JSON until
	// per-rotation challenge data is wired up.
	.get('/api/challenge/v2/getCurrent', (c) => c.json(weeklyChallenge))

	// Pending game rewards. Returns "[]".
	.get('/api/gamerewards/v1/pending', (c) => c.json([]))

	// The player's room keys. Returns "[]".
	.get('/api/roomkeys/v1/mine', (c) => c.json([]))
	// Room keys for a given room (client calls this on the econ host). [] with no DB.
	.get('/api/roomkeys/v1/room', (c) => c.json([]))

	// Subscription lookup. Returns both fields null with no auth.
	.post('/api/CampusCard/v1/UpdateAndGetSubscription', (c) =>
		c.json({ subscription: null, platformAccountSubscribedPlayerId: null })
	)

export default app
