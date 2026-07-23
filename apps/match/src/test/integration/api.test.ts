import {
	adminSecretsStore,
	createExecutionContext,
	createScheduledController,
	env,
	waitOnExecutionContext,
} from 'cloudflare:test'
import { exports } from 'cloudflare:workers'
import { beforeAll, describe, expect, test } from 'vitest'

import {
	countPlayersInInstance,
	GAME_VERSION,
	getRoomInstance,
	PRESENCE_SCHEMA_DDL,
	ROOM_INSTANCE_SCHEMA_DDL,
} from '@repo/domain'

import { scheduled } from '../../match.app'

import type { Env } from '../../context'

declare module 'cloudflare:test' {
	interface ProvidedEnv extends Env {}
}

const ORIGIN = 'https://example.com'

// Matchmaking into a room resolves its real scene from the shared recflare D1.
// Seed the schema + a couple of rooms (matching the rooms worker's migration).
const RECCENTER_SCENE = 'cbad71af-0831-44d8-b8ef-69edafa841f6'
const SECOND_SUBROOM_SCENE = '3f0f6cd0-5c9f-42b2-9c07-2a5a2a1c9f11'
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
		// Account 43 is a co-owner (Role 30) — it may view the room's instances too.
		Roles: [{ AccountId: 43, Role: 30, LastChangedByAccountId: null, InvitedRole: 0 }],
		SubRooms: [{ SubRoomId: 3, UnitySceneId: RECCENTER_SCENE, MaxPlayers: 8 }],
	},
	{
		// A single-seat room so one player fills its instance (fullness tests).
		RoomId: 5,
		Name: 'SoloRoom',
		IsDorm: false,
		Accessibility: 1,
		SubRooms: [{ SubRoomId: 5, UnitySceneId: RECCENTER_SCENE, MaxPlayers: 1 }],
	},
	{
		// Two subrooms (separate scenes) — matchmaking into one must not land you in
		// the other.
		RoomId: 77,
		Name: 'MultiRoom',
		IsDorm: false,
		Accessibility: 1,
		SubRooms: [
			{ SubRoomId: 34, UnitySceneId: RECCENTER_SCENE, MaxPlayers: 10 },
			{ SubRoomId: 35, UnitySceneId: SECOND_SUBROOM_SCENE, MaxPlayers: 6 },
		],
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
	// Presence table (owned by the rooms worker) — written/read by matchmake + heartbeat.
	for (const stmt of PRESENCE_SCHEMA_DDL) await env.DB.prepare(stmt).run()

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

	// Club tables (owned by the clubs worker) — matchmake/club reads the clubhouse
	// room and the caller's membership from them.
	await env.DB.prepare(
		`CREATE TABLE IF NOT EXISTS club (
			data TEXT NOT NULL,
			club_id INTEGER GENERATED ALWAYS AS (json_extract(data, '$.ClubId')) VIRTUAL
		)`
	).run()
	await env.DB.prepare(
		`CREATE TABLE IF NOT EXISTS club_member (
			club_member_id INTEGER PRIMARY KEY AUTOINCREMENT,
			club_id INTEGER NOT NULL,
			account_id INTEGER NOT NULL,
			membership_type INTEGER NOT NULL DEFAULT 0,
			created_at TEXT
		)`
	).run()
	const insertClub = env.DB.prepare('INSERT OR IGNORE INTO club (data) VALUES (?1)')
	await env.DB.batch([
		// Club 4 has room 2 as its clubhouse; club 5 has none set.
		insertClub.bind(JSON.stringify({ ClubId: 4, Name: 'Clubbers', ClubhouseRoomId: 2 })),
		insertClub.bind(JSON.stringify({ ClubId: 5, Name: 'Homeless', ClubhouseRoomId: null })),
	])
	const insertMember = env.DB.prepare(
		'INSERT INTO club_member (club_id, account_id, membership_type) VALUES (?1, ?2, ?3)'
	)
	await env.DB.batch([
		insertMember.bind(4, 120, 100), // creator
		insertMember.bind(4, 121, 10), // member
		insertMember.bind(4, 122, 1), // pending request — not a member yet
		insertMember.bind(4, 123, -1), // banned
		insertMember.bind(5, 120, 100),
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

	test('POST /player/notifydisconnect returns 200', async () => {
		const res = await exports.default.fetch(`${ORIGIN}/player/notifydisconnect`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
			body: 'PlayerId=155&RoomInstanceId=1000001',
		})
		expect(res.status).toBe(200)
	})

	test('GET /player?id=N synthesizes a player payload for that id', async () => {
		const res = await exports.default.fetch(`${ORIGIN}/player?id=99`)
		expect(res.status).toBe(200)
		// The full presence shape the client deserializes — including the connection
		// fields, which only ever carry values in a matchmaking response.
		expect(await res.json()).toEqual([
			{
				appVersion: GAME_VERSION,
				deviceClass: 0,
				errorCode: 0,
				isOnline: false,
				playerId: 99,
				roomInstance: null,
				statusVisibility: 0,
				vrMovementMode: 1,
				platform: 0,
				photonAuthToken: null,
				photonRealtimeAppId: null,
				photonVoiceAppId: null,
				photonChatAppId: null,
				photonRegion: null,
				photonRoomId: null,
				voiceConnectionInfo: null,
				voiceServerId: null,
				experiments: null,
			},
		])
	})

	test('GET /player?id=&id= returns one payload per id, in order', async () => {
		const res = await exports.default.fetch(`${ORIGIN}/player?id=1070&id=1380`)
		const players = (await res.json()) as Array<{ playerId: number; isOnline: boolean }>
		expect(players.map((p) => p.playerId)).toEqual([1070, 1380])
		// Neither has presence → both offline.
		expect(players.every((p) => p.isOnline === false)).toBe(true)
	})

	test('GET /player without an id returns the default payload', async () => {
		const res = await exports.default.fetch(`${ORIGIN}/player`)
		expect(res.status).toBe(200)
		const players = (await res.json()) as Array<{ playerId: number; isOnline: boolean }>
		expect(players[0]).toMatchObject({ playerId: 1, isOnline: true, appVersion: GAME_VERSION })
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

	test('POST /matchmake/room/:roomId seeds presence with the account device class', async () => {
		// A screen player (deviceClass 2, recorded by auth at login) matchmaking with no
		// live presence: without the account fallback they'd enter the room as deviceClass
		// 0 (VR) until their next heartbeat, and everyone in the room would see that.
		await env.DB.prepare('INSERT OR IGNORE INTO account (data) VALUES (?1)')
			.bind(JSON.stringify({ accountId: 55, username: 'Screenie', deviceClass: 2, platform: 0 }))
			.run()
		const headers = await bearer('55')
		const res = await exports.default.fetch(`${ORIGIN}/matchmake/room/2`, {
			method: 'POST',
			headers: { ...headers, 'Content-Type': 'application/x-www-form-urlencoded' },
			body: new URLSearchParams({ JoinMode: '2' }).toString(),
		})
		expect(res.status).toBe(200)

		const row = await env.DB.prepare('SELECT data FROM presence WHERE account_id = ?1')
			.bind(55)
			.first<{ data: string }>()
		const presence = JSON.parse(row!.data) as { deviceClass: number }
		expect(presence.deviceClass).toBe(2)
	})

	test('POST /matchmake/room/:roomId/:subRoomId enters that subroom', async () => {
		type Instance = {
			roomId: number
			subRoomId: number
			location: string
			maxCapacity: number
			roomInstanceId: number
		}
		const matchmake = async (path: string, sub: string): Promise<Instance> => {
			const res = await exports.default.fetch(`${ORIGIN}${path}`, {
				method: 'POST',
				headers: {
					...(await bearer(sub)),
					'Content-Type': 'application/x-www-form-urlencoded',
				},
				// The client's real body: JoinMode 0 (public) plus flags we ignore.
				body: 'BypassMovementModeRestriction=True&MaxPersistenceVersion=41&JoinMode=0&ClientJoinData=%7B%22WelcomeMatName%22%3A%22%22%7D&AdditionalPlayersAutoFollow=False',
			})
			expect(res.status).toBe(200)
			const body = (await res.json()) as { errorCode: number; roomInstance: Instance }
			expect(body.errorCode).toBe(0)
			return body.roomInstance
		}

		// Subroom 35 → that subroom's own scene and capacity, not the first subroom's.
		const second = await matchmake('/matchmake/room/77/35', '90')
		expect(second).toMatchObject({
			roomId: 77,
			subRoomId: 35,
			location: SECOND_SUBROOM_SCENE,
			maxCapacity: 6,
		})

		// A second player asking for the same subroom joins the same instance...
		const alsoSecond = await matchmake('/matchmake/room/77/35', '91')
		expect(alsoSecond.roomInstanceId).toBe(second.roomInstanceId)

		// ...but the other subroom is a separate place, with its own instance + scene.
		const first = await matchmake('/matchmake/room/77/34', '92')
		expect(first.roomInstanceId).not.toBe(second.roomInstanceId)
		expect(first).toMatchObject({ subRoomId: 34, location: RECCENTER_SCENE, maxCapacity: 10 })

		// An unknown subroom falls back to the room's first (its default entrance).
		const unknown = await matchmake('/matchmake/room/77/999', '93')
		expect(unknown).toMatchObject({ subRoomId: 34, location: RECCENTER_SCENE })
	})

	test('POST /matchmake/club/:clubId places members into the clubhouse', async () => {
		const matchmake = async (path: string, sub?: string) =>
			exports.default.fetch(`${ORIGIN}${path}`, {
				method: 'POST',
				headers: {
					...(sub === undefined ? {} : await bearer(sub)),
					'Content-Type': 'application/x-www-form-urlencoded',
				},
				body: 'JoinMode=0',
			})
		type Body = {
			errorCode: number
			roomInstance: { roomId: number; location: string; roomInstanceId: number } | null
		}

		// A member lands in an instance of the club's clubhouse (room 2)...
		const res = await matchmake('/matchmake/club/4', '121')
		expect(res.status).toBe(200)
		const body = (await res.json()) as Body
		expect(body.errorCode).toBe(0)
		expect(body.roomInstance).toMatchObject({ roomId: 2, location: RECCENTER_SCENE })

		// ...and it's recorded as their presence, like any other matchmake.
		const row = await env.DB.prepare('SELECT data FROM presence WHERE account_id = ?1')
			.bind(121)
			.first<{ data: string }>()
		const presence = JSON.parse(row!.data) as { roomInstance: { roomInstanceId: number } }
		expect(presence.roomInstance.roomInstanceId).toBe(body.roomInstance!.roomInstanceId)

		// The creator is a member too, and joins the same public instance.
		const creator = (await (await matchmake('/matchmake/club/4', '120')).json()) as Body
		expect(creator.roomInstance?.roomInstanceId).toBe(body.roomInstance!.roomInstanceId)

		// Everyone who isn't a member is turned away with the same answer: a non-member,
		// a pending request, a banned account, a club with no clubhouse, an unknown club.
		for (const [path, sub] of [
			['/matchmake/club/4', '199'],
			['/matchmake/club/4', '122'],
			['/matchmake/club/4', '123'],
			['/matchmake/club/5', '120'],
			['/matchmake/club/9999', '120'],
		] as const) {
			expect(await (await matchmake(path, sub)).json()).toEqual({
				errorCode: 20,
				roomInstance: null,
			})
		}

		// Signed out is a 401, not a matchmaking error.
		expect((await matchmake('/matchmake/club/4')).status).toBe(401)
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

	test('POST /matchmake/:room reuses a public instance across players; a private one is fresh', async () => {
		const matchmake = async (sub: string, joinMode?: string) =>
			(await (
				await exports.default.fetch(`${ORIGIN}/matchmake/2`, {
					method: 'POST',
					headers: {
						...(await bearer(sub)),
						'Content-Type': 'application/x-www-form-urlencoded',
					},
					body: joinMode ? new URLSearchParams({ JoinMode: joinMode }).toString() : undefined,
				})
			).json()) as { roomInstance: { photonRoomId: string; roomInstanceId: number } }

		// Two *different* players matchmaking into the same room share the reused
		// instance (population grouping). Distinct accounts here, since re-matchmaking as
		// the *same* player deliberately moves them to a fresh instance — see below.
		const a = await matchmake('900')
		const b = await matchmake('901')
		expect(a.roomInstance.photonRoomId).toMatch(/^[0-9a-f-]{36}$/)
		expect(b.roomInstance.photonRoomId).toBe(a.roomInstance.photonRoomId)
		expect(b.roomInstance.roomInstanceId).toBe(a.roomInstance.roomInstanceId)

		// A private matchmake (JoinMode 2) gets its own distinct instance.
		const priv = await matchmake('902', '2')
		expect(priv.roomInstance.photonRoomId).not.toBe(a.roomInstance.photonRoomId)
	})

	test('re-matchmaking into your current room returns a different instance (id must change)', async () => {
		// The client keys the room transition off a changing roomInstanceId; handing back
		// the instance the player is already in hangs their join. RecCenter (cap 12) so
		// the instance isn't full — the naive "reuse the oldest joinable" would otherwise
		// return the same id the player already has.
		const first = await matchmakeInto('2', '950')
		const second = await matchmakeInto('2', '950')
		expect(second).not.toBe(first)
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

	// Seed presence directly into D1 with a chosen `expiresAt` (epoch seconds) so the
	// TTL-refresh branch can be exercised deterministically (independent of timing).
	const seedPresence = (id: number, expiresAt: number) =>
		env.DB.prepare('INSERT OR REPLACE INTO presence (data) VALUES (?1)')
			.bind(
				JSON.stringify({
					accountId: id,
					roomInstance: { roomInstanceId: 1000042, roomId: 1 },
					statusVisibility: 0,
					deviceClass: 0,
					vrMovementMode: 1,
					platform: 0,
					appVersion: GAME_VERSION,
					expiresAt,
				})
			)
			.run()

	const storedExpiresAt = async (id: number): Promise<number> => {
		const row = await env.DB.prepare('SELECT data FROM presence WHERE account_id = ?1')
			.bind(id)
			.first<{ data: string }>()
		return (JSON.parse(row!.data) as { expiresAt: number }).expiresAt
	}

	const nowSeconds = () => Math.floor(Date.now() / 1000)

	/** Rows for an account, expired ones included — the sweep should leave none. */
	const countPresenceRows = async (id: number): Promise<number> => {
		const row = await env.DB.prepare('SELECT COUNT(*) AS n FROM presence WHERE account_id = ?1')
			.bind(id)
			.first<{ n: number }>()
		return row?.n ?? 0
	}

	test('heartbeat refreshes presence when its TTL is close to lapsing', async () => {
		// TTL about to lapse (well inside the refresh window).
		const nearExpiry = nowSeconds() + 10
		await seedPresence(700, nearExpiry)
		await exports.default.fetch(`${ORIGIN}/player/heartbeat`, {
			method: 'POST',
			headers: await bearer('700'),
		})
		// The heartbeat re-wrote the row, pushing expiry ~PRESENCE_TTL_SECONDS ahead.
		expect(await storedExpiresAt(700)).toBeGreaterThan(nearExpiry + 60)
	})

	test('heartbeat skips the write when nothing changed and the TTL is healthy', async () => {
		// A distinctive, far-future expiry (outside the refresh window) survives
		// untouched — proving the unchanged heartbeat did not re-write the row.
		const healthyExpiry = nowSeconds() + 800
		await seedPresence(701, healthyExpiry)
		await exports.default.fetch(`${ORIGIN}/player/heartbeat`, {
			method: 'POST',
			headers: await bearer('701'),
		})
		expect(await storedExpiresAt(701)).toBe(healthyExpiry)
	})

	test('countPlayersInInstance counts live players in a room instance (excludes expired)', async () => {
		// Three players in instance 1000099 — two live, one expired.
		const seedInInstance = (id: number, expiresAt: number) =>
			env.DB.prepare('INSERT OR REPLACE INTO presence (data) VALUES (?1)')
				.bind(
					JSON.stringify({
						accountId: id,
						roomInstance: { roomInstanceId: 1000099, roomId: 2 },
						statusVisibility: 0,
						deviceClass: 0,
						vrMovementMode: 1,
						platform: 0,
						appVersion: GAME_VERSION,
						expiresAt,
					})
				)
				.run()
		await seedInInstance(710, nowSeconds() + 800)
		await seedInInstance(711, nowSeconds() + 800)
		await seedInInstance(712, nowSeconds() - 10) // already expired → not counted
		expect(await countPlayersInInstance(env.DB, 1000099)).toBe(2)
		expect(await countPlayersInInstance(env.DB, 999999)).toBe(0)
	})

	// Matchmake into a room, returning the resulting instance id.
	const matchmakeInto = async (room: string, sub: string): Promise<number> => {
		const res = (await (
			await exports.default.fetch(`${ORIGIN}/matchmake/${room}`, {
				method: 'POST',
				headers: await bearer(sub),
			})
		).json()) as { roomInstance: { roomInstanceId: number } }
		return res.roomInstance.roomInstanceId
	}

	test('matchmaking flags an instance full once it reaches capacity, and routes the next player elsewhere', async () => {
		// SoloRoom (RoomId 5, MaxPlayers 1): one player fills its instance.
		const first = await matchmakeInto('5', '820')
		expect((await getRoomInstance(env.DB, first))?.isFull).toBe(true)
		// A second player can't join the full instance — matchmaking makes a fresh one.
		const second = await matchmakeInto('5', '821')
		expect(second).not.toBe(first)
		expect((await getRoomInstance(env.DB, second))?.isFull).toBe(true)
	})

	test('matchmaking leaves an instance not full below capacity', async () => {
		// RecCenter (RoomId 2, MaxPlayers 12): one player does not fill it.
		const instanceId = await matchmakeInto('2', '822')
		expect((await getRoomInstance(env.DB, instanceId))?.isFull).toBe(false)
	})

	test('leaving a full instance clears its full flag', async () => {
		// Fill SoloRoom, then the same player matchmakes into RecCenter — the SoloRoom
		// instance they left should no longer be full.
		const solo = await matchmakeInto('5', '823')
		expect((await getRoomInstance(env.DB, solo))?.isFull).toBe(true)
		await matchmakeInto('2', '823')
		expect((await getRoomInstance(env.DB, solo))?.isFull).toBe(false)
	})

	test('the cron sweep purges expired presence and frees the instance those players were in', async () => {
		// A player fills SoloRoom, then vanishes without matchmaking out (a crash) —
		// nothing recomputes fullness, so the instance sits full with nobody in it.
		const solo = await matchmakeInto('5', '824')
		expect((await getRoomInstance(env.DB, solo))?.isFull).toBe(true)
		await env.DB.prepare(
			"UPDATE presence SET data = json_set(data, '$.expiresAt', ?2) WHERE account_id = ?1"
		)
			.bind(824, nowSeconds() - 10)
			.run()

		// Driven through the module's own export rather than the `exports` proxy — a
		// ScheduledController can't cross the isolate boundary the proxy serializes over.
		const ctx = createExecutionContext()
		await scheduled(createScheduledController(), env, ctx)
		await waitOnExecutionContext(ctx)

		// Expired row gone, and the instance is joinable again.
		expect(await countPresenceRows(824)).toBe(0)
		expect((await getRoomInstance(env.DB, solo))?.isFull).toBe(false)
	})

	test('player/login and exclusivelogin preserve presence', async () => {
		const headers = await bearer('9')
		await exports.default.fetch(`${ORIGIN}/matchmake/dorm`, { method: 'POST', headers })
		// These acks must not wipe presence — the client fires exclusivelogin when going
		// online, and clearing here would bounce the player to the dorm.
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

	test('player/logout clears presence and frees the instance the player was in', async () => {
		// Fill SoloRoom (cap 1) so its instance is full, then log out.
		const solo = await matchmakeInto('5', '960')
		expect((await getRoomInstance(env.DB, solo))?.isFull).toBe(true)

		const headers = await bearer('960')
		await exports.default.fetch(`${ORIGIN}/player/logout`, { method: 'POST', headers })

		// Presence is gone → the heartbeat reports offline with no room.
		const hb = (await (
			await exports.default.fetch(`${ORIGIN}/player/heartbeat`, { method: 'POST', headers })
		).json()) as { roomInstance: unknown; isOnline: boolean }
		expect(hb.isOnline).toBe(false)
		expect(hb.roomInstance).toBeNull()
		expect(await countPresenceRows(960)).toBe(0)
		// The instance they left is no longer full.
		expect((await getRoomInstance(env.DB, solo))?.isFull).toBe(false)
	})

	test('player/logout preserves a new player still in Orientation (account-creation bootstrap)', async () => {
		// Mirror the auth worker's Orientation seed: presence pointing at instance -2.
		// The client's spurious bootstrap logout must NOT wipe it, or the new player is
		// bounced out of Orientation to the dorm.
		await env.DB.prepare('INSERT OR REPLACE INTO presence (data) VALUES (?1)')
			.bind(
				JSON.stringify({
					accountId: 961,
					roomInstance: { roomInstanceId: -2, roomId: 13, name: '^Orientation' },
					statusVisibility: 0,
					deviceClass: 0,
					vrMovementMode: 1,
					platform: 0,
					appVersion: GAME_VERSION,
					expiresAt: nowSeconds() + 800,
				})
			)
			.run()

		await exports.default.fetch(`${ORIGIN}/player/logout`, {
			method: 'POST',
			headers: await bearer('961'),
		})

		const hb = (await (
			await exports.default.fetch(`${ORIGIN}/player/heartbeat`, {
				method: 'POST',
				headers: await bearer('961'),
			})
		).json()) as { roomInstance: { roomInstanceId: number } | null; isOnline: boolean }
		expect(hb.isOnline).toBe(true)
		expect(hb.roomInstance?.roomInstanceId).toBe(-2)
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

	test('GET /room/:id/instances is auth-gated, owner/co-owner-only, and lists the room’s instances', async () => {
		// No token → 401.
		expect((await exports.default.fetch(`${ORIGIN}/room/3/instances`)).status).toBe(401)

		// A valid token but no role on the room (room 3 is owned by account 42, with
		// account 43 as co-owner) → 403.
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

		// The co-owner (account 43, Role 30) may view the instances too.
		const coOwner = await exports.default.fetch(`${ORIGIN}/room/3/instances`, {
			headers: await bearer('43'),
		})
		expect(coOwner.status).toBe(200)
		expect((await coOwner.json()) as unknown[]).toHaveLength(instances.length)
	})

	test('GET /openapi.json documents every route', async () => {
		const res = await exports.default.fetch(`${ORIGIN}/openapi.json`)
		expect(res.status).toBe(200)
		const spec = (await res.json()) as {
			openapi: string
			paths: Record<string, Record<string, { summary?: string }>>
		}
		expect(spec.openapi).toMatch(/^3\.1/)

		// The spec route hides itself.
		expect(spec.paths['/openapi.json']).toBeUndefined()

		// Every route the worker serves is described. This is the drift guard: adding a
		// route without a describeRoute() block fails here rather than silently shipping
		// an incomplete spec. Hono's `:param` syntax becomes OpenAPI's `{param}`.
		const documented = new Set(
			Object.entries(spec.paths).flatMap(([path, ops]) =>
				Object.keys(ops).map((method) => `${method.toUpperCase()} ${path}`)
			)
		)
		expect([...documented].sort()).toEqual([
			'GET /player',
			'GET /room/{roomId}/instances',
			'GET /rooms/requiring/developer',
			'GET /rooms/requiring/rrplus',
			'POST /goto/none',
			'POST /goto/room/{room}',
			'POST /matchmake/club/{clubId}',
			'POST /matchmake/none',
			'POST /matchmake/room/{roomId}',
			'POST /matchmake/room/{roomId}/{subRoomId}',
			'POST /matchmake/{room}',
			'POST /player/exclusivelogin',
			'POST /player/heartbeat',
			'POST /player/login',
			'POST /player/logout',
			'POST /player/notifydisconnect',
			'POST /roominstance/{id}/reportjoinresult',
			'PUT /player/gameserverregionpings',
			'PUT /player/photonregionpings',
			'PUT /player/statusvisibility',
			'PUT /roominstance/{id}/inprogress',
		])

		// Every operation carries a summary — a path present but undescribed is not
		// documentation.
		for (const ops of Object.values(spec.paths)) {
			for (const op of Object.values(ops)) expect(op.summary).toBeTruthy()
		}
	})
})
