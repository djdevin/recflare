import { Hono } from 'hono'
import { useWorkersLogger } from 'workers-tagged-logger'

import { withNotFound, withOnError } from '@repo/hono-helpers'

import defaultAvatar from '../static/default-avatar.json'
import defaultAvatarItems from '../static/default-avatar-items.json'
import myProgress from '../static/my-progress.json'
import storefrontGiftDrop3 from '../static/storefronts-v3-giftdropstore-3.json'
import weeklyChallenge from '../static/weekly-challenge.json'
import { validateAndGetAccountId } from './jwt'

import type { Context } from 'hono'
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
	const accountId = await validateAndGetAccountId(token)
	if (!accountId) return null

	const id = Number.parseInt(accountId, 10)
	return Number.isNaN(id) ? null : id
}

/** Results.Unauthorized() equivalent — 401 with empty body. */
function unauthorized(c: Context<App>) {
	return c.body(null, 401)
}

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

	// Default base avatar items. The C# reads the same JSON/defaultAvatarItems.json
	// file as defaultunlocked, so it returns the identical catalog.
	.get('/api/avatar/v1/defaultbaseavataritems', (c) => c.json(defaultAvatarItems))

	// The player's avatar items — owned items concatenated with the default
	// catalog. No DB binding yet, so owned is empty and this is just the catalog.
	.get('/api/avatar/v4/items', async (c) => {
		const id = await authedId(c)
		if (id === null) return unauthorized(c)
		// TODO: prepend the player's owned AvatarItems once a DB binding exists.
		return c.json(defaultAvatarItems)
	})

	// The player's owned custom avatar items. No auth in the C#, which returns
	// `{ items: [] }`. The client downloads these when custom-item creation is
	// allowed; a 404 here surfaces as "Failed to download unlocked avatar items".
	.get('/econ/customAvatarItems/v1/owned', (c) => c.json({ items: [] }))

	// The player's objectives progress. The C# serves a static JSON file
	// (JSON/tempmyprogress.json) verbatim with no auth — same default for everyone
	// until there's a DB binding to track per-player progress.
	.get('/api/objectives/v1/myprogress', (c) => c.json(myProgress))

	// The player's avatar. No DB binding yet, so it always returns the default
	// the C# seeds for a player with no PlayerAvatar row.
	.get('/api/avatar/v2', async (c) => {
		const id = await authedId(c)
		if (id === null) return unauthorized(c)
		// TODO: load/create the PlayerAvatar for `id` once a DB binding exists.
		// Must return a populated outfit — the client's parser NREs on an empty
		// OutfitSelections (real RecNet never returns one), so serve a valid default.
		return c.json(defaultAvatar)
	})

	// NUX checklist — the client fetches this on the econ host during load. []
	// with no DB. A 404 here can abort the load orchestration before matchmake.
	.get('/api/checklist/v1/current', async (c) => {
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

	// Unlocked equipment. The C# returns "[]" with no auth.
	.get('/api/equipment/v2/getUnlocked', (c) => c.json([]))

	// Not in CannedNet — room consumables/currencies for a given room. Stubbed
	// as empty lists so the client doesn't 404.
	.get('/api/roomconsumables/v1/roomConsumable/room/:roomId', (c) => c.json([]))
	.get('/api/roomconsumables/v1/roomConsumable/room/:roomId/me', (c) => c.json([]))
	.get('/api/roomcurrencies/v1/currencies', (c) => c.json([]))
	.get('/api/roomcurrencies/v1/getAllBalances', (c) => c.json([]))

	// Persist player settings. [Authorize]; the C# replaces the player's settings
	// and returns Ok(). No DB binding yet, so accept-and-ack.
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

	// Token balance. [Authorize]; empty without a DB binding.
	.get('/api/storefronts/v4/balance/2', async (c) => {
		const id = await authedId(c)
		if (id === null) return unauthorized(c)
		// TODO: query TokenBalances once a DB binding exists.
		return c.json([])
	})

	// Gift-drop storefront. The C# falls back to JSON/storefront3.json when no
	// storefront row exists; that's the bundled static catalog here.
	.get('/api/storefronts/v3/giftdropstore/3', (c) => c.json(storefrontGiftDrop3))

	// Current weekly challenge. Served from the bundled static JSON (the C#'s
	// JSON/weeklychallenge.json) until per-rotation challenge data is wired up.
	.get('/api/challenge/v2/getCurrent', (c) => c.json(weeklyChallenge))

	// Pending game rewards. The C# returns "[]".
	.get('/api/gamerewards/v1/pending', (c) => c.json([]))

	// The player's room keys. The C# returns "[]".
	.get('/api/roomkeys/v1/mine', (c) => c.json([]))
	// Room keys for a given room (client calls this on the econ host). [] with no DB.
	.get('/api/roomkeys/v1/room', (c) => c.json([]))

	// Subscription lookup. The C# returns both fields null with no auth.
	.post('/api/CampusCard/v1/UpdateAndGetSubscription', (c) =>
		c.json({ subscription: null, platformAccountSubscribedPlayerId: null })
	)

export default app
