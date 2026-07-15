import { Hono } from 'hono'
import { useWorkersLogger } from 'workers-tagged-logger'

import { consumeGift, createGift, getPendingGifts } from '@repo/domain'
import { intVar, withNotFound, withOnError } from '@repo/hono-helpers'
import { validateAndGetAccountId } from '@repo/jwt'

import adCarouselItems from '../static/ad-carousel-items.json'
import defaultAvatarItems from '../static/default-avatar-items.json'
import defaultAvatar from '../static/default-avatar.json'
import myProgress from '../static/my-progress.json'
import weeklyChallenge from '../static/weekly-challenge.json'
import { getAvatar, setAvatar } from './avatar-db'
import {
	ALL_PLATFORMS,
	DEFAULT_STARTING_TOKENS,
	getBalance,
	isSpendable,
	spendCurrency,
} from './balance-db'
import { getConsumables, grantConsumable } from './consumables-db'
import { getInventory, grantItem } from './inventory-db'
import { getOutfits, setOutfit } from './outfit-db'

import type { Context } from 'hono'
import type { GiftContent } from '@repo/domain'
import type { Avatar } from './avatar-db'
import type { App } from './context'
import type { AvatarItem } from './inventory-db'
import type { Outfit } from './outfit-db'

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

/**
 * The subset of a storefront catalog (`static/storefronts/sf{N}.json`) that `buyItem`
 * reads: each store item carries the `GiftDrop` describing what you get and a list of
 * `Prices` per currency. The catalogs hold more fields (SubscriberPrices, IsFeatured,
 * …) that the purchase path doesn't need.
 */
interface StoreGiftDrop {
	FriendlyName: string
	Tooltip: string
	ConsumableItemDesc: string
	AvatarItemDesc: string
	AvatarItemType: number | null
	EquipmentPrefabName: string
	EquipmentModificationGuid: string
	Rarity: number
	Context: number
	Currency: number
	CurrencyType: number
}
interface StorePrice {
	CurrencyType: number
	Price: number
}
interface StoreItem {
	GiftDrop: StoreGiftDrop
	Prices: StorePrice[]
	PurchasableItemId: number
}
interface Storefront {
	StoreItems: StoreItem[]
}

/** The `Gift` block of a buyItem body — present when buying an item for another player. */
interface GiftRequest {
	ToPlayerId?: number
	Anonymous?: boolean
	Message?: string
	GiftContext?: number
}

/**
 * Look up a store item by (storefront type, purchasable item id), reading the catalog
 * from the ASSETS binding (`sf{type}.json`). Returns null when there is no such
 * storefront or no item with that id in it.
 */
async function findStoreItem(
	c: Context<App>,
	storefrontType: number,
	purchasableItemId: number
): Promise<StoreItem | null> {
	const res = await c.env.ASSETS.fetch(new URL(`/sf${storefrontType}.json`, c.req.url))
	if (!res.ok) return null
	const storefront = (await res.json()) as Storefront
	return storefront.StoreItems.find((it) => it.PurchasableItemId === purchasableItemId) ?? null
}

/** Build the owned avatar-item DTO granted into the buyer's inventory from a gift-drop. */
function toAvatarItem(giftDrop: StoreGiftDrop): AvatarItem {
	return {
		AvatarItemType: giftDrop.AvatarItemType,
		AvatarItemDesc: giftDrop.AvatarItemDesc,
		PlatformMask: -1,
		FriendlyName: giftDrop.FriendlyName,
		Tooltip: giftDrop.Tooltip,
		Rarity: giftDrop.Rarity,
	}
}

/** Quantity of a consumable granted per purchase — our storefront catalogs don't specify one. */
const CONSUMABLE_GRANT_COUNT = 1

/** The "Coach" system account — the sender a self-buy or anonymous gift is attributed to. */
const COACH_ACCOUNT_ID = 1

