import { Hono } from 'hono'
import { useWorkersLogger } from 'workers-tagged-logger'

import { withNotFound, withOnError } from '@repo/hono-helpers'

import type { App } from './context'
import type { Context } from 'hono'
import { DEFAULT_AVATAR_ITEMS } from './default-avatar-items'
import apiConfigV2 from '../static/api-config-v2.json'
import gameConfigsV1All from '../static/gameconfigs-v1-all.json'
import storefrontGiftDrop2 from '../static/storefronts-v3-giftdropstore-2.json'
import storefrontGiftDrop3 from '../static/storefronts-v3-giftdropstore-3.json'
import storefrontGiftDrop300 from '../static/storefronts-v3-giftdropstore-300.json'
import { defaultSettings } from './default-settings'
import { validateAndGetAccountId } from './jwt'

/**
 * Ported from the C# `APIController`. Endpoints that the C# backs with EF Core
 * (`AppDbContext`) or on-disk JSON files are stubbed here — no bindings yet.
 * Auth-gated routes still validate the Bearer JWT issued by the `auth` worker.
 *
 * Placeholder responses for file-backed endpoints are marked `TODO: hydrate`.
 */

/**
 * Resolve the account id from a Bearer token, mirroring the repeated
 * auth-header check in the C#. Returns `null` when the header is missing,
 * the token is invalid, or the `sub` claim isn't an integer.
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

/** Mirror of the C# `ParseFormIds` helper — reads the `Ids` form field. */
async function parseFormIds(c: Context<App>): Promise<number[]> {
	const body = await c.req.parseBody().catch(() => ({}) as Record<string, unknown>)
	const ids = body.Ids
	if (typeof ids !== 'string') return []
	return ids
		.split(',')
		.map((s) => Number.parseInt(s.trim(), 10))
		.filter((n) => !Number.isNaN(n))
}

