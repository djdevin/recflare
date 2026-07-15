import { Hono } from 'hono'

import { authedId, unauthorized } from '../http'
import {
	createInvention,
	getFeaturedInventions,
	getInventionById,
	getInventionsByCreator,
	getInventionsByIds,
	getInventionsByRoom,
	getInventionTagFilters,
	getInventionTags,
	getInventionVersion,
	getTopInventions,
	parsePermissionLevel,
	publishInvention,
	searchInventions,
	setInventionPrice,
	setInventionTags,
	toSaveResult,
	updateInvention,
} from '../inventions-db'

import type { Context } from 'hono'
import type { App } from '../context'
import type { SavedInvention } from '../inventions-db'

/**
 * The gate every invention write runs through: the caller must be signed in, the
 * invention must exist, and it must be theirs. Yields the loaded invention, or the
 * error response to return as-is (401 / 404 / 403).
 */
async function creatorsInvention(
	c: Context<App>,
	inventionId: number
): Promise<{ invention: SavedInvention } | { response: Response | Promise<Response> }> {
	const playerId = await authedId(c)
	if (playerId === null) return { response: unauthorized(c) }
	if (Number.isNaN(inventionId)) {
		return { response: c.json({ error: 'inventionId is required' }, 400) }
	}
	const invention = await getInventionById(c.env.DB, inventionId)
	if (invention === null) return { response: c.notFound() }
	if (invention.CreatorPlayerId !== playerId) {
		return { response: c.json({ error: 'Not your invention' }, 403) }
	}
	return { invention }
}

