import { adminSecretsStore, env } from 'cloudflare:test'
import { exports } from 'cloudflare:workers'
import { beforeAll, describe, expect, test } from 'vitest'

import '../../api.app'

import { SCHEMA_DDL as IMAGES_SCHEMA_DDL } from '../../images-db'
import { SCHEMA_DDL as RELATIONSHIPS_SCHEMA_DDL } from '../../relationships-db'

import type { Env } from '../../context'
import type { SavedImage } from '../../images-db'

declare module 'cloudflare:test' {
	interface ProvidedEnv extends Env {}
}

const ORIGIN = 'https://example.com'

// `/api/rooms/v1/verifyRole` reads room roles from the shared recflare D1. Set
// up the schema (matching the rooms worker's migration) + a couple of rooms.
const TEST_ROOMS = [
	{
		RoomId: 2,
		Name: 'RecCenter',
		IsDorm: false,
		CreatorAccountId: 1,
		SubRooms: [{ SubRoomId: 2 }],
	},
	{
		// Owned by account 1; account 42 holds Role 30 (a co-owner) for verifyRole tests.
		RoomId: 3,
		Name: 'RoleRoom',
		IsDorm: false,
		CreatorAccountId: 1,
		SubRooms: [{ SubRoomId: 3 }],
		Roles: [{ AccountId: 42, Role: 30, LastChangedByAccountId: null, InvitedRole: 0 }],
	},
]

beforeAll(async () => {
	// Seed the shared JWT signing key into the local Secrets Store so .get() resolves.
	await adminSecretsStore(env.JWT_SECRET).create('test-signing-key')
	await env.DB.prepare(
		`CREATE TABLE IF NOT EXISTS room (
			data TEXT NOT NULL,
			room_id INTEGER GENERATED ALWAYS AS (json_extract(data, '$.RoomId')) VIRTUAL,
			name_lower TEXT GENERATED ALWAYS AS (lower(json_extract(data, '$.Name'))) VIRTUAL,
			creator_account_id INTEGER GENERATED ALWAYS AS (json_extract(data, '$.CreatorAccountId')) VIRTUAL
		)`
	).run()
	const insert = env.DB.prepare('INSERT OR IGNORE INTO room (data) VALUES (?1)')
	await env.DB.batch(TEST_ROOMS.map((r) => insert.bind(JSON.stringify(r))))

	// Accounts table (matching the auth worker's migration) — uploadsaved records
	// profile thumbnails on the account row. Seed the account the test token (sub
	// 42) authenticates as.
	await env.DB.prepare(
		`CREATE TABLE IF NOT EXISTS accounts (
			data TEXT NOT NULL,
			account_id INTEGER GENERATED ALWAYS AS (json_extract(data, '$.accountId')) VIRTUAL,
			username_lower TEXT GENERATED ALWAYS AS (lower(json_extract(data, '$.username'))) VIRTUAL
		)`
	).run()
	await env.DB.prepare('INSERT OR IGNORE INTO accounts (data) VALUES (?1)')
		.bind(
			JSON.stringify({ accountId: 42, username: 'Tester', profileImage: 'DefaultProfileImage.jpg' })
		)
		.run()

	// Images table (owned by the img worker) — uploadsaved records a row here.
	for (const stmt of IMAGES_SCHEMA_DDL) await env.DB.prepare(stmt).run()

	// Relationships table (owned by the api worker) — friendship endpoints use it.
	for (const stmt of RELATIONSHIPS_SCHEMA_DDL) await env.DB.prepare(stmt).run()
})

// Mint a token the way the `auth` worker does, signing with the shared test key seeded into the JWT_SECRET store, so the
// api worker's validation accepts it. Kept inline to avoid a cross-package import.
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

	test('GET /api/relationships/v2/get returns empty array for a player with none', async () => {
		const res = await exports.default.fetch(`${ORIGIN}/api/relationships/v2/get`, {
			headers: await bearer('99999'),
		})
		expect(res.status).toBe(200)
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

	test('GET /api/customAvatarItems/v2/fromCreator/:id returns an empty paginated result', async () => {
		const res = await exports.default.fetch(`${ORIGIN}/api/customAvatarItems/v2/fromCreator/2`)
		expect(res.status).toBe(200)
		expect(await res.json()).toEqual({ Results: [], TotalResults: 0 })
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
		const res = await exports.default.fetch(`${ORIGIN}/api/consumables/v2/getUnlocked`)
		expect(res.status).toBe(401)
	})

	test('401 with a garbage token', async () => {
		const res = await exports.default.fetch(`${ORIGIN}/api/consumables/v2/getUnlocked`, {
			headers: { Authorization: 'Bearer not-a-real-token' },
		})
		expect(res.status).toBe(401)
	})
})

