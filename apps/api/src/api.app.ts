import { Hono } from 'hono'
import { useWorkersLogger } from 'workers-tagged-logger'

import { withNotFound, withOnError } from '@repo/hono-helpers'

import apiConfigV2 from '../static/api-config-v2.json'
import gameConfigsV1All from '../static/gameconfigs-v1-all.json'
import storefrontGiftDrop2 from '../static/storefronts-v3-giftdropstore-2.json'
import storefrontGiftDrop3 from '../static/storefronts-v3-giftdropstore-3.json'
import storefrontGiftDrop300 from '../static/storefronts-v3-giftdropstore-300.json'
import { DEFAULT_AVATAR_ITEMS } from './default-avatar-items'
import { defaultSettings } from './default-settings'
import { validateAndGetAccountId } from './jwt'

import type { Context } from 'hono'
import type { App } from './context'

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

/** Unity scene id for the dorm (matches the match worker's instance location). */
const DORM_SCENE_ID = '76d98498-60a1-430c-ab76-b54a29b7a163'

/**
 * Full room payload (PascalCase), mirroring the C#'s `BuildRoomResponse` /
 * `RoomserverRoomsBulk`. With no Rooms DB, room 1 is the dorm and other ids get
 * a generic published room. The SubRoom carries the UnitySceneId/DataBlob the
 * client needs to load the scene.
 */
function buildRoomResponse(roomId: number) {
	const isDorm = roomId === 1
	return {
		RoomId: roomId,
		Name: isDorm ? 'DormRoom' : `Room${roomId}`,
		Description: isDorm ? 'Your private room' : '',
		CreatorAccountId: 1,
		ImageName: 'DefaultRoomImage.jpg',
		State: 0,
		Accessibility: 0,
		SupportsLevelVoting: false,
		IsRRO: false,
		IsDorm: isDorm,
		CloningAllowed: false,
		SupportsVRLow: true,
		SupportsQuest2: true,
		SupportsMobile: true,
		SupportsScreens: true,
		SupportsWalkVR: true,
		SupportsTeleportVR: true,
		SupportsJuniors: true,
		MinLevel: 0,
		WarningMask: 0,
		CustomWarning: null,
		DisableMicAutoMute: false,
		DisableRoomComments: false,
		EncryptVoiceChat: false,
		CreatedAt: '2026-01-18T02:31:37.6171131',
		Stats: { CheerCount: 0, FavoriteCount: 0, VisitorCount: 1, VisitCount: 1 },
		SubRooms: [
			{
				SubRoomId: 1,
				Name: '',
				DataBlob: '',
				IsSandbox: false,
				MaxPlayers: 4,
				Accessibility: 0,
				UnitySceneId: isDorm ? DORM_SCENE_ID : '',
				DataSavedAt: '2026-01-18T02:31:37.6171131',
			},
		],
		Roles: [],
		LoadScreens: [],
		PromoImages: [],
		PromoExternalContent: [],
		Tags: [],
	}
}

