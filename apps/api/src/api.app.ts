import { Hono } from 'hono'
import { useWorkersLogger } from 'workers-tagged-logger'

import { withNotFound, withOnError } from '@repo/hono-helpers'

import apiConfigV2 from '../static/api-config-v2.json'
import defaultAvatar from '../static/default-avatar.json'
import gameConfigsV1All from '../static/gameconfigs-v1-all.json'
import storefrontGiftDrop2 from '../static/storefronts-v3-giftdropstore-2.json'
import storefrontGiftDrop3 from '../static/storefronts-v3-giftdropstore-3.json'
import storefrontGiftDrop300 from '../static/storefronts-v3-giftdropstore-300.json'
import { DEFAULT_AVATAR_ITEMS } from './default-avatar-items'
import { defaultSettings } from './default-settings'
import { validateAndGetAccountId } from './jwt'
import { getRoomById, getRoomByName, getRoomsByCreator, getRoomsByIds } from './rooms-db'

import type { Context } from 'hono'
import type { App } from './context'

/**
 * The Game API surface. Endpoints that would be backed by a database or on-disk
 * JSON files are stubbed here — no bindings yet.
 * Auth-gated routes still validate the Bearer JWT issued by the `auth` worker.
 *
 * Placeholder responses for file-backed endpoints are marked `TODO: hydrate`.
 */

/** Saved-image categories from the C# `SavedImageType` enum (`imgMeta.savedImageType`). */
const SavedImageType = {
	None: 0,
	ShareCamera: 1,
	OutfitThumbnail: 2,
	RoomThumbnail: 3,
	ProfileThumbnail: 4,
	InventionThumbnail: 5,
} as const

/**
 * Resolve the account id from a Bearer token, mirroring the repeated
 * auth-header check. Returns `null` when the header is missing,
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

/** Reads the `Ids` form field into a list of integer ids. */
async function parseFormIds(c: Context<App>): Promise<number[]> {
	const body = await c.req.parseBody().catch(() => ({}) as Record<string, unknown>)
	const ids = body.Ids
	if (typeof ids !== 'string') return []
	return ids
		.split(',')
		.map((s) => Number.parseInt(s.trim(), 10))
		.filter((n) => !Number.isNaN(n))
}

/** Read integer ids from repeated/comma-separated `id` query params. The 2023
 * client passes these to the bulk GET endpoints (e.g. `?id=1&id=2`). */
function queryIds(c: Context<App>): number[] {
	return (
		c.req
			.queries('id')
			?.flatMap((v) => v.split(','))
			.map((s) => Number.parseInt(s.trim(), 10))
			.filter((n) => !Number.isNaN(n)) ?? []
	)
}

/**
 * Photon access-token response (`/roomserver/photon_access_token`). The 2023
 * client calls this to get its room permissions + the instance id it's spawning
 * into; a 404 here leaves the player stuck on a black screen. `PhotonAccessToken`
 * is empty — the client uses its baked-in Photon credentials. Our synthesized
 * instances always use roomInstanceId 1.
 */
function photonAccessToken() {
	const perm = (Permission: string, Role: number, Override: boolean) => ({
		Override,
		Permission,
		Role,
		Type: 0,
		Value: 'True',
	})
	return {
		Permissions: [
			perm('CAN_USE_ROOM_RESET_BUTTON', 0, true),
			perm('CAN_USE_DELETE_ALL_BUTTON', 0, true),
			perm('CAN_SAVE_INVENTIONS', 0, true),
			perm('CAN_SPAWN_INVENTIONS', 0, true),
			perm('CAN_USE_PLAY_GIZMOS_TOGGLE', 0, true),
			perm('CAN_USE_MAKER_PEN', 30, false),
			perm('CAN_USE_ROOM_RESET_BUTTON', 30, true),
			perm('CAN_USE_DELETE_ALL_BUTTON', 30, true),
			perm('CAN_SAVE_INVENTIONS', 30, true),
			perm('CAN_SPAWN_INVENTIONS', 30, true),
			perm('CAN_USE_PLAY_GIZMOS_TOGGLE', 30, true),
		],
		PhotonAccessToken: '',
		RoomInstanceId: 1,
	}
}

