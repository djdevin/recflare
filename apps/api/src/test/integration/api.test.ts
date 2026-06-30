import { env } from 'cloudflare:test'
import { exports } from 'cloudflare:workers'
import { beforeAll, describe, expect, test } from 'vitest'

import '../../api.app'

import { DEFAULT_AVATAR_ITEMS } from '../../default-avatar-items'

import type { Env } from '../../context'

declare module 'cloudflare:test' {
	interface ProvidedEnv extends Env {}
}

const ORIGIN = 'https://example.com'

// The /roomserver/rooms/* routes read from the shared recflare D1. Set up the
// schema (matching the rooms worker's migration) + a couple of rooms for tests.
const TEST_ROOMS = [
	{
		RoomId: 1,
		Name: 'DormRoom',
		IsDorm: true,
		CreatorAccountId: 1,
		SubRooms: [{ SubRoomId: 1, UnitySceneId: '76d98498-60a1-430c-ab76-b54a29b7a163' }],
	},
	{ RoomId: 2, Name: 'RecCenter', IsDorm: false, CreatorAccountId: 1, SubRooms: [{ SubRoomId: 2 }] },
]

beforeAll(async () => {
	await env.DB.prepare(
		`CREATE TABLE IF NOT EXISTS rooms (
			data TEXT NOT NULL,
			room_id INTEGER GENERATED ALWAYS AS (json_extract(data, '$.RoomId')) VIRTUAL,
			name_lower TEXT GENERATED ALWAYS AS (lower(json_extract(data, '$.Name'))) VIRTUAL,
			creator_account_id INTEGER GENERATED ALWAYS AS (json_extract(data, '$.CreatorAccountId')) VIRTUAL
		)`
	).run()
	const insert = env.DB.prepare('INSERT OR IGNORE INTO rooms (data) VALUES (?1)')
	await env.DB.batch(TEST_ROOMS.map((r) => insert.bind(JSON.stringify(r))))

	// Accounts table (matching the auth worker's migration) — uploadsaved records
	// profile thumbnails on the account row. Seed the account the test token (sub
	// 42) authenticates as.
	await env.DB.prepare(
		`CREATE TABLE IF NOT EXISTS accounts (
			data TEXT NOT NULL,
			account_id INTEGER GENERATED ALWAYS AS (json_extract(data, '$.AccountId')) VIRTUAL,
			username_lower TEXT GENERATED ALWAYS AS (lower(json_extract(data, '$.Username'))) VIRTUAL
		)`
	).run()
	await env.DB.prepare('INSERT OR IGNORE INTO accounts (data) VALUES (?1)')
		.bind(JSON.stringify({ AccountId: 42, Username: 'Tester', ProfileImage: 'DefaultProfileImage.jpg' }))
		.run()
})

// Mint a token the way the `auth` worker does, using the same dev secret, so the
// api worker's validation accepts it. Kept inline to avoid a cross-package import.
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