/** Default reputation for an account — the fallback the C# fills with no DB. */
function defaultReputation(id: number) {
	return {
		AccountId: id,
		Noteriety: 0,
		CheerGeneral: 0,
		CheerHelpful: 0,
		CheerCreative: 0,
		CheerGreatHost: 0,
		CheerSportsman: 0,
		CheerCredit: 20,
		SelectedCheer: null,
	}
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
	.get('/api/config/v1/amplitude', (c) =>
		c.json({
			AmplitudeKey: 'a',
			StatSigKey: 'a',
			RudderStackKey: 'a',
			UseRudderStack: false,
		})
	)
	.get('/api/config/v1/azurespeech', (c) =>
		c.json({
			Key: 'dce8de5b297747d9b5bddcc7f19e8c5b',
			Region: 'eastus',
			Enabled: false,
		})
	)
	.get('/api/config/v1/backtrace', (c) =>
		c.json({
			ReportBudget: 125,
			FilterType: 0,
			SampleRate: 0.025,
			LogLineCount: 50,
			CaptureNativeCrashes: 1,
			AMRThresholdMS: 0,
			MessageCount: 1000,
			MessageRegex:
				"^Cannot set the parent of the GameObject .* while its new parent|^\\\\>\\\\x2010x\\\\:\\\\x20|\\\\'LabelTheme\\\\' contains missing PaletteTheme reference on",
			VersionRegex: '.*',
		})
	)
	.get('/api/config/v2', (c) => c.json(apiConfigV2))
	.get('/api/versioncheck/v4', (c) =>
		c.json({
			VersionStatus: 0,
			UpdateNotificationStage: 0,
			IsVersionIslanded: false,
			IsCrossPlayDisabled: false,
		})
	)
	.get('/api/gameconfigs/v1/all', (c) => c.json(gameConfigsV1All))

	// ---- Social ---------------------------------------------------------------
	.get('/api/relationships/v2/get', (c) => c.json([]))
	.get('/api/messages/v2/get', (c) => c.json([]))

	// ---- Reputation / progression --------------------------------------------
	.get('/api/playerReputation/v1/:id', (c) =>
		c.json(defaultReputation(Number.parseInt(c.req.param('id'), 10)))
	)
	.get('/api/players/v1/progression/:id', (c) => {
		const id = Number.parseInt(c.req.param('id'), 10)
		return c.json({ PlayerId: id, Level: 1, XP: 0 })
	})
	.post('/api/playerReputation/v1/bulk', (c) => c.json([])) // TODO: hydrate from JSON/bulkprogression.json
	// Synthesize a default reputation per requested id (the C#'s intended
	// behavior; its DB-less fallback reads a static JSON file instead).
	.post('/api/playerReputation/v2/bulk', async (c) => {
		const ids = await parseFormIds(c)
		return c.json(ids.map(defaultReputation))
	})
	.post('/api/players/v1/progression/bulk', async (c) => {
		await parseFormIds(c) // TODO: query PlayerProgressions for these ids
		return c.json([])
	})
	// C# v2 is identical to v1 — same ParseFormIds + PlayerProgressions query.
	.post('/api/players/v2/progression/bulk', async (c) => {
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
		const giftContext =
			typeof body.GiftContext === 'string' ? Number.parseInt(body.GiftContext, 10) || 0 : 0
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

	// Custom avatar item gates. None of these are in CannedNet — they're real Rec
	// Room client endpoints the C# never implemented. Each returns a bare JSON
	// boolean; we enable them. Flip to `false` to disable the corresponding flow.
	.get('/api/customAvatarItems/v1/isCreationAllowedForAccount', (c) => c.json(true))
	.get('/api/customAvatarItems/v1/isCreationEnabled', (c) => c.json(true))
	.get('/api/customAvatarItems/v1/isRenderingEnabled', (c) => c.json(true))

	// Voice chat config. Not in CannedNet; the client fetches it to set up voice.
	// No reference shape, so return an empty object until the client needs fields.
	.get('/voice/config', (c) => c.json({}))

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
	.post('/api/PlayerReporting/v1/hile', (c) => c.json(false))

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
		// Synthesize a room per requested id (the client needs SubRooms to load).
		// TODO: query Rooms + related tables once a DB binding exists.
		const ids = (idParam ?? '')
			.split(',')
			.map((s) => Number.parseInt(s.trim(), 10))
			.filter((n) => !Number.isNaN(n))
		return c.json(ids.map(buildRoomResponse))
	})
	.get('/roomserver/rooms/hot', (c) => c.json({ Results: [], TotalResults: 0 }))
	.get('/roomserver/roomsandplaylists/hot', (c) => c.json({ Results: [], TotalResults: 0 }))
	.get('/roomserver/rooms/createdby/me', (c) => c.json([buildRoomResponse(1)]))
	.get('/roomserver/rooms/:id/interactionby/me', (c) =>
		c.json({ Cheered: false, Favorited: false })
	)
	.get('/roomserver/rooms/:id', (c) => {
		const roomId = Number.parseInt(c.req.param('id'), 10)
		if (Number.isNaN(roomId)) return c.notFound()
		// No Rooms binding → synthesize the room so the client can load it.
		return c.json(buildRoomResponse(roomId))
	})

export default app
