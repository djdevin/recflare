import { Hono } from 'hono'

import { authedId, unauthorized } from '../http'
import { createInvention, getInventionById, getInventionsByCreator } from '../inventions-db'

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

	// A single invention by id (`?inventionId=…`). Returns the stored RRInvention,
	// or 404 when there's no such invention.
	.get('/api/inventions/v1', async (c) => {
		const inventionId = Number.parseInt(c.req.query('inventionId') ?? '', 10)
		if (Number.isNaN(inventionId)) return c.json({ error: 'inventionId is required' }, 400)
		const invention = await getInventionById(c.env.DB, inventionId)
		return invention ? c.json(invention) : c.notFound()
	})

	// The signed-in player's saved inventions ("my inventions"), newest first.
	// Auth-gated; returns a bare array (empty when the player has saved none).
	.get('/api/inventions/v2/mine', async (c) => {
		const id = await authedId(c)
		if (id === null) return unauthorized(c)
		return c.json(await getInventionsByCreator(c.env.DB, id))
	})

	// Save an invention's metadata. The data file itself is uploaded separately
	// through the `storage` worker and referenced here by `inventionDataFilename`.
	// Auth-gated; returns the stored invention (with its assigned inventionId).
	.post('/api/inventions/v6/save', async (c) => {
		const id = await authedId(c)
		if (id === null) return unauthorized(c)

		const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null
		if (body === null) return c.json({ error: 'Invalid request body' }, 400)

		const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined)
		const num = (v: unknown): number | undefined => (typeof v === 'number' ? v : undefined)

		const name = str(body.name)
		if (name === undefined) return c.json({ error: 'name is required' }, 400)

		const invention = await createInvention(c.env.DB, {
			creatorPlayerId: id,
			name,
			description: str(body.description),
			imageName: str(body.imageName),
			instantiationCost: num(body.instantiationCost),
			lightsCost: num(body.lightsCost),
			chipsCost: num(body.chipsCost),
			cloudVariablesCost: num(body.cloudVariablesCost),
			aiCost: num(body.aiCost),
			creationRoomId: num(body.creationRoomId),
			inventionDataFilename: str(body.inventionDataFilename),
			referencedInventions: Array.isArray(body.referencedInventions)
				? body.referencedInventions.filter((v): v is number => typeof v === 'number')
				: undefined,
			creatorAccountRole: num(body.creatorAccountRole),
		})
		return c.json(invention)
	})
