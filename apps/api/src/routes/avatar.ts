import { Hono } from 'hono'

import { authedId, unauthorized } from '../http'

import type { App } from '../context'

// ---- Avatar gifts ----------------------------------------------------------
// The avatar read endpoints (`v4/items`, `v2`, `v2/set`, `v3/saved`, `v2/gifts`)
// live in the `econ` worker, which the client calls on the econ host — not here.
// Only the gift generate/consume actions remain on this worker.
export const avatarRoutes = new Hono<App>({ strict: false })
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

	// Custom avatar items created by a given account. No storage yet → an empty
	// paginated result (matches the econ `customAvatarItems/v1/owned` shape).
	.get('/api/customAvatarItems/v2/fromCreator/:accountId{[0-9]+}', (c) =>
		c.json({ Results: [], TotalResults: 0 })
	)

	// Saved inventions — empty list with no DB.
	.get('/api/inventions/v2/mine', (c) => c.json([]))