describe('public endpoints', () => {
	test('GET /api/config/v1/amplitude', async () => {
		const res = await exports.default.fetch(`${ORIGIN}/api/config/v1/amplitude`)
		expect(res.status).toBe(200)
		expect(await res.json()).toEqual({
			AmplitudeKey: 'a',
			StatSigKey: 'a',
			RudderStackKey: 'a',
			UseRudderStack: false,
		})
	})

	test('GET /api/config/v1/azurespeech', async () => {
		const res = await exports.default.fetch(`${ORIGIN}/api/config/v1/azurespeech`)
		expect(res.status).toBe(200)
		expect(await res.json()).toEqual({
			Key: 'dce8de5b297747d9b5bddcc7f19e8c5b',
			Region: 'eastus',
			Enabled: false,
		})
	})

	test('GET /api/config/v1/backtrace', async () => {
		const res = await exports.default.fetch(`${ORIGIN}/api/config/v1/backtrace`)
		expect(res.status).toBe(200)
		const body = (await res.json()) as { ReportBudget: number; VersionRegex: string }
		expect(body).toMatchObject({ ReportBudget: 125, VersionRegex: '.*' })
	})

	test('GET /api/versioncheck/v4', async () => {
		const res = await exports.default.fetch(`${ORIGIN}/api/versioncheck/v4`)
		expect(await res.json()).toMatchObject({ VersionStatus: 0 })
	})

	test('GET /api/relationships/v2/get returns empty array', async () => {
		const res = await exports.default.fetch(`${ORIGIN}/api/relationships/v2/get`)
		expect(await res.json()).toEqual([])
	})

	test('GET /api/playerReputation/v1/:id echoes the id', async () => {
		const res = await exports.default.fetch(`${ORIGIN}/api/playerReputation/v1/99`)
		expect(await res.json()).toMatchObject({ AccountId: 99, CheerCredit: 20 })
	})

	test('GET /api/playerReputation/v2/bulk?id= returns a reputation per id', async () => {
		const res = await exports.default.fetch(`${ORIGIN}/api/playerReputation/v2/bulk?id=1&id=2`)
		expect(res.status).toBe(200)
		const reps = (await res.json()) as Array<{ AccountId: number; CheerCredit: number }>
		expect(reps.map((r) => r.AccountId)).toEqual([1, 2])
		expect(reps[0]).toMatchObject({ CheerCredit: 20 })
	})

	test('POST /api/playerReputation/v2/bulk returns a reputation per id', async () => {
		const res = await exports.default.fetch(`${ORIGIN}/api/playerReputation/v2/bulk`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
			body: new URLSearchParams({ Ids: '1,2,3' }),
		})
		expect(res.status).toBe(200)
		const reps = (await res.json()) as Array<{ AccountId: number; CheerCredit: number }>
		expect(reps.map((r) => r.AccountId)).toEqual([1, 2, 3])
		expect(reps.every((r) => r.CheerCredit === 20)).toBe(true)
	})

	test('POST /api/playerReputation/v2/bulk returns [] without ids', async () => {
		const res = await exports.default.fetch(`${ORIGIN}/api/playerReputation/v2/bulk`, {
			method: 'POST',
		})
		expect(await res.json()).toEqual([])
	})

	test('GET /api/storefronts/v1/p2p/betaEnabled returns false', async () => {
		const res = await exports.default.fetch(`${ORIGIN}/api/storefronts/v1/p2p/betaEnabled`)
		expect(await res.json()).toBe(false)
	})

	test('GET /api/players/v2/progression/bulk?id= returns progression per id', async () => {
		const res = await exports.default.fetch(`${ORIGIN}/api/players/v2/progression/bulk?id=1&id=2`)
		expect(res.status).toBe(200)
		const body = (await res.json()) as Array<{ PlayerId: number; Level: number }>
		expect(body.map((p) => p.PlayerId)).toEqual([1, 2])
		expect(body[0]).toMatchObject({ Level: 1, XP: 0 })
	})

	test('POST /api/players/v2/progression/bulk returns an array', async () => {
		const res = await exports.default.fetch(`${ORIGIN}/api/players/v2/progression/bulk`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
			body: new URLSearchParams({ Ids: '1,2,3' }),
		})
		expect(res.status).toBe(200)
		expect(await res.json()).toEqual([])
	})

	test('GET /api/customAvatarItems/v1/isCreationAllowedForAccount returns true', async () => {
		const res = await exports.default.fetch(
			`${ORIGIN}/api/customAvatarItems/v1/isCreationAllowedForAccount`
		)
		expect(res.status).toBe(200)
		expect(await res.json()).toBe(true)
	})

	test('GET /api/customAvatarItems/v1/isCreationEnabled returns true', async () => {
		const res = await exports.default.fetch(`${ORIGIN}/api/customAvatarItems/v1/isCreationEnabled`)
		expect(res.status).toBe(200)
		expect(await res.json()).toBe(true)
	})

	test('GET /api/customAvatarItems/v1/isRenderingEnabled returns true', async () => {
		const res = await exports.default.fetch(`${ORIGIN}/api/customAvatarItems/v1/isRenderingEnabled`)
		expect(res.status).toBe(200)
		expect(await res.json()).toBe(true)
	})

	test('GET /api/rooms/v1/filters returns an object with filter arrays', async () => {
		const res = await exports.default.fetch(`${ORIGIN}/api/rooms/v1/filters`)
		expect(res.status).toBe(200)
		const body = (await res.json()) as { PinnedFilters: string[]; PopularFilters: string[] }
		expect(Array.isArray(body.PinnedFilters)).toBe(true)
		expect(Array.isArray(body.PopularFilters)).toBe(true)
	})

	test('GET /api/keepsakes/globalconfig returns the keepsake config', async () => {
		const res = await exports.default.fetch(`${ORIGIN}/api/keepsakes/globalconfig`)
		expect(res.status).toBe(200)
		expect(await res.json()).toMatchObject({ KeepsakeFeatureEnabled: true })
	})

	test('GET /api/keepsakes/rooms/:id returns 204; categories returns []', async () => {
		const room = await exports.default.fetch(`${ORIGIN}/api/keepsakes/rooms/1`)
		expect(room.status).toBe(204)
		const cats = await exports.default.fetch(`${ORIGIN}/api/keepsakes/categories`)
		expect(cats.status).toBe(200)
		expect(await cats.json()).toEqual([])
	})

	test('GET /voice/config returns an object', async () => {
		const res = await exports.default.fetch(`${ORIGIN}/voice/config`)
		expect(res.status).toBe(200)
		expect(await res.json()).toEqual({})
	})

	test('GET /api/inventions/v2/mine returns []', async () => {
		const res = await exports.default.fetch(`${ORIGIN}/api/inventions/v2/mine`)
		expect(res.status).toBe(200)
		expect(await res.json()).toEqual([])
	})

	test('POST /api/sanitize/v1 echoes the value; isPure reports true', async () => {
		const san = await exports.default.fetch(`${ORIGIN}/api/sanitize/v1`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ Value: 'hello world' }),
		})
		expect(san.status).toBe(200)
		expect(await san.json()).toBe('hello world')

		const pure = await exports.default.fetch(`${ORIGIN}/api/sanitize/v1/isPure`, { method: 'POST' })
		expect(pure.status).toBe(200)
		expect(await pure.json()).toEqual({ IsPure: true })
	})
})

