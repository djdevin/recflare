import { Hono } from 'hono'
import { useWorkersLogger, WorkersLogger } from 'workers-tagged-logger'

import { withNotFound, withOnError } from '@repo/hono-helpers'
import { validateAndGetAccountId } from '@repo/jwt'

import defaultAvatarItems from '../static/default-avatar-items.json'
import defaultAvatar from '../static/default-avatar.json'
import myProgress from '../static/my-progress.json'
import weeklyChallenge from '../static/weekly-challenge.json'
import { getAvatar, setAvatar } from './avatar-db'
import {
	clearObjectiveGroup,
	getObjectiveGroups,
	getObjectives,
	updateObjective,
} from './objectives-db'
import {
	consumeRewardSelection,
	createRewardSelection,
	getRewardSelection,
	rollRewardDrops,
	tokenRewardDrop,
} from './rewards-db'

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
	return validateAndGetAccountId(c.req.raw, await c.env.JWT_SECRET.get())
}

/** Results.Unauthorized() equivalent — 401 with empty body. */
function unauthorized(c: Context<App>) {
	return c.body(null, 401)
}

const logger = new WorkersLogger()

/** The single hub Durable Object every worker talks to. */
const HUB_INSTANCE = 'global'

/**
 * Push a notification to a player over the websocket hub. Rewards are *delivered*
 * this way — the HTTP response carries none of it — but a hub that's down shouldn't
 * fail the request that already committed, so a delivery failure is logged, not thrown.
 */
