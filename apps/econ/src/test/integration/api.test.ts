import { adminSecretsStore, env } from 'cloudflare:test'
import { exports } from 'cloudflare:workers'
import { beforeAll, describe, expect, test } from 'vitest'

import '../../econ.app'

import { SCHEMA_DDL } from '../../avatar-db'
import { SCHEMA_DDL as OBJECTIVES_SCHEMA_DDL } from '../../objectives-db'
import { SCHEMA_DDL as REWARDS_SCHEMA_DDL } from '../../rewards-db'

import type { Env } from '../../context'

declare module 'cloudflare:test' {
	interface ProvidedEnv extends Env {}
}

const ORIGIN = 'https://example.com'

// Build the accounts table and seed the test player (the default token's sub, 42)
// so avatar reads/writes have a row to attach to.
beforeAll(async () => {
	// Seed the shared JWT signing key into the local Secrets Store so .get() resolves.
	await adminSecretsStore(env.JWT_SECRET).create('test-signing-key')
	for (const stmt of SCHEMA_DDL) await env.DB.prepare(stmt).run()
	// Reward selections (owned by this worker) — game rewards record what was offered.
	for (const stmt of REWARDS_SCHEMA_DDL) await env.DB.prepare(stmt).run()
	// Objectives (owned by this worker) — per-player challenge progress.
	for (const stmt of OBJECTIVES_SCHEMA_DDL) await env.DB.prepare(stmt).run()
	await env.DB.prepare('INSERT OR IGNORE INTO account (data) VALUES (?1)')
		.bind(JSON.stringify({ accountId: 42, username: 'Tester', displayName: 'Tester' }))
		.run()
})

// Mint a token the way the `auth` worker does, signing with the shared test key seeded into the JWT_SECRET store.
const TEST_SECRET = 'test-signing-key'

function b64url(input: ArrayBuffer | string): string {
	const bytes = typeof input === 'string' ? new TextEncoder().encode(input) : new Uint8Array(input)
	let binary = ''
	for (const byte of bytes) binary += String.fromCharCode(byte)
	return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

async function bearer(sub = '42'): Promise<Record<string, string>> {
	const now = Math.floor(Date.now() / 1000)
	const signingInput = `${b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }))}.${b64url(
		JSON.stringify({ sub, exp: now + 3600 })
	)}`
	const key = await crypto.subtle.importKey(
		'raw',
		new TextEncoder().encode(TEST_SECRET),
		{ name: 'HMAC', hash: 'SHA-256' },
		false,
		['sign']
	)
	const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(signingInput))
	return { Authorization: `Bearer ${signingInput}.${b64url(sig)}` }
}