describe('rooms', () => {
	test('POST /api/rooms/v1/verifyRole checks creator + room roles', async () => {
		const verify = async (fields: Record<string, string>, sub?: string): Promise<boolean> => {
			const res = await exports.default.fetch(`${ORIGIN}/api/rooms/v1/verifyRole`, {
				method: 'POST',
				headers: {
					'Content-Type': 'application/x-www-form-urlencoded',
					...(sub ? await bearer(sub) : {}),
				},
				body: new URLSearchParams(fields).toString(),
			})
			expect(res.status).toBe(200)
			return (await res.json()) as boolean
		}

		// No token → false.
		expect(await verify({ roomId: '2', role: '255' })).toBe(false)
		// Creator (account 1 owns room 2) → true regardless of role.
		expect(await verify({ roomId: '2', role: '255', context: 'MakerPen' }, '1')).toBe(true)
		// Non-creator with no role in the room → false.
		expect(await verify({ roomId: '2', role: '30' }, '42')).toBe(false)
		// Account 42 holds Role 30 in room 3 → passes when requesting ≤ 30…
		expect(await verify({ roomId: '3', role: '30' }, '42')).toBe(true)
		// …but not a higher role.
		expect(await verify({ roomId: '3', role: '255' }, '42')).toBe(false)
		// Unknown room → false.
		expect(await verify({ roomId: '99999', role: '0' }, '42')).toBe(false)
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

		// A metadata row was created, and it's readable by name via /api/images/v6.
		const meta = (await (
			await exports.default.fetch(`${ORIGIN}/api/images/v6?name=${ImageName}`)
		).json()) as { ImageName: string; PlayerId: number; Id: number; CheerCount: number }
		expect(meta.ImageName).toBe(ImageName)
		expect(meta.PlayerId).toBe(42)
		expect(typeof meta.Id).toBe('number')
		expect(meta.CheerCount).toBe(0)
	})

	test('GET /api/images/v1/slideshow is auth-gated and joins username + room name', async () => {
		// No token → 401.
		expect((await exports.default.fetch(`${ORIGIN}/api/images/v1/slideshow`)).status).toBe(401)

		// Seed a public image (Accessibility 1) taken in RecCenter (room 2) by account 42.
		await env.DB.prepare('INSERT INTO image (data) VALUES (?1)')
			.bind(
				JSON.stringify({
					Id: 9001,
					Type: 1,
					Accessibility: 1,
					AccessibilityLocked: false,
					ImageName: 'slide9001.jpg',
					Description: null,
					PlayerId: 42,
					TaggedPlayerIds: [7, 8],
					RoomId: 2,
					PlayerEventId: null,
					CreatedAt: new Date().toISOString(),
					CheerCount: 0,
					CommentCount: 0,
				})
			)
			.run()

		const res = await exports.default.fetch(`${ORIGIN}/api/images/v1/slideshow`, {
			headers: await bearer(),
		})
		expect(res.status).toBe(200)
		const body = (await res.json()) as {
			Images: Array<Record<string, unknown>>
			ValidTill: string
		}
		expect(body.ValidTill).toMatch(/Z$/)
		const slide = body.Images.find((i) => i.SavedImageId === 9001)
		expect(slide).toMatchObject({
			SavedImageId: 9001,
			ImageName: 'slide9001.jpg',
			Username: 'Tester', // account 42 seeded above
			RoomName: 'RecCenter', // room 2
			RoomId: 2,
			SavedImageType: 1,
			Accessibility: 1,
			PlayerIds: [7, 8],
		})
	})

	test('POST /api/images/v1/cheer is auth-gated and stubs success', async () => {
		const body = JSON.stringify({ SavedImageId: 2, Cheer: true })
		// No token → 401.
		expect(
			(
				await exports.default.fetch(`${ORIGIN}/api/images/v1/cheer`, {
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					body,
				})
			).status
		).toBe(401)
		// With a token → accepted.
		const res = await exports.default.fetch(`${ORIGIN}/api/images/v1/cheer`, {
			method: 'POST',
			headers: { ...(await bearer()), 'Content-Type': 'application/json' },
			body,
		})
		expect(res.status).toBe(200)
		expect(await res.json()).toEqual({ success: true })
	})

	test('GET /api/images/v6 400s without a name and 404s for an unknown one', async () => {
		expect((await exports.default.fetch(`${ORIGIN}/api/images/v6`)).status).toBe(400)
		expect(
			(await exports.default.fetch(`${ORIGIN}/api/images/v6?name=doesnotexist.jpg`)).status
		).toBe(404)
	})

	test('POST /api/images/v4/uploadsaved records metadata from imgMeta', async () => {
		const fd = new FormData()
		// The client's real imgMeta shape (tagged players are `playerIds`).
		fd.append(
			'imgMeta',
			JSON.stringify({
				playerIds: [5, 6],
				savedImageType: 1,
				roomId: 777,
				playerEventId: 0,
				accessibility: 2,
			})
		)
		fd.append('image', new File([new Uint8Array([1, 2, 3])], 'pic.png', { type: 'image/png' }))
		const res = await exports.default.fetch(`${ORIGIN}/api/images/v4/uploadsaved`, {
			method: 'POST',
			headers: await bearer('42'),
			body: fd,
		})
		const { ImageName } = (await res.json()) as { ImageName: string }

		const meta = (await (
			await exports.default.fetch(`${ORIGIN}/api/images/v6?name=${ImageName}`)
		).json()) as {
			Type: number
			RoomId: number
			Accessibility: number
			TaggedPlayerIds: number[]
			PlayerEventId: number | null
		}
		expect(meta.Type).toBe(1)
		expect(meta.RoomId).toBe(777)
		expect(meta.Accessibility).toBe(2)
		expect(meta.TaggedPlayerIds).toEqual([5, 6])
		// playerEventId 0 means "none" → stored as null.
		expect(meta.PlayerEventId).toBeNull()
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

		// The account row now points its profileImage at the uploaded key.
		const row = await env.DB.prepare('SELECT data FROM accounts WHERE account_id = 42').first<{
			data: string
		}>()
		expect(JSON.parse(row!.data).profileImage).toBe(ImageName)
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

	test('GET /api/images/v4/room/:id returns a public room feed, filtered/sorted/paginated', async () => {
		// Seed images in room 54: two public (one with more cheers, of different
		// types), one private (hidden), and one in another room (excluded).
		const seed = (img: Partial<SavedImage> & { Id: number }) =>
			env.DB.prepare('INSERT INTO image (data) VALUES (?1)').bind(
				JSON.stringify({
					Type: 1,
					Accessibility: 1,
					AccessibilityLocked: false,
					ImageName: `img${img.Id}.jpg`,
					Description: null,
					PlayerId: 42,
					TaggedPlayerIds: [],
					RoomId: 54,
					PlayerEventId: null,
					CreatedAt: '2026-01-01T00:00:00.000Z',
					CheerCount: 0,
					CommentCount: 0,
					...img,
				})
			)
		await env.DB.batch([
			seed({ Id: 101, CheerCount: 5, CreatedAt: '2026-02-01T00:00:00.000Z' }),
			seed({ Id: 102, CheerCount: 9, CreatedAt: '2026-01-15T00:00:00.000Z', Type: 3 }),
			seed({ Id: 103, Accessibility: 0 }), // private → hidden from the public feed
			seed({ Id: 104, RoomId: 99 }), // different room → excluded
		])

		// sort=1 → most cheered first (102 has 9, 101 has 5).
		const top = (await (
			await exports.default.fetch(`${ORIGIN}/api/images/v4/room/54?sort=1&filter=0&take=100&skip=0`)
		).json()) as SavedImage[]
		expect(top.map((i) => i.Id)).toEqual([102, 101])

		// sort=0 → newest first (101 is more recent than 102).
		const newest = (await (
			await exports.default.fetch(`${ORIGIN}/api/images/v4/room/54?sort=0`)
		).json()) as SavedImage[]
		expect(newest.map((i) => i.Id)).toEqual([101, 102])

		// filter=1 (ShareCamera) drops the Type-3 image (102).
		const filtered = (await (
			await exports.default.fetch(`${ORIGIN}/api/images/v4/room/54?filter=1`)
		).json()) as SavedImage[]
		expect(filtered.map((i) => i.Id)).toEqual([101])

		// take/skip paginate.
		const page = (await (
			await exports.default.fetch(`${ORIGIN}/api/images/v4/room/54?sort=1&take=1&skip=1`)
		).json()) as SavedImage[]
		expect(page.map((i) => i.Id)).toEqual([101])

		// A room with no images → empty array.
		expect(
			await (await exports.default.fetch(`${ORIGIN}/api/images/v4/room/12345`)).json()
		).toEqual([])
	})

	test('GET /api/images/v4/player/:id and v3/feed/player/:id return the player photos + feed', async () => {
		const seed = (img: Partial<SavedImage> & { Id: number }) =>
			env.DB.prepare('INSERT INTO image (data) VALUES (?1)').bind(
				JSON.stringify({
					Type: 1,
					Accessibility: 1,
					AccessibilityLocked: false,
					ImageName: `p${img.Id}.jpg`,
					Description: null,
					PlayerId: 700,
					TaggedPlayerIds: [],
					RoomId: null,
					PlayerEventId: null,
					CreatedAt: '2026-01-01T00:00:00.000Z',
					CheerCount: 0,
					CommentCount: 0,
					...img,
				})
			)
		await env.DB.batch([
			// Player 700's own photos (newest last so ordering is exercised).
			seed({ Id: 201, PlayerId: 700, CreatedAt: '2026-03-01T00:00:00.000Z' }),
			seed({ Id: 202, PlayerId: 700, CreatedAt: '2026-04-01T00:00:00.000Z' }),
			seed({ Id: 203, PlayerId: 700, Accessibility: 0 }), // private → hidden
			// Taken by someone else, but player 700 is tagged in it → feed only.
			seed({
				Id: 204,
				PlayerId: 999,
				TaggedPlayerIds: [700],
				CreatedAt: '2026-05-01T00:00:00.000Z',
			}),
			// Unrelated to 700 → in neither.
			seed({ Id: 205, PlayerId: 999, TaggedPlayerIds: [111] }),
		])

		// v4/player → only photos 700 *took*, public, newest first.
		const mine = (await (
			await exports.default.fetch(`${ORIGIN}/api/images/v4/player/700`)
		).json()) as SavedImage[]
		expect(mine.map((i) => i.Id)).toEqual([202, 201])

		// take paginates.
		const one = (await (
			await exports.default.fetch(`${ORIGIN}/api/images/v4/player/700?take=1`)
		).json()) as SavedImage[]
		expect(one.map((i) => i.Id)).toEqual([202])

		// v3/feed/player → photos taken *or* tagged in, newest first (204 is newest).
		const feed = (await (
			await exports.default.fetch(`${ORIGIN}/api/images/v3/feed/player/700?take=100`)
		).json()) as SavedImage[]
		expect(feed.map((i) => i.Id)).toEqual([204, 202, 201])

		// A player with no photos → empty array on both.
		expect(
			await (await exports.default.fetch(`${ORIGIN}/api/images/v4/player/424242`)).json()
		).toEqual([])
		expect(
			await (await exports.default.fetch(`${ORIGIN}/api/images/v3/feed/player/424242`)).json()
		).toEqual([])
	})
})

describe('relationships', () => {
	// RelationshipType: 0 None, 1 FriendRequestSent, 2 FriendRequestReceived, 3 Friend.
	type Rel = { PlayerID: number; RelationshipType: number; Favorited: number }

	// Call a relationship mutation as `sub`, targeting `playerId` — the real client
	// shape: a GET with the target in `?id=`.
	async function mutate(path: string, sub: string, playerId: number) {
		return exports.default.fetch(`${ORIGIN}${path}?id=${playerId}`, {
			headers: await bearer(sub),
		})
	}

	// Fetch `sub`'s relationships, projected from their point of view.
	async function relationships(sub: string): Promise<Rel[]> {
		const res = await exports.default.fetch(`${ORIGIN}/api/relationships/v2/get`, {
			headers: await bearer(sub),
		})
		return (await res.json()) as Rel[]
	}

	test('GET /api/relationships/v2/get is auth-gated', async () => {
		expect((await exports.default.fetch(`${ORIGIN}/api/relationships/v2/get`)).status).toBe(401)
	})

	test('mutations are auth-gated', async () => {
		for (const path of [
			'/api/relationships/v2/sendfriendrequest',
			'/api/relationships/v2/acceptfriendrequest',
			'/api/relationships/v2/removefriend',
			'/api/relationships/v2/addfriend',
			'/api/relationships/v1/ignore',
			'/api/relationships/v1/mute',
		]) {
			const res = await exports.default.fetch(`${ORIGIN}${path}?id=1`)
			expect(res.status).toBe(401)
		}
	})

	test('send → the two sides see Sent / Received; accept → both Friend; remove → gone', async () => {
		// 500 sends 501 a request.
		const sent = (await (await mutate('/api/relationships/v2/sendfriendrequest', '500', 501)).json()) as Rel
		expect(sent).toMatchObject({ PlayerID: 501, RelationshipType: 1 })

		// 500 sees it as Sent (1); 501 sees the mirror as Received (2).
		expect(await relationships('500')).toEqual([{ PlayerID: 501, RelationshipType: 1, Favorited: 0, Ignored: 0, Muted: 0 }])
		expect(await relationships('501')).toEqual([{ PlayerID: 500, RelationshipType: 2, Favorited: 0, Ignored: 0, Muted: 0 }])

		// 501 accepts → both are Friends (3).
		const accepted = (await (await mutate('/api/relationships/v2/acceptfriendrequest', '501', 500)).json()) as Rel
		expect(accepted).toMatchObject({ PlayerID: 500, RelationshipType: 3 })
		expect(await relationships('500')).toEqual([{ PlayerID: 501, RelationshipType: 3, Favorited: 0, Ignored: 0, Muted: 0 }])
		expect(await relationships('501')).toEqual([{ PlayerID: 500, RelationshipType: 3, Favorited: 0, Ignored: 0, Muted: 0 }])

		// 500 removes → neither side has a relationship.
		expect((await mutate('/api/relationships/v2/removefriend', '500', 501)).status).toBe(200)
		expect(await relationships('500')).toEqual([])
		expect(await relationships('501')).toEqual([])
	})

	test('addfriend makes them friends directly', async () => {
		const res = (await (await mutate('/api/relationships/v2/addfriend', '510', 511)).json()) as Rel
		expect(res).toMatchObject({ PlayerID: 511, RelationshipType: 3 })
		expect(await relationships('511')).toEqual([{ PlayerID: 510, RelationshipType: 3, Favorited: 0, Ignored: 0, Muted: 0 }])
	})

	test('crossing friend requests become a friendship', async () => {
		await mutate('/api/relationships/v2/sendfriendrequest', '520', 521)
		// 521 sends back to 520 → the crossing requests resolve to Friend for both.
		const crossed = (await (await mutate('/api/relationships/v2/sendfriendrequest', '521', 520)).json()) as Rel
		expect(crossed).toMatchObject({ PlayerID: 520, RelationshipType: 3 })
		expect(await relationships('520')).toEqual([{ PlayerID: 521, RelationshipType: 3, Favorited: 0, Ignored: 0, Muted: 0 }])
	})

	test('a self-targeted request is rejected', async () => {
		expect((await mutate('/api/relationships/v2/sendfriendrequest', '530', 530)).status).toBe(400)
	})

	test('v1 ignore/mute set the caller’s own side of the relationship', async () => {
		type FullRel = { PlayerID: number; RelationshipType: number; Ignored: number; Muted: number }
		// POST the real client shape: form body `PlayerId=<id>`.
		const flag = async (path: string, sub: string, playerId: number) =>
			(await (
				await exports.default.fetch(`${ORIGIN}${path}`, {
					method: 'POST',
					headers: {
						...(await bearer(sub)),
						'Content-Type': 'application/x-www-form-urlencoded',
					},
					body: `PlayerId=${playerId}`,
				})
			).json()) as FullRel

		// 700 ignores 701 with no prior relationship → a bare None row, the caller's side flagged.
		expect(await flag('/api/relationships/v1/ignore', '700', 701)).toMatchObject({
			PlayerID: 701,
			RelationshipType: 0,
			Ignored: 1,
			Muted: 0,
		})
		// 700 then mutes 701 → same row, mute added, the earlier ignore preserved.
		expect(await flag('/api/relationships/v1/mute', '700', 701)).toMatchObject({
			PlayerID: 701,
			Ignored: 1,
			Muted: 1,
		})

		// The tricky case: the caller is the row's TARGET. 710 sends 711 a request
		// (710 = requester); 711 ignoring 710 must flag the target side, not the requester's.
		await mutate('/api/relationships/v2/sendfriendrequest', '710', 711)
		expect(await flag('/api/relationships/v1/ignore', '711', 710)).toMatchObject({
			PlayerID: 710,
			RelationshipType: 2, // 711 sees 710's request as Received
			Ignored: 1,
		})
		// 710's own side is untouched — the requester never ignored anyone.
		const view710 = (await relationships('710')) as unknown as FullRel[]
		expect(view710).toEqual([expect.objectContaining({ PlayerID: 711, RelationshipType: 1, Ignored: 0 })])
	})
})