/** Default reputation for an account — the fallback used with no DB. */
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
	// Synthesize a default reputation per requested id (the intended behavior;
	// the DB-less fallback reads a static JSON file instead).
	.post('/api/playerReputation/v2/bulk', async (c) => {
		const ids = await parseFormIds(c)
		return c.json(ids.map(defaultReputation))
	})
	// The 2023 client calls this as a GET with repeated `id` query params.
	.get('/api/playerReputation/v2/bulk', (c) => c.json(queryIds(c).map(defaultReputation)))
	.post('/api/players/v1/progression/bulk', async (c) => {
		await parseFormIds(c) // TODO: query PlayerProgressions for these ids
		return c.json([])
	})
	// v2 is identical to v1 — same form-id parse + PlayerProgressions query.
	.post('/api/players/v2/progression/bulk', async (c) => {
		await parseFormIds(c) // TODO: query PlayerProgressions for these ids
		return c.json([])
	})
	// The 2023 client calls this as a GET with repeated `id` query params.
	// Return a default progression per requested id.
	.get('/api/players/v2/progression/bulk', (c) =>
		c.json(queryIds(c).map((id) => ({ PlayerId: id, Level: 1, XP: 0 })))
	)
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
		// TODO: load/create PlayerAvatar for `id`. Must return a populated outfit —
		// the client NREs on an empty OutfitSelections — so serve a valid default.
		return c.json(defaultAvatar)
	})
	.post('/api/avatar/v2/set', async (c) => {
		const id = await authedId(c)
		if (id === null) return unauthorized(c)
		const update = await c.req.json<Record<string, unknown>>().catch(() => null)
		if (update === null) return c.body(null, 400)
		// TODO: persist; echo the accepted avatar back. Fall back to the valid
		// default avatar fields when the client omits them.
		return c.json({
			OwnerAccountId: id,
			OutfitSelections: update.OutfitSelections ?? defaultAvatar.OutfitSelections,
			FaceFeatures: update.FaceFeatures ?? defaultAvatar.FaceFeatures,
			SkinColor: update.SkinColor ?? defaultAvatar.SkinColor,
			HairColor: update.HairColor ?? defaultAvatar.HairColor,
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

		// No EarnableRewards binding → always fall back to a token gift.
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

	// Custom avatar item gates — real Rec Room client endpoints with no backing
	// implementation yet. Each returns a bare JSON boolean; we enable them. Flip
	// to `false` to disable the corresponding flow.
	.get('/api/customAvatarItems/v1/isCreationAllowedForAccount', (c) => c.json(true))
	.get('/api/customAvatarItems/v1/isCreationEnabled', (c) => c.json(true))
	.get('/api/customAvatarItems/v1/isRenderingEnabled', (c) => c.json(true))

	// Voice chat config. The client fetches it to set up voice.
	// No reference shape, so return an empty object until the client needs fields.
	.get('/voice/config', (c) => c.json({}))

	// ---- 2023 client loading-path endpoints ------------------------------------
	// NUX checklist + saved inventions — empty lists with no DB.
	.get('/api/checklist/v1/current', async (c) => {
		const id = await authedId(c)
		if (id === null) return unauthorized(c)
		return c.json([])
	})
	.get('/api/inventions/v2/mine', (c) => c.json([]))

	// Text sanitization (display names, room names, chat). `v1` echoes the input
	// value back; `isPure` reports the text is clean. The client sanitizes text
	// during load/display, so a 404 here can stall room entry.
	.post('/api/sanitize/v1', async (c) => {
		const body = await c.req.json<{ Value?: unknown }>().catch(() => ({}) as { Value?: unknown })
		return c.json(typeof body.Value === 'string' ? body.Value : '')
	})
	.post('/api/sanitize/v1/isPure', (c) => c.json({ IsPure: true }))

	// Keepsakes (room mementos). Shapes from the 2025 reference; categories isn't
	// in any reference, so it's stubbed empty. The client fetches these on room
	// entry — a 404 stalls the load.
	.get('/api/keepsakes/globalconfig', (c) =>
		c.json({ KeepsakeFeatureEnabled: true, KeepsakeRoomLimit: 10, SocialXpBoostEnabled: false })
	)
	.get('/api/keepsakes/rooms/:roomId', (c) => c.body(null, 204))
	.get('/api/keepsakes/categories', (c) => c.json([]))

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
		// TODO: load stored settings; seed defaults on first access.
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

	// GameSight attribution/analytics event sink. Accept and ack without persisting.
	.post('/api/gamesight/event', (c) => c.body(null, 200))

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
		await parseFormIds(c) // reads `Ids` then looks up CachedLogins
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
		const id = await authedId(c)
		if (id === null) return unauthorized(c)

		const body = await c.req.parseBody().catch(() => ({}) as Record<string, unknown>)
		// The client posts the file as `image`; accept `file` too for safety.
		const candidate = body.image ?? body.file
		if (!(candidate instanceof File)) return c.json({ error: 'No file found in request' }, 400)
		const file = candidate

		// `imgMeta` is a JSON blob describing the upload; its `savedImageType`
		// decides what (if anything) the image is recorded against. Mirrors the C#
		// `SavedImageMetaDTO` / `SavedImageType` enum.
		let savedImageType: number = SavedImageType.None
		if (typeof body.imgMeta === 'string') {
			try {
				const meta = JSON.parse(body.imgMeta) as { savedImageType?: unknown } | null
				if (meta && typeof meta.savedImageType === 'number') savedImageType = meta.savedImageType
			} catch {
				// Malformed imgMeta — treat as an untyped upload (still stored).
			}
		}

		const valid = ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp']
		const dot = file.name.lastIndexOf('.')
		const ext = dot >= 0 ? file.name.slice(dot).toLowerCase() : ''
		const extension = valid.includes(ext) ? ext : '.jpg'

		// Store the upload in the shared image bucket under a random key. The `img`
		// worker serves it back by that key, which is the returned ImageName.
		const name = crypto.randomUUID().replace(/-/g, '') + extension
		await c.env.IMAGES.put(name, await file.arrayBuffer(), {
			httpMetadata: { contentType: file.type || 'image/jpeg' },
		})

		// A profile thumbnail becomes the account's avatar — persist it on the
		// account row (a JSON blob in the shared accounts table) so it sticks.
		if (savedImageType === SavedImageType.ProfileThumbnail) {
			await c.env.DB.prepare(
				"UPDATE accounts SET data = json_set(data, '$.ProfileImage', ?2) WHERE account_id = ?1"
			)
				.bind(id, name)
				.run()
		}

		return c.json({ ImageName: name })
	})

	// ---- Rooms ----------------------------------------------------------------
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

	// ---- Room server ----------------------------------------------------------
	// Room data is read from the shared `rec-rooms` D1 (owned by the rooms worker).
	// Register specific paths before the `/:id` param route.
	.get('/roomserver/rooms/bulk', async (c) => {
		const idParam = c.req.query('id')
		const nameParam = c.req.query('name')
		if (!idParam && !nameParam) {
			return c.text("Either 'id' or 'name' query parameter is required", 400)
		}
		if (idParam) {
			const ids = idParam
				.split(',')
				.map((s) => Number.parseInt(s.trim(), 10))
				.filter((n) => !Number.isNaN(n))
			return c.json(await getRoomsByIds(c.env.DB, ids))
		}
		const room = await getRoomByName(c.env.DB, nameParam ?? '')
		return c.json(room ? [room] : [])
	})
	// Photon access token + room permissions the client needs to spawn into a room.
	.get('/roomserver/photon_access_token', (c) => c.json(photonAccessToken()))
	.get('/roomserver/rooms/hot', (c) => c.json({ Results: [], TotalResults: 0 }))
	.get('/roomserver/roomsandplaylists/hot', (c) => c.json({ Results: [], TotalResults: 0 }))
	.get('/roomserver/rooms/createdby/me', async (c) =>
		c.json(await getRoomsByCreator(c.env.DB, (await authedId(c)) ?? 1))
	)
	.get('/roomserver/rooms/:id/interactionby/me', (c) =>
		c.json({ Cheered: false, Favorited: false })
	)
	.get('/roomserver/rooms/:id', async (c) => {
		const roomId = Number.parseInt(c.req.param('id'), 10)
		if (Number.isNaN(roomId)) return c.notFound()
		const room = await getRoomById(c.env.DB, roomId)
		return room ? c.json(room) : c.notFound()
	})

export default app