async function pushToPlayer(
	c: Context<App>,
	playerId: number,
	notificationType: string,
	data: Record<string, unknown>
): Promise<void> {
	try {
		await c.env.RECFLARE_NOTIFICATIONS_HUB.getByName(HUB_INSTANCE).notifyPlayer(
			playerId,
			notificationType,
			data
		)
	} catch (err) {
		logger.error('failed to push notification', {
			playerId,
			notificationType,
			error: err instanceof Error ? err.message : String(err),
		})
	}
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

	// The player's objectives progress. Their own recorded objectives once they've made
	// any (the client reports them through `updateobjective`); the bundled default set
	// otherwise, including for a signed-out caller — the client needs a well-formed
	// checklist to render either way.
	.get('/api/objectives/v1/myprogress', async (c) => {
		const id = await authedId(c)
		if (id === null) return c.json(myProgress)

		const [objectives, groups] = await Promise.all([
			getObjectives(c.env.DB, id),
			getObjectiveGroups(c.env.DB, id),
		])
		if (objectives.length === 0 && groups.length === 0) return c.json(myProgress)
		return c.json({
			Objectives: objectives,
			// Fall back to the default groups until the player has cleared one of their own.
			ObjectiveGroups: groups.length === 0 ? myProgress.ObjectiveGroups : groups,
		})
	})

	// The client clearing an objective group — it's done with that set (its dailies
	// rolled over, say). Auth-gated; the JSON body carries `Group`. Marks the group
	// completed, stamps the clear time, and returns the group as the client reads it.
	.post('/api/objectives/v1/cleargroup', async (c) => {
		const id = await authedId(c)
		if (id === null) return unauthorized(c)

		const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>
		const group = typeof body.Group === 'number' ? body.Group : 0

		return c.json(await clearObjectiveGroup(c.env.DB, id, group))
	})

	// The client reporting progress on an objective as it plays. Auth-gated; the body is
	// JSON (Group/Index identify the objective within the player's set). Answers a bare
	// 200 — the client doesn't read anything back.
	.post('/api/objectives/v1/updateobjective', async (c) => {
		const id = await authedId(c)
		if (id === null) return unauthorized(c)

		const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null
		if (body === null) return c.body(null, 400)

		const num = (v: unknown): number => (typeof v === 'number' ? v : 0)
		const bool = (v: unknown): boolean => v === true

		await updateObjective(c.env.DB, id, {
			Group: num(body.Group),
			Index: num(body.Index),
			Progress: num(body.Progress),
			VisualProgress: num(body.VisualProgress),
			IsCompleted: bool(body.IsCompleted),
			IsRewarded: bool(body.IsRewarded),
		})
		// The reference awards progression XP the first time an objective completes; we
		// have no XP store yet, so completion is only recorded (HasClaimedReward latches
		// so the award can't be double-paid once there is one).
		return c.body(null, 200)
	})

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

	// Ask for a reward (a challenge completed, a level gained, …). The HTTP response
	// carries *nothing* — the three choices are pushed to the player over the
	// notifications hub as `RewardSelectionReceived`, and they pick one with
	// `v1/select`. Auth-gated; answers the `{ error, success, value }` envelope.
	.post('/api/gamerewards/v1/request', async (c) => {
		const accountId = await authedId(c)
		if (accountId === null) return unauthorized(c)

		const body = (await c.req.parseBody().catch(() => ({}))) as Record<string, unknown>
		const field = (...names: string[]): string => {
			const key = Object.keys(body).find((k) =>
				names.some((n) => n.toLowerCase() === k.toLowerCase())
			)
			const v = key === undefined ? undefined : body[key]
			return typeof v === 'string' ? v : ''
		}
		const message = field('Message')
		const giftContext = Number.parseInt(field('giftContext', 'GiftContext'), 10) || 0
		const rewardType = Number.parseInt(field('rewardType', 'RewardType'), 10) || 0

		// No reward-drop catalog yet, so all three choices are token drops — the
		// reference's own fallback when it runs out of drops for a context.
		const drops = rollRewardDrops(giftContext)
		const selection = await createRewardSelection(c.env.DB, accountId, {
			message,
			giftContext,
			rewardType,
			dropIds: drops.map((d) => d.GiftDropId),
		})

		await pushToPlayer(c, accountId, 'RewardSelectionReceived', {
			RewardSelectionId: selection.RewardSelectionId,
			Message: message,
			GiftContext: giftContext,
			RewardType: rewardType,
			GiftDrop1: drops[0],
			GiftDrop2: drops[1],
			GiftDrop3: drops[2],
			CreatedAt: selection.CreatedAt,
			PlayerId: 0,
		})

		return c.json({ error: '', success: true, value: null })
	})

	// Claim one of the three rewards a selection offered. The selection must be the
	// caller's, unconsumed, and actually contain the claimed drop — otherwise 403, so a
	// player can't mint a reward they were never offered or redeem one twice. Returns
	// the claimed drop, and pushes the resulting gift over the hub.
	.post('/api/gamerewards/v1/select', async (c) => {
		const accountId = await authedId(c)
		if (accountId === null) return unauthorized(c)

		const body = (await c.req.parseBody().catch(() => ({}))) as Record<string, unknown>
		const int = (name: string): number => {
			const key = Object.keys(body).find((k) => k.toLowerCase() === name.toLowerCase())
			const v = key === undefined ? undefined : body[key]
			return typeof v === 'string' ? Number.parseInt(v, 10) || 0 : 0
		}
		const rewardSelectionId = int('rewardSelectionId')
		const giftDropId = int('giftDropId')
		if (giftDropId === 0) return c.json({ error: 'giftDropId is required' }, 400)

		const selection =
			rewardSelectionId <= 0 ? null : await getRewardSelection(c.env.DB, rewardSelectionId)
		if (
			selection === null ||
			selection.AccountId !== accountId ||
			selection.Consumed ||
			!selection.GiftDropIds.includes(giftDropId)
		) {
			return c.body(null, 403)
		}
		// Consume conditionally: two racing claims mean the second one loses.
		if (!(await consumeRewardSelection(c.env.DB, selection.RewardSelectionId))) {
			return c.body(null, 403)
		}

		// Every drop is a token drop for now, and a token drop's id is the negative of
		// its amount — so the claim rebuilds without a catalog lookup.
		const drop = tokenRewardDrop(-giftDropId, selection.GiftContext)

		await pushToPlayer(c, accountId, 'GiftPackageRewardSelectionReceived', {
			Id: selection.RewardSelectionId,
			FromGiftDropId: drop.GiftDropId,
			FromPlayerId: 1,
			ConsumableItemDesc: drop.ConsumableItemDesc,
			AvatarItemDesc: drop.AvatarItemDesc,
			EquipmentPrefabName: drop.EquipmentPrefabName,
			EquipmentModificationGuid: drop.EquipmentModificationGuid,
			CurrencyType: drop.CurrencyType,
			Currency: drop.Currency,
			Xp: 0,
			Level: 0,
			Platform: -1,
			PlatformsToSpawnOn: -1,
			BalanceType: -2,
			GiftContext: selection.GiftContext,
			GiftRarity: drop.Rarity,
			Message: selection.Message,
			AvatarItemType: drop.AvatarItemType,
		})

		return c.json(drop)
	})

	// The player's room keys. Returns "[]".
	.get('/api/roomkeys/v1/mine', (c) => c.json([]))
	// Room keys for a given room (client calls this on the econ host). [] with no DB.
	.get('/api/roomkeys/v1/room', (c) => c.json([]))

	// Subscription lookup. Returns both fields null with no auth.
	.post('/api/CampusCard/v1/UpdateAndGetSubscription', (c) =>
		c.json({ subscription: null, platformAccountSubscribedPlayerId: null })
	)

export default app
