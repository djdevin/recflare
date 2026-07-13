import { Hono } from 'hono'

import { parseFormIds, queryIds } from '../http'

import type { App } from '../context'

/**
 * Default reputation for an account — the fallback used with no DB. Nobody has
 * earned cheers yet, so every counter is 0 and everyone has their full cheer credit.
 * `SelectedCheer` is an int (0 = none selected), not null, and `IsCheerful` is true:
 * the client reads it to decide whether the player may hand out cheers at all.
 */
function defaultReputation(id: number) {
	return {
		AccountId: id,
		IsCheerful: true,
		Noteriety: 0,
		SelectedCheer: 0,
		CheerCredit: 20,
		CheerGeneral: 0,
		CheerHelpful: 0,
		CheerCreative: 0,
		CheerGreatHost: 0,
		CheerSportsman: 0,
		SubscriberCount: 0,
		SubscribedCount: 0,
	}
}

// ---- Reputation / progression ----------------------------------------------
export const progressionRoutes = new Hono<App>({ strict: false })
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
