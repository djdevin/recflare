import { adminSecretsStore, env } from 'cloudflare:test'
import { exports } from 'cloudflare:workers'
import { beforeAll, describe, expect, test } from 'vitest'

import { ROOM_INSTANCE_SCHEMA_DDL } from '@repo/domain'

import '../../match.app'

import type { Env } from '../../context'

declare module 'cloudflare:test' {
	interface ProvidedEnv extends Env {}
}

const ORIGIN = 'https://example.com'

// Matchmaking into a room resolves its real scene from the shared recflare D1.
// Seed the schema + a couple of rooms (matching the rooms worker's migration).
const RECCENTER_SCENE = 'cbad71af-0831-44d8-b8ef-69edafa841f6'
const TEST_ROOMS = [
	{
		RoomId: 1,
		Name: 'DormRoom',
		IsDorm: true,
		Accessibility: 2,
		SubRooms: [{ SubRoomId: 1, UnitySceneId: '76d98498-60a1-430c-ab76-b54a29b7a163' }],
	},
	{
		RoomId: 2,
		Name: 'RecCenter',
		IsDorm: false,
		Accessibility: 1,
		SubRooms: [{ SubRoomId: 2, UnitySceneId: RECCENTER_SCENE, MaxPlayers: 12 }],
	},
	{
		RoomId: 3,
		Name: 'TestersRoom',
		IsDorm: false,
		Accessibility: 1,
		CreatorAccountId: 42,
		SubRooms: [{ SubRoomId: 3, UnitySceneId: RECCENTER_SCENE, MaxPlayers: 8 }],
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
			creator_account_id INTEGER GENERATED ALWAYS AS (json_extract(data, '$.CreatorAccountId')) VIRTUAL,
			is_dorm INTEGER GENERATED ALWAYS AS (json_extract(data, '$.IsDorm')) VIRTUAL
		)`
	).run()
	const insert = env.DB.prepare('INSERT OR IGNORE INTO room (data) VALUES (?1)')
	await env.DB.batch(TEST_ROOMS.map((r) => insert.bind(JSON.stringify(r))))
	// Room instances (owned by the rooms worker) — matchmaking finds/creates here.
	for (const stmt of ROOM_INSTANCE_SCHEMA_DDL) await env.DB.prepare(stmt).run()

	// Accounts table (owned by the auth worker) — dorm creation reads the username
	// to name the room. Seed the players the dorm tests authenticate as.
	await env.DB.prepare(
		`CREATE TABLE IF NOT EXISTS account (
			data TEXT NOT NULL,
			account_id INTEGER GENERATED ALWAYS AS (json_extract(data, '$.accountId')) VIRTUAL
		)`
	).run()
	const insertAccount = env.DB.prepare('INSERT OR IGNORE INTO account (data) VALUES (?1)')
	await env.DB.batch([
		insertAccount.bind(JSON.stringify({ accountId: 42, username: 'Tester' })),
		insertAccount.bind(JSON.stringify({ accountId: 43, username: 'Roomie' })),
	])
})

// Mint a token the way the `auth` worker does, signing with the shared test key seeded into the JWT_SECRET store, so the
// match worker's validation accepts it. Kept inline to avoid a cross-package
// import.
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
	test('POST /player/login returns 200', async () => {
		const res = await exports.default.fetch(`${ORIGIN}/player/login`, { method: 'POST' })
		expect(res.status).toBe(200)
	})

	test('POST /player/exclusivelogin returns { errorCode: 0 }', async () => {
		const res = await exports.default.fetch(`${ORIGIN}/player/exclusivelogin`, { method: 'POST' })
		expect(res.status).toBe(200)
		expect(await res.json()).toEqual({ errorCode: 0 })
	})

	test('GET /player?id=N synthesizes a player payload for that id', async () => {
		const res = await exports.default.fetch(`${ORIGIN}/player?id=99`)
		expect(res.status).toBe(200)
		const players = (await res.json()) as Array<{
			playerId: number
			isOnline: boolean
			appVersion: string
			roomInstance: unknown
		}>
		expect(players[0]).toMatchObject({
			playerId: 99,
			isOnline: false,
			appVersion: '20230302',
			roomInstance: null,
		})
	})

	test('GET /player without an id returns the default payload', async () => {
		const res = await exports.default.fetch(`${ORIGIN}/player`)
		expect(res.status).toBe(200)
		const players = (await res.json()) as Array<{ playerId: number; isOnline: boolean }>
		expect(players[0]).toMatchObject({ playerId: 1, isOnline: true, appVersion: '20230302' })
	})

	test('POST /goto/none returns the offline dorm', async () => {
		const res = await exports.default.fetch(`${ORIGIN}/goto/none`, { method: 'POST' })
		expect(res.status).toBe(200)
		const body = (await res.json()) as {
			errorCode: number
			roomInstance: { name: string; location: string; photonRoomId: string }
		}
		expect(body.errorCode).toBe(0)
		expect(body.roomInstance).toMatchObject({
			name: '^DormRoom',
			location: '76d98498-60a1-430c-ab76-b54a29b7a163',
			isPrivate: true,
		})
		expect(body.roomInstance.photonRoomId).toMatch(/^[0-9a-f-]{36}$/)
	})

	test('POST /matchmake/room/:roomId resolves the room scene from D1', async () => {
		const headers = await bearer('88')
		const res = await exports.default.fetch(`${ORIGIN}/matchmake/room/2`, {
			method: 'POST',
			headers: { ...headers, 'Content-Type': 'application/x-www-form-urlencoded' },
			body: new URLSearchParams({ JoinMode: '2' }).toString(),
		})
		expect(res.status).toBe(200)
		const body = (await res.json()) as {
			errorCode: number
			roomInstance: { roomId: number; location: string; isPrivate: boolean; name: string }
		}
		expect(body.errorCode).toBe(0)
		expect(body.roomInstance).toMatchObject({
			roomId: 2,
			name: '^RecCenter',
			location: RECCENTER_SCENE,
			isPrivate: true,
		})
	})

	test('POST /matchmake/room/:roomId returns NoSuchRoom for an unknown room', async () => {
		const res = await exports.default.fetch(`${ORIGIN}/matchmake/room/99999`, {
			method: 'POST',
			headers: await bearer('88'),
		})
		expect(res.status).toBe(200)
		expect(await res.json()).toEqual({ errorCode: 20, roomInstance: null })
	})

	test('POST /matchmake/none returns the offline dorm when the player has no presence', async () => {
		const res = await exports.default.fetch(`${ORIGIN}/matchmake/none`, { method: 'POST' })
		expect(res.status).toBe(200)
		const body = (await res.json()) as {
			errorCode: number
			roomInstance: { name: string; location: string; isPrivate: boolean; photonRoomId: string }
		}
		expect(body.errorCode).toBe(0)
		expect(body.roomInstance).toMatchObject({
			name: '^DormRoom',
			location: '76d98498-60a1-430c-ab76-b54a29b7a163',
			isPrivate: true,
		})
		expect(body.roomInstance.photonRoomId).toMatch(/^[0-9a-f-]{36}$/)
	})

	test('POST /matchmake/none preserves an existing presence (does not warp to the dorm)', async () => {
		const auth = await bearer('314')
		// Put the player in a room first (RecCenter), establishing presence.
		await exports.default.fetch(`${ORIGIN}/matchmake/2`, { method: 'POST', headers: auth })
		// matchmake/none must return that same room, not force the dorm — this is
		// what keeps a new player in the solo Orientation room.
		const res = await exports.default.fetch(`${ORIGIN}/matchmake/none`, {
			method: 'POST',
			headers: auth,
		})
		expect(res.status).toBe(200)
		const body = (await res.json()) as {
			errorCode: number
			roomInstance: { roomId: number; name: string; location: string }
		}
		expect(body.errorCode).toBe(0)
		expect(body.roomInstance).toMatchObject({
			roomId: 2,
			name: '^RecCenter',
			location: RECCENTER_SCENE,
		})
	})

	test('PUT /player/statusvisibility returns 200', async () => {
		const res = await exports.default.fetch(`${ORIGIN}/player/statusvisibility`, { method: 'PUT' })
		expect(res.status).toBe(200)
	})

	test('PUT /player/photonregionpings returns 200', async () => {
		const res = await exports.default.fetch(`${ORIGIN}/player/photonregionpings`, { method: 'PUT' })
		expect(res.status).toBe(200)
	})

	test('POST /roominstance/:id/reportjoinresult returns 200', async () => {
		const res = await exports.default.fetch(`${ORIGIN}/roominstance/5/reportjoinresult`, {
			method: 'POST',
		})
		expect(res.status).toBe(200)
	})
})

describe('auth-gated endpoints', () => {
	test('POST /goto/room/:room 401s without a token', async () => {
		const res = await exports.default.fetch(`${ORIGIN}/goto/room/dormroom`, { method: 'POST' })
		expect(res.status).toBe(401)
	})

	test('POST /goto/room/dormroom creates and returns the player’s personal dorm', async () => {
		const res = await exports.default.fetch(`${ORIGIN}/goto/room/dormroom`, {
			method: 'POST',
			headers: await bearer('42'),
		})
		expect(res.status).toBe(200)
		const body = (await res.json()) as {
			errorCode: number
			roomInstance: {
				name: string
				location: string
				isPrivate: boolean
				roomId: number
				photonRoomId: string
			}
		}
		expect(body.errorCode).toBe(0)
		expect(body.roomInstance).toMatchObject({
			// Named after the owner: `@<username>'s Dorm` (no `^` — the `@` is its prefix).
			name: "@Tester's Dorm",
			location: '76d98498-60a1-430c-ab76-b54a29b7a163',
			isPrivate: true,
		})
		// The dorm gets its own unique Photon room id (isolated from other dorms).
		expect(body.roomInstance.photonRoomId).toMatch(/^[0-9a-f-]{36}$/)
		// A personal dorm room was created (not the seeded template RoomId 1)…
		const roomId = body.roomInstance.roomId
		expect(roomId).toBeGreaterThan(2)
		// …owned by the player and flagged IsDorm so they can save it.
		const row = await env.DB.prepare('SELECT data FROM room WHERE room_id = ?1')
			.bind(roomId)
			.first<{ data: string }>()
		expect(JSON.parse(row!.data)).toMatchObject({ CreatorAccountId: 42, IsDorm: true })
	})

	test('POST /goto/room/:id resolves a real room scene from D1', async () => {
		const res = await exports.default.fetch(`${ORIGIN}/goto/room/2`, {
			method: 'POST',
			headers: { ...(await bearer()), 'Content-Type': 'application/x-www-form-urlencoded' },
			body: new URLSearchParams({ JoinMode: '2' }).toString(),
		})
		expect(res.status).toBe(200)
		const body = (await res.json()) as {
			roomInstance: {
				roomId: number
				roomInstanceId: number
				isPrivate: boolean
				name: string
				location: string
				photonRoomId: string
			}
		}
		expect(body.roomInstance).toMatchObject({
			roomId: 2,
			name: '^RecCenter',
			location: RECCENTER_SCENE,
			isPrivate: true,
		})
		// The instance id is the room_instance table id (high-based, so it never
		// collides with the dorm's fixed instance id of 1).
		expect(body.roomInstance.roomInstanceId).toBeGreaterThan(1)
		// Every non-dorm instance gets a fresh random Photon room id (a bare UUID).
		expect(body.roomInstance.photonRoomId).toMatch(/^[0-9a-f-]{36}$/)
	})

	test('POST /matchmake/:room reuses a public instance; a private one is fresh', async () => {
		const matchmake = async (joinMode?: string) =>
			(await (
				await exports.default.fetch(`${ORIGIN}/matchmake/2`, {
					method: 'POST',
					headers: {
						...(await bearer('900')),
						'Content-Type': 'application/x-www-form-urlencoded',
					},
					body: joinMode ? new URLSearchParams({ JoinMode: joinMode }).toString() : undefined,
				})
			).json()) as { roomInstance: { photonRoomId: string; roomInstanceId: number } }

		// Two public matchmakes into the same room share the (reused) instance.
		const a = await matchmake()
		const b = await matchmake()
		expect(a.roomInstance.photonRoomId).toMatch(/^[0-9a-f-]{36}$/)
		expect(b.roomInstance.photonRoomId).toBe(a.roomInstance.photonRoomId)
		expect(b.roomInstance.roomInstanceId).toBe(a.roomInstance.roomInstanceId)

		// A private matchmake (JoinMode 2) gets its own distinct instance.
		const priv = await matchmake('2')
		expect(priv.roomInstance.photonRoomId).not.toBe(a.roomInstance.photonRoomId)
	})

	test('POST /matchmake/:room 401s without a token', async () => {
		const res = await exports.default.fetch(`${ORIGIN}/matchmake/dorm`, { method: 'POST' })
		expect(res.status).toBe(401)
	})

	test('POST /matchmake/dorm returns the same personal dorm (idempotent)', async () => {
		// First entry (fresh account 43) creates the dorm; a second returns the same one.
		const first = (await (
			await exports.default.fetch(`${ORIGIN}/matchmake/dorm`, {
				method: 'POST',
				headers: await bearer('43'),
			})
		).json()) as { roomInstance: { roomId: number; photonRoomId: string; roomInstanceId: number } }
		expect(first.roomInstance.roomId).toBeGreaterThan(2)

		const res = await exports.default.fetch(`${ORIGIN}/matchmake/dorm`, {
			method: 'POST',
			headers: await bearer('43'),
		})
		expect(res.status).toBe(200)
		const body = (await res.json()) as {
			errorCode: number
			roomInstance: {
				name: string
				location: string
				isPrivate: boolean
				roomId: number
				photonRoomId: string
				roomInstanceId: number
			}
		}
		expect(body.errorCode).toBe(0)
		expect(body.roomInstance).toMatchObject({
			name: "@Roomie's Dorm",
			location: '76d98498-60a1-430c-ab76-b54a29b7a163',
			isPrivate: true,
			// Same dorm room + reused instance (stable id + Photon room), not a new one.
			roomId: first.roomInstance.roomId,
			photonRoomId: first.roomInstance.photonRoomId,
			roomInstanceId: first.roomInstance.roomInstanceId,
		})
	})

	test('POST /matchmake/:room resolves a room by name from D1', async () => {
		const res = await exports.default.fetch(`${ORIGIN}/matchmake/RecCenter`, {
			method: 'POST',
			headers: { ...(await bearer()), 'Content-Type': 'application/x-www-form-urlencoded' },
			body: new URLSearchParams({ JoinMode: '2' }).toString(),
		})
		expect(res.status).toBe(200)
		const body = (await res.json()) as {
			roomInstance: { roomId: number; name: string; location: string; isPrivate: boolean }
		}
		expect(body.roomInstance).toMatchObject({
			roomId: 2,
			name: '^RecCenter',
			location: RECCENTER_SCENE,
			isPrivate: true,
		})
	})

	test('POST /player/heartbeat 401s without a token', async () => {
		const res = await exports.default.fetch(`${ORIGIN}/player/heartbeat`, { method: 'POST' })
		expect(res.status).toBe(401)
	})

	test('POST /player/heartbeat reports no presence before matchmake', async () => {
		// Fresh token (sub 7) with no stored presence → not in a room.
		const res = await exports.default.fetch(`${ORIGIN}/player/heartbeat`, {
			method: 'POST',
			headers: { ...(await bearer('7')), 'Content-Type': 'application/json' },
			body: JSON.stringify({ statusVisibility: 2, platform: 5 }),
		})
		expect(res.status).toBe(200)
		expect(await res.json()).toMatchObject({
			playerId: 7,
			roomInstance: null,
			isOnline: false,
		})
	})

	test('matchmake then heartbeat replays the stored instance (in sync)', async () => {
		const headers = await bearer()
		const mm = (await (
			await exports.default.fetch(`${ORIGIN}/matchmake/dorm`, { method: 'POST', headers })
		).json()) as { roomInstance: Record<string, unknown> }
		// LoginLock form heartbeat (no presence fields) still gets the stored room.
		const hb = (await (
			await exports.default.fetch(`${ORIGIN}/player/heartbeat`, {
				method: 'POST',
				headers: { ...headers, 'Content-Type': 'application/x-www-form-urlencoded' },
				body: 'LoginLock=abc',
			})
		).json()) as { roomInstance: Record<string, unknown>; isOnline: boolean }
		expect(hb.isOnline).toBe(true)
		expect(hb.roomInstance).toEqual(mm.roomInstance)
	})

	test('heartbeat merges posted status fields into stored presence', async () => {
		const headers = await bearer('8')
		await exports.default.fetch(`${ORIGIN}/matchmake/dorm`, { method: 'POST', headers })
		const hb = (await (
			await exports.default.fetch(`${ORIGIN}/player/heartbeat`, {
				method: 'POST',
				headers: { ...headers, 'Content-Type': 'application/json' },
				body: JSON.stringify({ statusVisibility: 2, platform: 5, appVersion: '20210129' }),
			})
		).json()) as {
			statusVisibility: number
			platform: number
			appVersion: string
			isOnline: boolean
		}
		expect(hb).toMatchObject({
			statusVisibility: 2,
			platform: 5,
			appVersion: '20210129',
			isOnline: true,
		})
	})

	test('player/login, exclusivelogin and logout all preserve presence', async () => {
		const headers = await bearer('9')
		await exports.default.fetch(`${ORIGIN}/matchmake/dorm`, { method: 'POST', headers })
		// None of these lifecycle calls may wipe presence — the client fires a
		// spurious logout during the account-creation bootstrap, and exclusivelogin
		// when going online. Clearing here would bounce the player to the dorm.
		await exports.default.fetch(`${ORIGIN}/player/logout`, { method: 'POST', headers })
		await exports.default.fetch(`${ORIGIN}/player/exclusivelogin`, { method: 'POST', headers })
		await exports.default.fetch(`${ORIGIN}/player/login`, { method: 'POST', headers })
		const hb = (await (
			await exports.default.fetch(`${ORIGIN}/player/heartbeat`, { method: 'POST', headers })
		).json()) as { roomInstance: { name: string } | null; isOnline: boolean }
		expect(hb.isOnline).toBe(true)
		// Presence is preserved: the heartbeat replays their personal dorm. Account 9
		// has no seeded username, so the name falls back to `@Player9's Dorm`.
		expect(hb.roomInstance?.name).toBe("@Player9's Dorm")
	})

	test('GET /player?id reports stored presence per id', async () => {
		await exports.default.fetch(`${ORIGIN}/matchmake/dorm`, {
			method: 'POST',
			headers: await bearer('55'),
		})
		const res = await exports.default.fetch(`${ORIGIN}/player?id=55`)
		expect(res.status).toBe(200)
		const players = (await res.json()) as Array<{ playerId: number; isOnline: boolean }>
		expect(players[0]).toMatchObject({ playerId: 55, isOnline: true })
	})

	test('GET /room/:id/instances is auth-gated, owner-only, and lists the room’s instances', async () => {
		// No token → 401.
		expect(
			(await exports.default.fetch(`${ORIGIN}/room/3/instances`)).status
		).toBe(401)

		// Not the owner (room 3 is owned by account 42) → 403.
		expect(
			(
				await exports.default.fetch(`${ORIGIN}/room/3/instances`, {
					headers: await bearer('999'),
				})
			).status
		).toBe(403)

		// Unknown room → 404.
		expect(
			(
				await exports.default.fetch(`${ORIGIN}/room/99999/instances`, {
					headers: await bearer('42'),
				})
			).status
		).toBe(404)

		// Matchmaking into room 3 creates an instance the owner can then see.
		await exports.default.fetch(`${ORIGIN}/matchmake/room/3`, {
			method: 'POST',
			headers: await bearer('42'),
		})
		const res = await exports.default.fetch(`${ORIGIN}/room/3/instances`, {
			headers: await bearer('42'),
		})
		expect(res.status).toBe(200)
		const instances = (await res.json()) as Array<{ roomId: number; roomInstanceId: number }>
		expect(instances.length).toBeGreaterThanOrEqual(1)
		expect(instances.every((i) => i.roomId === 3)).toBe(true)
	})
})