// ---- Avatar gifts ----------------------------------------------------------
// The avatar read endpoints (`v4/items`, `v2`, `v2/set`, `v3/saved`, `v2/gifts`) and
// gift-box consume live in the `econ` worker, which the client calls on the econ host
// — not here. Only the gift `generate` action remains on this worker.
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

	// Custom avatar item gates — real Rec Room client endpoints with no backing
	// implementation yet; we enable them. Flip to `false` to disable the
	// corresponding flow. `isCreationAllowedForAccount` wraps its answer in the
	// success/value envelope; the other two return a bare JSON boolean.
	.get('/api/customAvatarItems/v1/isCreationAllowedForAccount', (c) =>
		c.json({ success: true, value: null })
	)
	.get('/api/customAvatarItems/v1/isCreationEnabled', (c) => c.json(true))
	.get('/api/customAvatarItems/v1/isRenderingEnabled', (c) => c.json(true))

	// The featured custom-avatar-item feed. No curated items yet → an empty list.
	.get('/api/customAvatarItems/v1/featured', (c) => c.json([]))

	// The "hot" (trending) custom-avatar-item feed. No items yet → an empty list.
	.get('/api/customAvatarItems/v1/hot', (c) => c.json([]))

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

	// The tag filter chips on the invention browse screen. Derived from the tags in
	// use on published inventions — most popular first, top few pinned. Public.
	.get('/api/inventions/v1/tagfilters', async (c) => c.json(await getInventionTagFilters(c.env.DB)))

	// A batch of inventions by id (`?id=1&id=2`, and each `id` may itself be a
	// comma-separated list). Unknown ids are dropped rather than 404ing, and an empty
	// request is an empty list. Auth is optional and only widens what you see: an
	// unpublished invention comes back only to its creator. Bare array.
	.get('/api/inventions/v2/batch', async (c) => {
		const ids = c.req
			.queries('id')
			?.flatMap((raw) => raw.split(','))
			.map((raw) => Number.parseInt(raw.trim(), 10))
			.filter((id) => !Number.isNaN(id))
		if (ids === undefined || ids.length === 0) return c.json([])

		const playerId = await authedId(c)
		const inventions = await getInventionsByIds(c.env.DB, ids)
		return c.json(
			inventions.filter(
				(i) => i.IsPublished || (playerId !== null && i.CreatorPlayerId === playerId)
			)
		)
	})

	// A room's inventions (`?id=76`) — published inventions created in that room,
	// newest first. Paginated via skip/take (take defaults to 100). Bare array.
	.get('/api/inventions/v1/room', async (c) => {
		const roomId = Number.parseInt(c.req.query('id') ?? '', 10)
		if (Number.isNaN(roomId)) return c.json({ error: 'id is required' }, 400)
		const skip = Number.parseInt(c.req.query('skip') ?? '0', 10) || 0
		const take = Number.parseInt(c.req.query('take') ?? '100', 10) || 100
		return c.json(await getInventionsByRoom(c.env.DB, roomId, skip, take))
	})

	// The signed-in player's own relationship to an invention (`/personaldetails/2`)
	// — just whether they're cheering it. We store no cheers (nothing can cheer an
	// invention yet), so this is always false; it stays a 200 for signed-out callers
	// too, since the client only reads the flag.
	.get('/api/inventions/v1/personaldetails/:inventionId{[0-9]+}', (c) =>
		c.json({ IsCheering: false })
	)

	// A single version of an invention (`?inventionId=…&version=…`) — the bare
	// RRInventionVersion, which carries the blob name the client downloads. Public.
	// Only the current version exists (nothing writes version history yet), so any
	// other version number 404s rather than naming a blob that isn't there.
	.get('/api/inventions/v1/version', async (c) => {
		const inventionId = Number.parseInt(c.req.query('inventionId') ?? '', 10)
		if (Number.isNaN(inventionId)) return c.json({ error: 'inventionId is required' }, 400)
		const versionNumber = Number.parseInt(c.req.query('version') ?? '', 10)
		if (Number.isNaN(versionNumber)) return c.json({ error: 'version is required' }, 400)

		const version = await getInventionVersion(c.env.DB, inventionId, versionNumber)
		return version === null ? c.notFound() : c.json(version)
	})

	// Edit an invention's metadata. A GET that writes — that's what the client sends
	// (`?inventionId=1&description=my+description`), with the fields to change as
	// query params. Absent params keep their stored value; `permission` sets what
	// other players may do with it (a name like `useonly` or the raw number). An
	// empty `description` clears it, but an empty `name`/`imageName` is ignored
	// rather than blanking the invention. Publishing and pricing are separate
	// endpoints. Auth-gated, creator only; answers the save envelope.
	.get('/api/inventions/v1/update', async (c) => {
		const gate = await creatorsInvention(c, Number.parseInt(c.req.query('inventionId') ?? '', 10))
		if ('response' in gate) return gate.response

		// Query params arrive as strings; only the ones actually present are applied.
		const nonEmpty = (name: string): string | undefined => {
			const v = c.req.query(name)?.trim()
			return v === undefined || v === '' ? undefined : v
		}
		const allowTrial = c.req.query('allowTrial')
		const permission = c.req.query('permission')

		const updated = await updateInvention(c.env.DB, gate.invention.InventionId, {
			name: nonEmpty('name'),
			// Present-but-empty clears the description, so this checks presence.
			description: c.req.query('description'),
			imageName: nonEmpty('imageName'),
			allowTrial:
				allowTrial === undefined
					? undefined
					: allowTrial.toLowerCase() === 'true' || allowTrial === '1',
			generalPermission: permission === undefined ? undefined : parsePermissionLevel(permission),
		})
		return updated === null ? c.notFound() : c.json(toSaveResult(updated))
	})

	// Publish an invention — this is what puts it into search and the feeds. Sets the
	// permission other players get (`permissionLevel`, defaulting to UseOnly) and its
	// `price`. Auth-gated, creator only; answers the save envelope.
	.get('/api/inventions/v3/publish', async (c) => {
		const gate = await creatorsInvention(c, Number.parseInt(c.req.query('inventionId') ?? '', 10))
		if ('response' in gate) return gate.response

		const permissionLevel = c.req.query('permissionLevel')
		const price = Number.parseInt(c.req.query('price') ?? '', 10)

		const published = await publishInvention(
			c.env.DB,
			gate.invention.InventionId,
			permissionLevel === undefined ? undefined : parsePermissionLevel(permissionLevel),
			Number.isNaN(price) || price < 0 ? undefined : price
		)
		return published === null ? c.notFound() : c.json(toSaveResult(published))
	})

	// Set an invention's price. Unlike update/publish this one POSTs a JSON body.
	// Auth-gated, creator only; answers the save envelope.
	.post('/api/inventions/v1/updateprice', async (c) => {
		const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null
		if (body === null) return c.json({ error: 'Invalid request body' }, 400)

		const inventionId = typeof body.InventionId === 'number' ? body.InventionId : Number.NaN
		const gate = await creatorsInvention(c, inventionId)
		if ('response' in gate) return gate.response

		const price = typeof body.Price === 'number' ? body.Price : Number.NaN
		if (Number.isNaN(price) || price < 0) return c.json({ error: 'Price must be >= 0' }, 400)

		const updated = await setInventionPrice(c.env.DB, gate.invention.InventionId, price)
		return updated === null ? c.notFound() : c.json(toSaveResult(updated))
	})

	// Replace an invention's tags. `CustomTags` are the creator's own (Type 0),
	// `AutoTags` the ones the client derives from the invention (Type 2); both lists
	// are replaced wholesale. Auth-gated, and only the creator may retag their own
	// invention. Answers `{ Result, Tags }` — `Result` 0 is success, and `Tags` is the
	// flat list of tag *names* (auto first, then custom); the typed `{ Tag, Type }`
	// objects are what `v1/details` serves.
	.post('/api/inventions/v1/settags', async (c) => {
		const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null
		if (body === null) return c.json({ error: 'Invalid request body' }, 400)

		const inventionId = typeof body.InventionId === 'number' ? body.InventionId : Number.NaN
		const gate = await creatorsInvention(c, inventionId)
		if ('response' in gate) return gate.response

		const strings = (v: unknown): string[] =>
			Array.isArray(v) ? v.filter((t): t is string => typeof t === 'string') : []

		const tags = await setInventionTags(
			c.env.DB,
			gate.invention.InventionId,
			strings(body.AutoTags),
			strings(body.CustomTags)
		)
		return c.json({ Result: 0, Tags: (tags ?? []).map((t) => t.Tag) })
	})

	// An invention's detail card (`?inventionId=…`) — just its tags, as `{ Tags }`.
	// Untagged inventions report an empty list. 404s on unknown ids.
	.get('/api/inventions/v1/details', async (c) => {
		const inventionId = Number.parseInt(c.req.query('inventionId') ?? '', 10)
		if (Number.isNaN(inventionId)) return c.json({ error: 'inventionId is required' }, 400)
		const tags = await getInventionTags(c.env.DB, inventionId)
		return tags === null ? c.notFound() : c.json({ Tags: tags })
	})

	// The "top today" invention feed — published inventions ranked by engagement
	// (lifetime, not per-day: we keep no daily counters). Paginated via skip/take
	// (take defaults to 50, as the client asks for). Bare array.
	.get('/api/inventions/v1/toptoday', async (c) => {
		const skip = Number.parseInt(c.req.query('skip') ?? '0', 10) || 0
		const take = Number.parseInt(c.req.query('take') ?? '50', 10) || 50
		return c.json(await getTopInventions(c.env.DB, skip, take))
	})

	// The featured invention feed — curated (`IsFeatured`) inventions, falling back
	// to the top feed while nothing is curated. Bare array, like toptoday.
	.get('/api/inventions/v1/featured', async (c) => {
		const skip = Number.parseInt(c.req.query('skip') ?? '0', 10) || 0
		const take = Number.parseInt(c.req.query('take') ?? '50', 10) || 50
		return c.json(await getFeaturedInventions(c.env.DB, skip, take))
	})

	// Invention search/browse: published inventions matching `value` (matched against
	// name + description; absent → browse everything published), newest first.
	// Paginated via skip/take (take defaults to 100). Returns a bare array.
	.get('/api/inventions/v2/search', async (c) => {
		const value = c.req.query('value') ?? ''
		const skip = Number.parseInt(c.req.query('skip') ?? '0', 10) || 0
		const take = Number.parseInt(c.req.query('take') ?? '100', 10) || 100
		return c.json(await searchInventions(c.env.DB, value, skip, take))
	})

	// The signed-in player's saved inventions ("my inventions"), newest first.
	// Auth-gated; returns a bare array (empty when the player has saved none).
	.get('/api/inventions/v2/mine', async (c) => {
		const id = await authedId(c)
		if (id === null) return unauthorized(c)
		return c.json(await getInventionsByCreator(c.env.DB, id))
	})

	// Save an invention's metadata. The data file itself is uploaded separately
	// through the `storage` worker and referenced here by `inventionDataFilename` —
	// the one required field, since an invention with no data blob is unusable. An
	// omitted name/description is defaulted rather than rejected. Auth-gated; returns
	// the `{ Status, Invention, InventionVersion }` envelope the client expects (the
	// invention carries its assigned inventionId).
	.post('/api/inventions/v6/save', async (c) => {
		const id = await authedId(c)
		if (id === null) return unauthorized(c)

		const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null
		if (body === null) return c.json({ error: 'Invalid request body' }, 400)

		const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined)
		const num = (v: unknown): number | undefined => (typeof v === 'number' ? v : undefined)

		const inventionDataFilename = str(body.inventionDataFilename)?.trim()
		if (!inventionDataFilename) {
			return c.json({ error: 'inventionDataFilename is required' }, 400)
		}

		const invention = await createInvention(c.env.DB, {
			creatorPlayerId: id,
			inventionDataFilename,
			name: str(body.name),
			description: str(body.description),
			imageName: str(body.imageName),
			instantiationCost: num(body.instantiationCost),
			lightsCost: num(body.lightsCost),
			chipsCost: num(body.chipsCost),
			cloudVariablesCost: num(body.cloudVariablesCost),
			aiCost: num(body.aiCost),
			creationRoomId: num(body.creationRoomId),
			referencedInventions: Array.isArray(body.referencedInventions)
				? body.referencedInventions.filter((v): v is number => typeof v === 'number')
				: undefined,
		})
		return c.json(toSaveResult(invention))
	})