describe('auth-gated endpoints', () => {
	test('401 without a bearer token', async () => {
		const res = await exports.default.fetch(`${ORIGIN}/api/avatar/v4/items`)
		expect(res.status).toBe(401)
	})

	test('401 with a garbage token', async () => {
		const res = await exports.default.fetch(`${ORIGIN}/api/avatar/v4/items`, {
			headers: { Authorization: 'Bearer not-a-real-token' },
		})
		expect(res.status).toBe(401)
	})

	test('GET /api/avatar/v4/items returns default items with a valid token', async () => {
		const res = await exports.default.fetch(`${ORIGIN}/api/avatar/v4/items`, {
			headers: await bearer(),
		})
		expect(res.status).toBe(200)
		const items = (await res.json()) as unknown[]
		expect(items).toHaveLength(DEFAULT_AVATAR_ITEMS.length)
	})

	test('GET /api/settings/v2 returns the default settings for the account', async () => {
		const res = await exports.default.fetch(`${ORIGIN}/api/settings/v2`, {
			headers: await bearer(),
		})
		expect(res.status).toBe(200)
		const settings = (await res.json()) as Array<{ PlayerId: number; Key: string }>
		expect(Array.isArray(settings)).toBe(true)
		for (const s of settings) expect(s.PlayerId).toBe(42)
	})

	test('GET /api/avatar/v2 returns a default avatar', async () => {
		const res = await exports.default.fetch(`${ORIGIN}/api/avatar/v2`, { headers: await bearer() })
		const body = (await res.json()) as { OutfitSelections: string }
		expect(body.OutfitSelections.length).toBeGreaterThan(0)
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
})

describe('room server', () => {
	test('GET /roomserver/rooms/bulk requires id or name', async () => {
		const res = await exports.default.fetch(`${ORIGIN}/roomserver/rooms/bulk`)
		expect(res.status).toBe(400)
	})

	test('GET /roomserver/rooms/bulk with id returns rooms from D1', async () => {
		const res = await exports.default.fetch(`${ORIGIN}/roomserver/rooms/bulk?id=1,2`)
		expect(res.status).toBe(200)
		const rooms = (await res.json()) as Array<{ RoomId: number; Name: string }>
		expect(rooms.map((r) => r.RoomId).sort((a, b) => a - b)).toEqual([1, 2])
	})

	test('GET /roomserver/rooms/bulk?name= resolves from D1', async () => {
		const res = await exports.default.fetch(`${ORIGIN}/roomserver/rooms/bulk?name=reccenter`)
		const rooms = (await res.json()) as Array<{ Name: string }>
		expect(rooms.map((r) => r.Name)).toEqual(['RecCenter'])
	})

	test('GET /roomserver/photon_access_token returns permissions + instance id', async () => {
		const res = await exports.default.fetch(`${ORIGIN}/roomserver/photon_access_token`)
		expect(res.status).toBe(200)
		const body = (await res.json()) as {
			Permissions: unknown[]
			PhotonAccessToken: string
			RoomInstanceId: number
		}
		expect(Array.isArray(body.Permissions)).toBe(true)
		expect(body.Permissions.length).toBeGreaterThan(0)
		expect(body).toMatchObject({ PhotonAccessToken: '', RoomInstanceId: 1 })
	})

	test('GET /roomserver/rooms/hot returns an empty result set', async () => {
		const res = await exports.default.fetch(`${ORIGIN}/roomserver/rooms/hot`)
		expect(await res.json()).toEqual({ Results: [], TotalResults: 0 })
	})

	test('GET /roomserver/rooms/:id returns the room from D1', async () => {
		const res = await exports.default.fetch(`${ORIGIN}/roomserver/rooms/1`)
		expect(res.status).toBe(200)
		const room = (await res.json()) as {
			RoomId: number
			IsDorm: boolean
			SubRooms: Array<{ UnitySceneId: string }>
		}
		expect(room).toMatchObject({ RoomId: 1, IsDorm: true })
		expect(room.SubRooms[0].UnitySceneId).toBe('76d98498-60a1-430c-ab76-b54a29b7a163')
	})

	test('GET /roomserver/rooms/:id 404s for an unknown room', async () => {
		const res = await exports.default.fetch(`${ORIGIN}/roomserver/rooms/99999`)
		expect(res.status).toBe(404)
	})

	test('GET /roomserver/rooms/:id/interactionby/me', async () => {
		const res = await exports.default.fetch(`${ORIGIN}/roomserver/rooms/5/interactionby/me`)
		expect(await res.json()).toEqual({ Cheered: false, Favorited: false })
	})
})

describe('images', () => {
	test('POST /api/images/v4/uploadsaved stores the file in R2 and returns its name', async () => {
		const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4])
		const fd = new FormData()
		fd.append('image', new File([bytes], 'avatar.png', { type: 'image/png' }))

		const res = await exports.default.fetch(`${ORIGIN}/api/images/v4/uploadsaved`, {
			method: 'POST',
			headers: await bearer(),
			body: fd,
		})
		expect(res.status).toBe(200)
		const { ImageName } = (await res.json()) as { ImageName: string }
		expect(ImageName).toMatch(/^[0-9a-f]+\.png$/)

		// The object is in the shared bucket under that key.
		const stored = await env.IMAGES.get(ImageName)
		expect(stored).not.toBeNull()
		expect(new Uint8Array(await stored!.arrayBuffer())).toEqual(bytes)
	})

	test('POST /api/images/v4/uploadsaved records a profile thumbnail on the account', async () => {
		const bytes = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3])
		const fd = new FormData()
		// Type 4 = ProfileThumbnail. The client sends the file as image.dat.
		fd.append('imgMeta', JSON.stringify({ savedImageType: 4, roomId: -1 }))
		fd.append('image', new File([bytes], 'image.dat', { type: 'image/jpeg' }))

		const res = await exports.default.fetch(`${ORIGIN}/api/images/v4/uploadsaved`, {
			method: 'POST',
			headers: await bearer('42'),
			body: fd,
		})
		expect(res.status).toBe(200)
		const { ImageName } = (await res.json()) as { ImageName: string }
		expect(ImageName).toMatch(/^[0-9a-f]+\.jpg$/)

		// The account row now points its ProfileImage at the uploaded key.
		const row = await env.DB.prepare('SELECT data FROM accounts WHERE account_id = 42').first<{
			data: string
		}>()
		expect(JSON.parse(row!.data).ProfileImage).toBe(ImageName)
	})

	test('POST /api/images/v4/uploadsaved 401s without a bearer token', async () => {
		const fd = new FormData()
		fd.append('image', new File([new Uint8Array([1, 2, 3])], 'avatar.png', { type: 'image/png' }))
		const res = await exports.default.fetch(`${ORIGIN}/api/images/v4/uploadsaved`, {
			method: 'POST',
			body: fd,
		})
		expect(res.status).toBe(401)
	})

	test('POST /api/images/v4/uploadsaved 400s without a file', async () => {
		const res = await exports.default.fetch(`${ORIGIN}/api/images/v4/uploadsaved`, {
			method: 'POST',
			headers: { ...(await bearer()), 'Content-Type': 'application/x-www-form-urlencoded' },
			body: 'foo=bar',
		})
		expect(res.status).toBe(400)
	})
})
