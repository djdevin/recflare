import { env } from 'cloudflare:test'
import { exports } from 'cloudflare:workers'
import { beforeAll, describe, expect, test } from 'vitest'

import '../../econ.app'

import { SCHEMA_DDL } from '../../avatar-db'

import type { Env } from '../../context'

declare module 'cloudflare:test' {
	interface ProvidedEnv extends Env {}
}

const ORIGIN = 'https://example.com'

// Build the accounts table and seed the test player (the default token's sub, 42)
// so avatar reads/writes have a row to attach to.
beforeAll(async () => {
	for (const stmt of SCHEMA_DDL) await env.DB.prepare(stmt).run()
	await env.DB.prepare('INSERT OR IGNORE INTO accounts (data) VALUES (?1)')
		.bind(JSON.stringify({ accountId: 42, username: 'Tester', displayName: 'Tester' }))
		.run()
})

// Mint a token the way the `auth` worker does, using the same dev secret.
const DEV_SECRET = 'dev-insecure-signing-key-change-me'

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
		new TextEncoder().encode(DEV_SECRET),
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
		await env.DB.prepare('INSERT OR IGNORE INTO accounts (data) VALUES (?1)')
			.bind(JSON.stringify({ accountId: 314, username: 'Pi', displayName: 'Pi' }))
			.run()
		await env.DB.prepare('UPDATE accounts SET avatar = ?2 WHERE account_id = ?1')
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
