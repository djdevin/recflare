import { env } from 'cloudflare:test'
import { exports } from 'cloudflare:workers'
import { beforeAll, describe, expect, test } from 'vitest'

import '../../match.app'

import type { Env } from '../../context'

declare module 'cloudflare:test' {
	interface ProvidedEnv extends Env {}
}

const ORIGIN = 'https://match.rec.djdevin.net'

// Matchmaking into a room resolves its real scene from the shared rec-rooms D1.
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
]

beforeAll(async () => {
	await env.DB.prepare(
		`CREATE TABLE IF NOT EXISTS rooms (
			data TEXT NOT NULL,
			room_id INTEGER GENERATED ALWAYS AS (json_extract(data, '$.RoomId')) VIRTUAL,
			name_lower TEXT GENERATED ALWAYS AS (lower(json_extract(data, '$.Name'))) VIRTUAL
		)`
	).run()
	const insert = env.DB.prepare('INSERT OR IGNORE INTO rooms (data) VALUES (?1)')
	await env.DB.batch(TEST_ROOMS.map((r) => insert.bind(JSON.stringify(r))))
})

// Mint a token the way the `auth` worker does, using the same dev secret, so the
// match worker's validation accepts it. Kept inline to avoid a cross-package
// import.
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

	test('POST /goto/room/dormroom returns the dorm instance', async () => {
		const res = await exports.default.fetch(`${ORIGIN}/goto/room/dormroom`, {
			method: 'POST',
			headers: await bearer(),
		})
		expect(res.status).toBe(200)
		const body = (await res.json()) as {
			errorCode: number
			roomInstance: { name: string; location: string; isPrivate: boolean; roomId: number }
		}
		expect(body.errorCode).toBe(0)
		expect(body.roomInstance).toMatchObject({
			name: '^DormRoom',
			location: '76d98498-60a1-430c-ab76-b54a29b7a163',
			isPrivate: true,
			roomId: 1,
		})
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
			// Must differ from the dorm's instance id (1) so the client treats this
			// as a new room and actually loads the scene.
			roomInstanceId: 2,
			name: '^RecCenter',
			location: RECCENTER_SCENE,
			isPrivate: true,
		})
		// Private instances get a unique Photon room id; public share `rec.<roomId>`.
		expect(body.roomInstance.photonRoomId.startsWith('rec.2')).toBe(true)
	})

	test('POST /matchmake/:room 401s without a token', async () => {
		const res = await exports.default.fetch(`${ORIGIN}/matchmake/dorm`, { method: 'POST' })
		expect(res.status).toBe(401)
	})

	test('POST /matchmake/dorm returns the dorm instance', async () => {
		const res = await exports.default.fetch(`${ORIGIN}/matchmake/dorm`, {
			method: 'POST',
			headers: await bearer(),
		})
		expect(res.status).toBe(200)
		const body = (await res.json()) as {
			errorCode: number
			roomInstance: { name: string; location: string; isPrivate: boolean; roomId: number }
		}
		expect(body.errorCode).toBe(0)
		expect(body.roomInstance).toMatchObject({
			name: '^DormRoom',
			location: '76d98498-60a1-430c-ab76-b54a29b7a163',
			isPrivate: true,
			roomId: 1,
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
		).json()) as { statusVisibility: number; platform: number; appVersion: string; isOnline: boolean }
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
		expect(hb.roomInstance?.name).toBe('^DormRoom')
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
})