/** Build the stored gift-box content (the client's rendered "gift box") from a gift-drop. */
function toGiftContent(
	giftDrop: StoreGiftDrop,
	message: string,
	consumableCount: number
): GiftContent {
	return {
		ConsumableItemDesc: giftDrop.ConsumableItemDesc,
		ConsumableCount: consumableCount,
		AvatarItemDesc: giftDrop.AvatarItemDesc,
		AvatarItemType: giftDrop.AvatarItemType,
		CurrencyType: giftDrop.CurrencyType,
		Currency: giftDrop.Currency,
		Xp: 0,
		PackageType: 0,
		Message: message,
		EquipmentPrefabName: giftDrop.EquipmentPrefabName,
		EquipmentModificationGuid: giftDrop.EquipmentModificationGuid,
		GiftRarity: giftDrop.Rarity,
		Platform: -1,
		PlatformsToSpawnOn: -1,
		BalanceType: null,
	}
}

// strict: false so trailing-slash routes (e.g. `/gifts/consume/`, which the client
// posts with a trailing slash) match either form. Mirrors the `api` worker.
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

	// Default-unlocked avatar items, served from the bundled static JSON.
	.get('/api/avatar/v1/defaultunlocked', (c) => c.json(defaultAvatarItems))

	// Default base avatar items — empty stub for now. No auth.
	.get('/api/avatar/v1/defaultbaseavataritems', (c) => c.json([]))

	// The player's avatar items — the items they've bought (from `buyItem`, stored in
	// the inventory table) prepended to the default catalog. A player who has bought
	// nothing gets just the catalog.
	.get('/api/avatar/v4/items', async (c) => {
		const id = await authedId(c)
		if (id === null) return unauthorized(c)
		const owned = await getInventory(c.env.DB, id)
		return c.json([...owned, ...defaultAvatarItems])
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

	// The player's saved outfits. [Authorize]. Served back as the client posted them
	// (see /saved/set); a player who has saved none gets [].
	.get('/api/avatar/v3/saved', async (c) => {
		const id = await authedId(c)
		if (id === null) return unauthorized(c)
		return c.json(await getOutfits(c.env.DB, id))
	})

	// Save an outfit into one of the player's slots. [Authorize]. The posted `Slot` is
	// the slot to write, and re-saving a slot overwrites it — that's the avatar screen's
	// "save over this outfit". The payload is stored verbatim and echoed back: its inner
	// fields (OutfitSelectionsV2, FaceFeatures, …) are JSON-in-a-string from the client's
	// own serializer, so re-encoding them risks handing back something it can't parse.
	//
	// A missing/non-integer `Slot` is a 400 rather than a default slot — guessing would
	// silently overwrite an outfit the player didn't mean to touch.
	.post('/api/avatar/v3/saved/set', async (c) => {
		const id = await authedId(c)
		if (id === null) return unauthorized(c)
		const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null
		if (body === null || typeof body !== 'object' || Array.isArray(body)) {
			return c.body(null, 400)
		}
		if (!Number.isInteger(body.Slot)) return c.body(null, 400)
		const outfit = body as Outfit
		await setOutfit(c.env.DB, id, outfit)
		return c.json(outfit)
	})

	// Pending avatar gifts for the player — the unopened gift boxes from their purchases
	// (and, once gifting lands, from other players). [Authorize]. The client opens each
	// box and consumes it via the consume route below; the item itself was already
	// granted at purchase, so an unopened box is cosmetic.
	.get('/api/avatar/v2/gifts', async (c) => {
		const id = await authedId(c)
		if (id === null) return unauthorized(c)
		return c.json(await getPendingGifts(c.env.DB, id))
	})

	// Open (consume) a gift box. [Authorize]. The client posts this on the econ host after
	// the box animation, form-encoded as `Id=<giftId>&UnlockedLevel=<n>`. Opening just
	// deletes the box — the item was granted into the inventory at purchase, so there's
	// nothing to grant here — an avatar-item drop was granted into the inventory table and a
	// consumable drop into the consumable table, both at purchase. (`UnlockedLevel`, a
	// consumable-level hint, is unused.)
	//
	// Always answers 200 with the `{ error, success, value }` envelope — even with no token,
	// a zero id, or a box that is already gone. A captured real consume returns this envelope,
	// not an empty body: the client parses it to finish opening the box, so a bare 200 reads
	// as a failure and the consumable never finishes unlocking. The delete is scoped to the
	// caller's account, so an unauthenticated or mismatched call is simply a no-op. Mirrors
	// the same route on the `api` worker (the client may call either host).
	.post('/api/avatar/v2/gifts/consume', async (c) => {
		const id = await authedId(c)
		const body = await c.req.parseBody().catch(() => ({}) as Record<string, unknown>)
		const giftId = typeof body.Id === 'string' ? Number.parseInt(body.Id, 10) || 0 : 0
		if (id !== null && giftId !== 0) await consumeGift(c.env.DB, id, giftId)
		return c.json({ error: '', success: true, value: null })
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

	// Unlocked consumables. [Authorize]. The consumables the player has bought (from
	// `buyItem`, stored in the `consumable` table), grouped by item into the client's
	// unlocked-consumable DTO. A player who has bought none gets an empty list.
	.get('/api/consumables/v2/getUnlocked', async (c) => {
		const id = await authedId(c)
		if (id === null) return unauthorized(c)
		return c.json(await getConsumables(c.env.DB, id))
	})

	// Currency balance. [Authorize]. The trailing int is a CurrencyType — the client
	// fetches `/balance/2` (RecCenterTokens) on load. Backed by the `balance` table; a
	// player who has never been granted gets their starting balance on this first read.
	//
	// An unknown or non-account-scoped currency (a room currency, ProgressionEvent,
	// Invalid) returns a 0 balance rather than 404: the client treats a failed balance
	// fetch as a load error, and "you have none of that" is the honest answer anyway.
	.get('/api/storefronts/v4/balance/:currencyType', async (c) => {
		const id = await authedId(c)
		if (id === null) return unauthorized(c)
		const currencyType = Number.parseInt(c.req.param('currencyType'), 10)
		if (Number.isNaN(currencyType)) return c.body(null, 400)
		const amount = isSpendable(currencyType)
			? await getBalance(
					c.env.DB,
					id,
					currencyType,
					intVar(c.env.STARTING_TOKENS, DEFAULT_STARTING_TOKENS)
				)
			: 0
		return c.json([{ CurrencyType: currencyType, Platform: ALL_PLATFORMS, Balance: amount }])
	})

	// Gift-drop storefront. Serves `static/storefronts/sf{id}.json` for the requested
	// storefront id via the ASSETS binding; 404s when no such catalog exists.
	.get('/api/storefronts/v3/giftdropstore/:id', async (c) => {
		const id = c.req.param('id')
		const res = await c.env.ASSETS.fetch(new URL(`/sf${id}.json`, c.req.url))
		if (!res.ok) return c.notFound()
		return c.json(await res.json())
	})

	// Buy a storefront item. [Authorize]. The client posts the storefront/item ids, the
	// currency and the price it sees; we look the item up in that storefront's catalog,
	// confirm the price the client sent still matches, debit the buyer atomically, grant
	// the item into the recipient's inventory, and hand back a gift box.
	//
	// The buyer is always the caller; a `Gift` block routes the item (and box) to another
	// player, but the caller pays. Ownership is persisted at purchase — the gift box is
	// only the cosmetic "open it" moment, so the grant does not wait for the box to be
	// opened (see /api/avatar/v2/gifts/consume on the `api` worker, which just deletes it).
	//
	// `RequestedPrice` is the price the client rendered; rejecting a mismatch stops a stale
	// client (or a tampered request) from buying at a price the catalog no longer offers.
	.post('/api/storefronts/v2/buyItem', async (c) => {
		const id = await authedId(c)
		if (id === null) return unauthorized(c)

		const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null
		if (body === null || typeof body !== 'object' || Array.isArray(body)) {
			return c.json({ error: 'Invalid request body' }, 400)
		}
		const storefrontType = body.StorefrontType
		const purchasableItemId = body.PurchasableItemId
		const currencyType = body.CurrencyType
		const requestedPrice = body.RequestedPrice
		if (
			!Number.isInteger(storefrontType) ||
			!Number.isInteger(purchasableItemId) ||
			!Number.isInteger(currencyType) ||
			!Number.isInteger(requestedPrice)
		) {
			return c.json(
				{
					error: 'StorefrontType, PurchasableItemId, CurrencyType and RequestedPrice are required',
				},
				400
			)
		}

		const item = await findStoreItem(c, storefrontType as number, purchasableItemId as number)
		if (item === null) return c.json({ error: 'Item not found' }, 404)

		const price = item.Prices.find((p) => p.CurrencyType === currencyType)
		if (price === undefined) {
			return c.json({ error: 'Currency type not available for this item' }, 400)
		}
		if (price.Price !== requestedPrice) {
			return c.json({ error: 'Price has changed' }, 409)
		}
		// The item's currency must be an account balance we can debit (RecCenterTokens et al),
		// not a room-scoped or non-spendable currency.
		if (!isSpendable(currencyType as number)) {
			return c.json({ error: 'Currency type is not spendable' }, 400)
		}

		const gift = (
			typeof body.Gift === 'object' && body.Gift !== null ? body.Gift : null
		) as GiftRequest | null
		const receiverId = Number.isInteger(gift?.ToPlayerId) ? (gift?.ToPlayerId as number) : id
		// A named (non-anonymous) gift shows the sender; a self-purchase or an anonymous gift
		// is attributed to the "Coach" system account (id 1), never a null/0 sender.
		const fromPlayerId = gift !== null && gift.Anonymous !== true ? id : COACH_ACCOUNT_ID
		const message = typeof gift?.Message === 'string' ? gift.Message : 'A gift for you <3'

		const startingTokens = intVar(c.env.STARTING_TOKENS, DEFAULT_STARTING_TOKENS)
		// Debit the buyer atomically; a false return means they couldn't afford it and
		// nothing changed, so no item is granted.
		const paid = await spendCurrency(
			c.env.DB,
			id,
			currencyType as number,
			price.Price,
			startingTokens
		)
		if (!paid) return c.json({ error: 'Insufficient balance' }, 400)

		// Grant the item to the recipient. A gift-drop carries an avatar item, a consumable,
		// or neither (currency/xp drops aren't granted yet); grant whichever it actually has.
		if (typeof item.GiftDrop.AvatarItemDesc === 'string' && item.GiftDrop.AvatarItemDesc !== '') {
			await grantItem(c.env.DB, receiverId, toAvatarItem(item.GiftDrop))
		}
		const isConsumable =
			typeof item.GiftDrop.ConsumableItemDesc === 'string' &&
			item.GiftDrop.ConsumableItemDesc !== ''
		const consumableCount = isConsumable ? CONSUMABLE_GRANT_COUNT : 0
		if (isConsumable) {
			await grantConsumable(
				c.env.DB,
				receiverId,
				item.GiftDrop.ConsumableItemDesc,
				consumableCount
			)
		}
		const { id: giftId } = await createGift(
			c.env.DB,
			receiverId,
			toGiftContent(item.GiftDrop, message, consumableCount)
		)

		// The response mirrors a captured real buyItem: `Balance` is the change applied (the
		// negated price), not the resulting balance (the client reads its new total from
		// `GET /balance/:type`); `BalanceType` is -2 (account-wide, all platforms). The Data
		// entry is the gift-drop the client received — it carries no FriendlyName or
		// consumable count (the count is a getUnlocked concept; each box is one instance).
		return c.json({
			BalanceUpdates: [
				{
					UpdateResponse: 0,
					Data: [
						{
							Id: giftId,
							FromPlayerId: fromPlayerId,
							ConsumableItemDesc: item.GiftDrop.ConsumableItemDesc,
							AvatarItemDesc: item.GiftDrop.AvatarItemDesc,
							AvatarItemType: item.GiftDrop.AvatarItemType ?? 0,
							EquipmentPrefabName: item.GiftDrop.EquipmentPrefabName,
							EquipmentModificationGuid: item.GiftDrop.EquipmentModificationGuid,
							CurrencyType: item.GiftDrop.CurrencyType,
							Currency: item.GiftDrop.Currency,
							Xp: 0,
							Level: 0,
							Platform: -1,
							PlatformsToSpawnOn: -1,
							BalanceType: ALL_PLATFORMS,
							GiftContext: Number.isInteger(gift?.GiftContext)
								? (gift?.GiftContext as number)
								: item.GiftDrop.Context,
							GiftRarity: item.GiftDrop.Rarity,
							Message: message,
						},
					],
				},
			],
			Balance: -price.Price,
			CurrencyType: currencyType,
			BalanceType: ALL_PLATFORMS,
		})
	})

	// Storefront ad-carousel items. Served from the bundled static JSON — one
	// placeholder banner with no purchasable items until real promo data exists.
	.get('/api/storefronts/v1/adcarouselitems', (c) => c.json(adCarouselItems))

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