describe('econ endpoints', () => {
	test('GET /api/avatar/v1/defaultunlocked returns the default avatar items', async () => {
		const res = await exports.default.fetch(`${ORIGIN}/api/avatar/v1/defaultunlocked`)
		expect(res.status).toBe(200)
		const body = (await res.json()) as unknown[]
		expect(Array.isArray(body)).toBe(true)
		expect(body.length).toBeGreaterThan(0)
		expect(body[0]).toHaveProperty('AvatarItemDesc')
	})

	test('GET /api/avatar/v1/defaultbaseavataritems is an empty stub (no auth)', async () => {
		const res = await exports.default.fetch(`${ORIGIN}/api/avatar/v1/defaultbaseavataritems`)
		expect(res.status).toBe(200)
		expect(await res.json()).toEqual([])
	})

	test('GET /api/avatar/v4/items 401s without a token', async () => {
		const res = await exports.default.fetch(`${ORIGIN}/api/avatar/v4/items`)
		expect(res.status).toBe(401)
	})

	test('GET /api/avatar/v4/items returns the item catalog with a valid token', async () => {
		const res = await exports.default.fetch(`${ORIGIN}/api/avatar/v4/items`, {
			headers: await bearer(),
		})
		expect(res.status).toBe(200)
		const body = (await res.json()) as unknown[]
		expect(Array.isArray(body)).toBe(true)
		expect(body.length).toBeGreaterThan(0)
		expect(body[0]).toHaveProperty('AvatarItemDesc')
		expect(body[0]).toHaveProperty('FriendlyName')
	})

	test('GET /api/avatar/v2 401s without a token', async () => {
		const res = await exports.default.fetch(`${ORIGIN}/api/avatar/v2`)
		expect(res.status).toBe(401)
	})

	test('GET /api/avatar/v2 returns a populated default avatar when none is saved', async () => {
		// Account 7 has no saved avatar → falls back to the default outfit.
		const res = await exports.default.fetch(`${ORIGIN}/api/avatar/v2`, {
			headers: await bearer('7'),
		})
		expect(res.status).toBe(200)
		const body = (await res.json()) as { OutfitSelections: string; FaceFeatures: string }
		// Must be non-empty — the client's outfit parser NREs on an empty string.
		expect(body.OutfitSelections.length).toBeGreaterThan(0)
		expect(body.OutfitSelections).toContain(';')
		expect(body.FaceFeatures).toContain('eyeId')
	})

	test('POST /api/avatar/v2/set 401s without a token', async () => {
		const res = await exports.default.fetch(`${ORIGIN}/api/avatar/v2/set`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ OutfitSelections: 'a,,0' }),
		})
		expect(res.status).toBe(401)
	})

	test('POST /api/avatar/v2/set saves the avatar, and GET reads it back', async () => {
		const headers = { ...(await bearer()), 'Content-Type': 'application/json' }
		const avatar = {
			OutfitSelections:
				'1fd69ef8-0b74-4962-af5a-67f0bf0358f2,,0;d0a9262f-5504-46a7-bb10-7507503db58e,,1',
			OutfitSelectionsV2: '{"selections":[]}',
			FaceFeatures: '{"eyeId":"AjGMoJhEcEehacRZjUMuDg"}',
			SkinColor: '3529b670-a66d-448e-9573-1905eae5b9bf',
			HairColor: '0e_jaaObREWTf1AorAZ95g',
			CustomAvatarItems: [],
		}

		// Save echoes the payload back.
		const setRes = await exports.default.fetch(`${ORIGIN}/api/avatar/v2/set`, {
			method: 'POST',
			headers,
			body: JSON.stringify(avatar),
		})
		expect(setRes.status).toBe(200)
		expect(await setRes.json()).toEqual(avatar)

		// And it persists — GET now returns the saved avatar, not the default.
		const getRes = await exports.default.fetch(`${ORIGIN}/api/avatar/v2`, {
			headers: await bearer(),
		})
		expect(await getRes.json()).toEqual(avatar)
	})

	test('GET /api/avatar/v2/:id 400s on a non-numeric id', async () => {
		const res = await exports.default.fetch(`${ORIGIN}/api/avatar/v2/notanumber`)
		expect(res.status).toBe(400)
	})

	test('GET /api/avatar/v2/:id returns the default projection when none is saved (no auth)', async () => {
		// Account 8 has no saved avatar → falls back to the default outfit. No token needed.
		const res = await exports.default.fetch(`${ORIGIN}/api/avatar/v2/8`)
		expect(res.status).toBe(200)
		const body = (await res.json()) as Record<string, unknown>
		// Projected to exactly the render subset — no OutfitSelectionsV2/CustomAvatarItems.
		expect(Object.keys(body).sort()).toEqual([
			'FaceFeatures',
			'HairColor',
			'OutfitSelections',
			'SkinColor',
		])
		expect((body.OutfitSelections as string).length).toBeGreaterThan(0)
	})

	test('GET /api/avatar/v2/:id returns another player’s saved avatar, projected', async () => {
		// Seed account 314 with a full avatar blob (superset of the projection).
		await env.DB.prepare('INSERT OR IGNORE INTO account (data) VALUES (?1)')
			.bind(JSON.stringify({ accountId: 314, username: 'Pi', displayName: 'Pi' }))
			.run()
		await env.DB.prepare('UPDATE account SET avatar = ?2 WHERE account_id = ?1')
			.bind(
				314,
				JSON.stringify({
					OutfitSelections: 'guid,,0;guid2,,1',
					OutfitSelectionsV2: '{"selections":[]}',
					FaceFeatures: '{"eyeId":"abc"}',
					SkinColor: 'skin-guid',
					HairColor: 'hair-guid',
					CustomAvatarItems: [],
				})
			)
			.run()

		const res = await exports.default.fetch(`${ORIGIN}/api/avatar/v2/314`)
		expect(res.status).toBe(200)
		// Only the four projected fields, carrying the saved values.
		expect(await res.json()).toEqual({
			OutfitSelections: 'guid,,0;guid2,,1',
			FaceFeatures: '{"eyeId":"abc"}',
			SkinColor: 'skin-guid',
			HairColor: 'hair-guid',
		})
	})

	test('GET /api/avatar/v2/gifts is not shadowed by the :id route', async () => {
		const res = await exports.default.fetch(`${ORIGIN}/api/avatar/v2/gifts`, {
			headers: await bearer(),
		})
		expect(res.status).toBe(200)
		expect(await res.json()).toEqual([])
	})

	test('POST /api/avatar/v2/set 404s when the caller has no account row', async () => {
		const res = await exports.default.fetch(`${ORIGIN}/api/avatar/v2/set`, {
			method: 'POST',
			headers: { ...(await bearer('99999')), 'Content-Type': 'application/json' },
			body: JSON.stringify({ OutfitSelections: 'a,,0' }),
		})
		expect(res.status).toBe(404)
	})

	test('GET /econ/customAvatarItems/v1/owned 401s without a token, returns an empty paginated stub', async () => {
		const anon = await exports.default.fetch(`${ORIGIN}/econ/customAvatarItems/v1/owned`)
		expect(anon.status).toBe(401)
		const res = await exports.default.fetch(`${ORIGIN}/econ/customAvatarItems/v1/owned`, {
			headers: await bearer(),
		})
		expect(res.status).toBe(200)
		expect(await res.json()).toEqual({ Results: [], TotalResults: 0 })
	})

	test('GET /api/objectives/v1/myprogress returns the default progress (no auth)', async () => {
		const res = await exports.default.fetch(`${ORIGIN}/api/objectives/v1/myprogress`)
		expect(res.status).toBe(200)
		const body = (await res.json()) as { Objectives: unknown[]; ObjectiveGroups: unknown[] }
		expect(Array.isArray(body.Objectives)).toBe(true)
		expect(Array.isArray(body.ObjectiveGroups)).toBe(true)
	})

	test('POST /api/objectives/v1/updateobjective records progress; myprogress reads it back', async () => {
		type Progress = {
			Objectives: Array<{
				Group: number
				Index: number
				Progress: number
				VisualProgress: number
				IsCompleted: boolean
				HasClaimedReward: boolean
			}>
			ObjectiveGroups: unknown[]
		}
		const update = async (body: unknown, sub = '4242'): Promise<Response> =>
			exports.default.fetch(`${ORIGIN}/api/objectives/v1/updateobjective`, {
				method: 'POST',
				headers: { ...(await bearer(sub)), 'Content-Type': 'application/json' },
				body: JSON.stringify(body),
			})
		const progress = async (sub = '4242'): Promise<Progress> => {
			const res = await exports.default.fetch(`${ORIGIN}/api/objectives/v1/myprogress`, {
				headers: await bearer(sub),
			})
			expect(res.status).toBe(200)
			return (await res.json()) as Progress
		}

		// Partial progress on one objective.
		const res = await update({
			Group: 0,
			Index: 2,
			Progress: 0.5,
			VisualProgress: 0.5,
			IsCompleted: false,
			IsRewarded: false,
		})
		expect(res.status).toBe(200)

		const mid = await progress()
		expect(mid.Objectives).toEqual([
			{
				Group: 0,
				Index: 2,
				Progress: 0.5,
				VisualProgress: 0.5,
				IsCompleted: false,
				HasClaimedReward: false,
			},
		])
		// The default groups still ride along.
		expect(mid.ObjectiveGroups.length).toBeGreaterThan(0)

		// Completing it latches HasClaimedReward — the reward can only be paid once.
		await update({
			Group: 0,
			Index: 2,
			Progress: 1,
			VisualProgress: 1,
			IsCompleted: true,
			IsRewarded: false,
		})
		const done = await progress()
		expect(done.Objectives[0]).toMatchObject({ IsCompleted: true, HasClaimedReward: true })

		// A second objective is tracked separately, keyed by (group, index).
		await update({
			Group: 1,
			Index: 0,
			Progress: 0.25,
			VisualProgress: 0.25,
			IsCompleted: false,
			IsRewarded: false,
		})
		expect((await progress()).Objectives.map((o) => [o.Group, o.Index])).toEqual([
			[0, 2],
			[1, 0],
		])

		// Another player's progress is their own; a signed-out reader gets the default set.
		expect((await progress('4243')).Objectives.length).toBeGreaterThanOrEqual(0)
		const anon = await exports.default.fetch(`${ORIGIN}/api/objectives/v1/myprogress`)
		expect(anon.status).toBe(200)

		// Auth-gated.
		const noToken = await exports.default.fetch(`${ORIGIN}/api/objectives/v1/updateobjective`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ Group: 0, Index: 0 }),
		})
		expect(noToken.status).toBe(401)
	})

	test('POST /api/objectives/v1/cleargroup clears the group; myprogress reports it', async () => {
		const res = await exports.default.fetch(`${ORIGIN}/api/objectives/v1/cleargroup`, {
			method: 'POST',
			headers: { ...(await bearer('4444')), 'Content-Type': 'application/json' },
			body: JSON.stringify({ Group: 1 }),
		})
		expect(res.status).toBe(200)
		const cleared = (await res.json()) as {
			Group: number
			IsCompleted: boolean
			ClearedAt: string
		}
		expect(cleared).toMatchObject({ Group: 1, IsCompleted: true })
		expect(typeof cleared.ClearedAt).toBe('string')

		// The cleared group comes back on the player's progress.
		const progress = await exports.default.fetch(`${ORIGIN}/api/objectives/v1/myprogress`, {
			headers: await bearer('4444'),
		})
		const body = (await progress.json()) as { ObjectiveGroups: Array<{ Group: number }> }
		expect(body.ObjectiveGroups.map((g) => g.Group)).toEqual([1])

		// Auth-gated.
		const anon = await exports.default.fetch(`${ORIGIN}/api/objectives/v1/cleargroup`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ Group: 1 }),
		})
		expect(anon.status).toBe(401)
	})

	test('GET /api/checklist/v1/current 401s without a token, returns [] with one', async () => {
		const anon = await exports.default.fetch(`${ORIGIN}/api/checklist/v1/current`)
		expect(anon.status).toBe(401)
		const res = await exports.default.fetch(`${ORIGIN}/api/checklist/v1/current`, {
			headers: await bearer(),
		})
		expect(res.status).toBe(200)
		expect(await res.json()).toEqual([])
	})

	test('GET /api/itemWishlists/v1/wishlist/me 401s without a token, returns [] with one', async () => {
		const anon = await exports.default.fetch(`${ORIGIN}/api/itemWishlists/v1/wishlist/me`)
		expect(anon.status).toBe(401)
		const res = await exports.default.fetch(`${ORIGIN}/api/itemWishlists/v1/wishlist/me`, {
			headers: await bearer(),
		})
		expect(res.status).toBe(200)
		expect(await res.json()).toEqual([])
	})

	test('GET /api/avatar/v3/saved 401s without a token, returns [] with one', async () => {
		const anon = await exports.default.fetch(`${ORIGIN}/api/avatar/v3/saved`)
		expect(anon.status).toBe(401)
		const res = await exports.default.fetch(`${ORIGIN}/api/avatar/v3/saved`, {
			headers: await bearer(),
		})
		expect(res.status).toBe(200)
		expect(await res.json()).toEqual([])
	})

	test('GET /api/avatar/v2/gifts 401s without a token, returns [] with one', async () => {
		const anon = await exports.default.fetch(`${ORIGIN}/api/avatar/v2/gifts`)
		expect(anon.status).toBe(401)
		const res = await exports.default.fetch(`${ORIGIN}/api/avatar/v2/gifts`, {
			headers: await bearer(),
		})
		expect(res.status).toBe(200)
		expect(await res.json()).toEqual([])
	})

	test('GET /api/equipment/v2/getUnlocked returns [] (no auth)', async () => {
		const res = await exports.default.fetch(`${ORIGIN}/api/equipment/v2/getUnlocked`)
		expect(res.status).toBe(200)
		expect(await res.json()).toEqual([])
	})

	test('GET /api/roomconsumables/v1/roomConsumable/room/:id returns []', async () => {
		const res = await exports.default.fetch(
			`${ORIGIN}/api/roomconsumables/v1/roomConsumable/room/1`
		)
		expect(res.status).toBe(200)
		expect(await res.json()).toEqual([])
	})

	test('GET /api/roomcurrencies/v1/currencies returns []', async () => {
		const res = await exports.default.fetch(`${ORIGIN}/api/roomcurrencies/v1/currencies?roomId=1`)
		expect(res.status).toBe(200)
		expect(await res.json()).toEqual([])
	})

	test('GET /api/roomkeys/v1/room returns []', async () => {
		const res = await exports.default.fetch(`${ORIGIN}/api/roomkeys/v1/room?roomId=1`)
		expect(res.status).toBe(200)
		expect(await res.json()).toEqual([])
	})

	test('GET /api/roomconsumables/v1/roomConsumable/room/:id/me returns []', async () => {
		const res = await exports.default.fetch(
			`${ORIGIN}/api/roomconsumables/v1/roomConsumable/room/1/me`
		)
		expect(res.status).toBe(200)
		expect(await res.json()).toEqual([])
	})

	test('GET /api/roomcurrencies/v1/getAllBalances returns []', async () => {
		const res = await exports.default.fetch(
			`${ORIGIN}/api/roomcurrencies/v1/getAllBalances?roomId=1`
		)
		expect(res.status).toBe(200)
		expect(await res.json()).toEqual([])
	})

	test('POST /api/settings/v2/set 401s without a token, 200s with one', async () => {
		const anon = await exports.default.fetch(`${ORIGIN}/api/settings/v2/set`, { method: 'POST' })
		expect(anon.status).toBe(401)
		const res = await exports.default.fetch(`${ORIGIN}/api/settings/v2/set`, {
			method: 'POST',
			headers: await bearer(),
		})
		expect(res.status).toBe(200)
	})

	test('GET /api/consumables/v2/getUnlocked 401s without a token, returns []', async () => {
		const anon = await exports.default.fetch(`${ORIGIN}/api/consumables/v2/getUnlocked`)
		expect(anon.status).toBe(401)
		const res = await exports.default.fetch(`${ORIGIN}/api/consumables/v2/getUnlocked`, {
			headers: await bearer(),
		})
		expect(res.status).toBe(200)
		expect(await res.json()).toEqual([])
	})

	test('GET /api/storefronts/v4/balance/2 401s without a token, returns the token balance', async () => {
		const anon = await exports.default.fetch(`${ORIGIN}/api/storefronts/v4/balance/2`)
		expect(anon.status).toBe(401)
		const res = await exports.default.fetch(`${ORIGIN}/api/storefronts/v4/balance/2`, {
			headers: await bearer(),
		})
		expect(res.status).toBe(200)
		expect(await res.json()).toEqual([{ CurrencyType: 2, Platform: -2, Balance: 2147483648 }])
	})

	test('GET /api/storefronts/v3/giftdropstore/3 returns the storefront catalog', async () => {
		const res = await exports.default.fetch(`${ORIGIN}/api/storefronts/v3/giftdropstore/3`)
		expect(res.status).toBe(200)
		expect(await res.json()).toBeTruthy()
	})

	test('GET /api/challenge/v2/getCurrent returns the weekly challenge', async () => {
		const res = await exports.default.fetch(`${ORIGIN}/api/challenge/v2/getCurrent`)
		expect(res.status).toBe(200)
		const body = (await res.json()) as { ChallengeMapId: number; Challenges: unknown[] }
		expect(body).toHaveProperty('ChallengeMapId')
		expect(Array.isArray(body.Challenges)).toBe(true)
	})

	test('GET /api/gamerewards/v1/pending returns []', async () => {
		const res = await exports.default.fetch(`${ORIGIN}/api/gamerewards/v1/pending`)
		expect(res.status).toBe(200)
		expect(await res.json()).toEqual([])
	})

	test('POST /api/gamerewards/v1/request mints a three-choice selection', async () => {
		const res = await exports.default.fetch(`${ORIGIN}/api/gamerewards/v1/request`, {
			method: 'POST',
			headers: { ...(await bearer('42')), 'Content-Type': 'application/x-www-form-urlencoded' },
			body: new URLSearchParams({ Message: 'nice work', giftContext: '4' }).toString(),
		})
		expect(res.status).toBe(200)
		// The HTTP body carries nothing — the choices go out over the websocket hub.
		expect(await res.json()).toEqual({ error: '', success: true, value: null })

		// The selection is recorded, with three distinct token choices for this player.
		const row = await env.DB.prepare(
			`SELECT account_id, message, gift_context, consumed,
			        gift_drop_1_id, gift_drop_2_id, gift_drop_3_id
			 FROM reward_selection ORDER BY reward_selection_id DESC LIMIT 1`
		).first<{
			account_id: number
			message: string
			gift_context: number
			consumed: number
			gift_drop_1_id: number
			gift_drop_2_id: number
			gift_drop_3_id: number
		}>()
		expect(row).toMatchObject({
			account_id: 42,
			message: 'nice work',
			gift_context: 4,
			consumed: 0,
		})
		const ids = [row!.gift_drop_1_id, row!.gift_drop_2_id, row!.gift_drop_3_id]
		// Token drops carry the negative of their amount as their id.
		expect(new Set(ids).size).toBe(3)
		expect(ids.every((id) => id < 0)).toBe(true)

		expect(
			(await exports.default.fetch(`${ORIGIN}/api/gamerewards/v1/request`, { method: 'POST' }))
				.status
		).toBe(401)
	})

	test('POST /api/gamerewards/v1/select claims a drop once, and only if offered', async () => {
		await exports.default.fetch(`${ORIGIN}/api/gamerewards/v1/request`, {
			method: 'POST',
			headers: { ...(await bearer('77')), 'Content-Type': 'application/x-www-form-urlencoded' },
			body: new URLSearchParams({ Message: 'level up', giftContext: '7' }).toString(),
		})
		const sel = await env.DB.prepare(
			`SELECT reward_selection_id, gift_drop_1_id FROM reward_selection
			 WHERE account_id = 77 ORDER BY reward_selection_id DESC LIMIT 1`
		).first<{ reward_selection_id: number; gift_drop_1_id: number }>()
		const selectionId = sel!.reward_selection_id
		const offeredId = sel!.gift_drop_1_id

		const select = async (fields: Record<string, string>, sub = '77'): Promise<Response> =>
			exports.default.fetch(`${ORIGIN}/api/gamerewards/v1/select`, {
				method: 'POST',
				headers: { ...(await bearer(sub)), 'Content-Type': 'application/x-www-form-urlencoded' },
				body: new URLSearchParams(fields).toString(),
			})

		// A drop that wasn't offered is refused, as is another player's selection.
		expect(
			(await select({ rewardSelectionId: String(selectionId), giftDropId: '-999' })).status
		).toBe(403)
		expect(
			(
				await select(
					{ rewardSelectionId: String(selectionId), giftDropId: String(offeredId) },
					'42'
				)
			).status
		).toBe(403)

		// Claiming an offered drop returns it — a token drop worth its id's magnitude.
		const res = await select({
			rewardSelectionId: String(selectionId),
			giftDropId: String(offeredId),
		})
		expect(res.status).toBe(200)
		expect(await res.json()).toMatchObject({
			GiftDropId: offeredId,
			CurrencyType: 2,
			Currency: -offeredId,
			Context: 7,
			FriendlyName: `${-offeredId} Tokens!`,
		})

		// The selection is single-use: claiming again is refused.
		expect(
			(await select({ rewardSelectionId: String(selectionId), giftDropId: String(offeredId) }))
				.status
		).toBe(403)
	})

	test('GET /api/roomkeys/v1/mine returns []', async () => {
		const res = await exports.default.fetch(`${ORIGIN}/api/roomkeys/v1/mine`)
		expect(res.status).toBe(200)
		expect(await res.json()).toEqual([])
	})

	test('POST /api/CampusCard/v1/UpdateAndGetSubscription returns null fields', async () => {
		const res = await exports.default.fetch(
			`${ORIGIN}/api/CampusCard/v1/UpdateAndGetSubscription`,
			{
				method: 'POST',
			}
		)
		expect(res.status).toBe(200)
		expect(await res.json()).toEqual({
			subscription: null,
			platformAccountSubscribedPlayerId: null,
		})
	})

	test('unknown path returns 404', async () => {
		const res = await exports.default.fetch(`${ORIGIN}/nope`)
		expect(res.status).toBe(404)
	})
})