// strict: false so trailing-slash routes (e.g. `/gifts/consume/`) match either form.
const app = new Hono<App>({ strict: false })
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

	// ---- Config / version ----------------------------------------------------
	.get('/api/config/v1/amplitude', (c) => c.json({
		AmplitudeKey: "a",
		StatSigKey: "a",
		RudderStackKey: "a",
		UseRudderStack: false
	}))
	.get('/api/config/v2', (c) => c.json(apiConfigV2))
	.get('/api/versioncheck/v4', (c) => c.json({
		"VersionStatus": 0,
		"UpdateNotificationStage": 0,
		"IsVersionIslanded": false,
		"IsCrossPlayDisabled": false,
	}))
	.get('/api/gameconfigs/v1/all', (c) => c.json(gameConfigsV1All))

	// ---- Social ---------------------------------------------------------------
	.get('/api/relationships/v2/get', (c) => c.json([]))
	.get('/api/messages/v2/get', (c) => c.json([]))

	// ---- Reputation / progression --------------------------------------------
	.get('/api/playerReputation/v1/:id', (c) => {
		const id = Number.parseInt(c.req.param('id'), 10)
		return c.json({
			AccountId: id,
			Noteriety: 0,
			CheerGeneral: 0,
			CheerHelpful: 0,
			CheerCreative: 0,
			CheerGreatHost: 0,
			CheerSportsman: 0,
			CheerCredit: 20,
			SelectedCheer: null,
		})
	})
	.get('/api/players/v1/progression/:id', (c) => {
		const id = Number.parseInt(c.req.param('id'), 10)
		return c.json({ PlayerId: id, Level: 1, XP: 0 })
	})
	.post('/api/playerReputation/v1/bulk', (c) => c.json([])) // TODO: hydrate from JSON/bulkprogression.json
	.post('/api/players/v1/progression/bulk', async (c) => {
		await parseFormIds(c) // TODO: query PlayerProgressions for these ids
		return c.json([])
	})
	.post('/api/v1/progression/bulk', async (c) => {
		await parseFormIds(c) // TODO: query PlayerProgressions for these ids
		return c.json([])
	})

	// ---- Avatar ---------------------------------------------------------------
	.get('/api/avatar/v4/items', async (c) => {
		const id = await authedId(c)
		if (id === null) return unauthorized(c)
		// Owned items would be concatenated here; none without a DB binding.
		return c.json(DEFAULT_AVATAR_ITEMS)
	})
	.get('/api/avatar/v2', async (c) => {
		const id = await authedId(c)
		if (id === null) return unauthorized(c)
		// TODO: load/create PlayerAvatar for `id`.
		return c.json({ OutfitSelections: '', FaceFeatures: '{}', SkinColor: '', HairColor: '' })
	})
	.post('/api/avatar/v2/set', async (c) => {
		const id = await authedId(c)
		if (id === null) return unauthorized(c)
		const update = await c.req.json<Record<string, unknown>>().catch(() => null)
		if (update === null) return c.body(null, 400)
		// TODO: persist; echo the accepted avatar back like the C# does.
		return c.json({
			OwnerAccountId: id,
			OutfitSelections: update.OutfitSelections ?? '',
			FaceFeatures: update.FaceFeatures ?? '{}',
			SkinColor: update.SkinColor ?? '',
			HairColor: update.HairColor ?? '',
		})
	})
	.get('/api/avatar/v3/saved', async (c) => {
		const id = await authedId(c)
		if (id === null) return unauthorized(c)
		return c.json([]) // TODO: query SavedOutfits
	})
	.get('/api/avatar/v2/gifts', async (c) => {
		const id = await authedId(c)
		if (id === null) return unauthorized(c)
		return c.json([]) // TODO: query pending ReceivedGifts
	})
	.post('/api/avatar/v2/gifts/generate', async (c) => {
		const id = await authedId(c)
		if (id === null) return unauthorized(c)

		const body = await c.req.parseBody().catch(() => ({}) as Record<string, unknown>)
		const giftContext = typeof body.GiftContext === 'string' ? Number.parseInt(body.GiftContext, 10) || 0 : 0
		const message = typeof body.Message === 'string' ? body.Message : ''
		const xp = typeof body.Xp === 'string' ? Number.parseInt(body.Xp, 10) || 0 : 0

		// No EarnableRewards binding → always fall back to a token gift (C# branch).
		const tokenAmounts = [10, 25, 50, 100, 250, 500]
		const currency = tokenAmounts[Math.floor(Math.random() * tokenAmounts.length)]

		return c.json({
			Id: 0, // TODO: real id once gifts are persisted
			FromPlayerId: 1,
			ConsumableItemDesc: '',
			AvatarItemDesc: '',
			FriendlyName: '',
			AvatarItemType: 0,
			EquipmentPrefabName: '',
			EquipmentModificationGuid: '',
			CurrencyType: 2,
			Currency: currency,
			Xp: xp,
			Level: 0,
			Platform: -1,
			PlatformsToSpawnOn: -1,
			BalanceType: 0,
			GiftContext: giftContext,
			GiftRarity: 20,
			Message: message,
		})
	})
	.post('/api/avatar/v2/gifts/consume', async (c) => {
		const id = await authedId(c)
		if (id === null) return unauthorized(c)

		const body = await c.req.parseBody().catch(() => ({}) as Record<string, unknown>)
		const giftId = typeof body.Id === 'string' ? Number.parseInt(body.Id, 10) || 0 : 0
		if (giftId === 0) return c.json({ success: false, error: 'Invalid gift ID' }, 400)
		// No DB → gift can never be found.
		return c.json({ success: false, error: 'Gift not found' }, 404)
	})

	// ---- Player reporting -----------------------------------------------------
	.get('/api/PlayerReporting/v1/moderationBlockDetails', (c) =>
		c.json({
			ReportCategory: 0,
			Duration: 0,
			GameSessionId: 0,
			IsHostKick: false,
			Message: '',
			PlayerIdReporter: null,
			IsBan: false,
		})
	)
	.get('/api/PlayerReporting/v1/voteToKickReasons', (c) => c.json([])) // TODO: hydrate from JSON/vtkreasons.json
	.post('/api/PlayerReporting/v1/hile', (c) => c.body(null, 200))

	// ---- Settings -------------------------------------------------------------
	.get('/api/settings/v2', async (c) => {
		const id = await authedId(c)
		if (id === null) return unauthorized(c)
		// TODO: load stored settings; seed defaults on first access like the C#.
		return c.json(defaultSettings(id))
	})
	.post('/api/settings/v2/set', async (c) => {
		const id = await authedId(c)
		if (id === null) return unauthorized(c)
		// TODO: replace stored settings for `id`.
		return c.body(null, 200)
	})

	// ---- Inventory ------------------------------------------------------------
	.get('/api/equipment/v2/getUnlocked', (c) => c.json([]))
	.get('/api/consumables/v2/getUnlocked', async (c) => {
		const id = await authedId(c)
		if (id === null) return unauthorized(c)
		return c.json([]) // TODO: query ConsumableItems
	})

	// ---- Objectives / events / rewards ---------------------------------------
	.get('/api/objectives/v1/myprogress', (c) => c.json({})) // TODO: hydrate from JSON/tempmyprogress.json
	.post('/api/objectives/v1/updateobjective', (c) => c.body(null, 200))
	.get('/api/gamerewards/v1/pending', (c) => c.json([]))
	.get('/api/communityboard/v2/current', (c) => c.json({})) // TODO: hydrate from JSON/communityboard.json
	.get('/api/playerevents/v1/all', (c) => c.json({ Created: [], Responses: [] }))
	.get('/api/challenge/v2/getCurrent', (c) => c.json({})) // TODO: hydrate from JSON/weeklychallenge.json
	.get('/api/announcement/v1/get', (c) => c.json([])) // TODO: hydrate from JSON/announcements.json

	// ---- Subscription ---------------------------------------------------------
	.post('/api/CampusCard/v1/UpdateAndGetSubscription', (c) =>
		c.json({ subscription: null, platformAccountSubscribedPlayerId: null })
	)

	// ---- Storefronts ----------------------------------------------------------
	.get('/api/storefronts/v4/balance/2', async (c) => {
		const id = await authedId(c)
		if (id === null) return unauthorized(c)
		return c.json([]) // TODO: query TokenBalances
	})
	.get('/api/storefronts/v1/p2p/betaEnabled', (c) => c.json(false))
	.get('/api/storefronts/v3/giftdropstore/3', (c) => c.json(storefrontGiftDrop3))
	.get('/api/storefronts/v3/giftdropstore/300', (c) => c.json(storefrontGiftDrop300))
	.get('/api/storefronts/v3/giftdropstore/2', (c) => c.json(storefrontGiftDrop2))
	.post('/api/storefronts/v2/buyItem', async (c) => {
		const id = await authedId(c)
		if (id === null) return unauthorized(c)
		// No StorefrontItems binding → item can never be found.
		return c.json({ error: 'Item not found' }, 404)
	})

	// ---- Accounts -------------------------------------------------------------
	.get('/api/accounts/v1/getBio', async (c) => {
		const id = await authedId(c)
		if (id === null) return unauthorized(c)
		return c.json([]) // TODO: query PlayerBios
	})
	.post('/api/accounts/v1/forplatformids', async (c) => {
		await parseFormIds(c) // C# reads `Ids` then looks up CachedLogins
		return c.json([])
	})

	// ---- Room keys / quick play ----------------------------------------------
	.get('/api/roomkeys/v1/mine', (c) => c.json([]))
	.get('/api/roomkeys/v1/room', (c) => c.json([]))
	.get('/api/quickPlay/v1/getandclear', (c) =>
		c.json({ RoomName: null, ActionCode: null, TargetPlayerId: null })
	)

	// ---- Images ---------------------------------------------------------------
	.get('/api/images/v2/named', (c) => c.json([])) // TODO: hydrate from JSON/namedimages.json
	.post('/api/images/v4/uploadsaved', async (c) => {
		const body = await c.req.parseBody().catch(() => ({}) as Record<string, unknown>)
		const file = body.file
		if (!(file instanceof File)) return c.json({ error: 'No file found in request' }, 400)

		const valid = ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp']
		const dot = file.name.lastIndexOf('.')
		const ext = dot >= 0 ? file.name.slice(dot).toLowerCase() : ''
		const extension = valid.includes(ext) ? ext : '.png'

		// TODO: persist the upload (R2?). For now just mint a name.
		return c.json({ ImageName: crypto.randomUUID().replace(/-/g, '') + extension })
	})

	// ---- Rooms ----------------------------------------------------------------
	.get('/api/rooms/v1/filters', (c) => c.json([])) // TODO: hydrate from JSON/roomfilters.json

	// ---- Room server ----------------------------------------------------------
	// Register specific paths before the `/:id` param route.
	.get('/roomserver/rooms/bulk', (c) => {
		const idParam = c.req.query('id')
		const nameParam = c.req.query('name')
		if (!idParam && !nameParam) {
			return c.text("Either 'id' or 'name' query parameter is required", 400)
		}
		return c.json([]) // TODO: query Rooms + related tables
	})
	.get('/roomserver/rooms/hot', (c) => c.json({ Results: [], TotalResults: 0 }))
	.get('/roomserver/roomsandplaylists/hot', (c) => c.json({ Results: [], TotalResults: 0 }))
	.get('/roomserver/rooms/createdby/me', (c) => c.json([])) // TODO: hydrate from JSON/ownedrooms.json
	.get('/roomserver/rooms/:id/interactionby/me', (c) => c.json({ Cheered: false, Favorited: false }))
	.get('/roomserver/rooms/:id', (c) => {
		const roomId = Number.parseInt(c.req.param('id'), 10)
		if (Number.isNaN(roomId)) return c.notFound()
		// No Rooms binding → room can never be found.
		return c.notFound()
	})

export default app
