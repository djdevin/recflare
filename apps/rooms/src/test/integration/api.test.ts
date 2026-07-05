import { env, SELF } from 'cloudflare:test'
import { beforeAll, describe, expect, it } from 'vitest'

import '../../rooms.app'

import importRooms from '../../../static/ImportRooms.json'
import {
	createRoomInstance,
	getRoomInstance,
	SCHEMA_DDL as ROOM_INSTANCE_SCHEMA_DDL,
} from '../../room-instance-db'
import { SCHEMA_DDL } from '../../rooms-db'

import type { Env } from '../../context'

declare module 'cloudflare:test' {
	interface ProvidedEnv extends Env {}
}

const ORIGIN = 'https://example.com'

// Mint a token the way the `auth` worker does, using the same dev secret.
const DEV_SECRET = 'dev-insecure-signing-key-change-me'
function b64url(input: ArrayBuffer | string): string {
	const bytes = typeof input === 'string' ? new TextEncoder().encode(input) : new Uint8Array(input)
	let binary = ''
	for (const byte of bytes) binary += String.fromCharCode(byte)
	return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}
async function bearer(sub: string): Promise<Record<string, string>> {
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

// Apply the schema + seed the imported rooms into the test D1 (mirrors the migrations).
beforeAll(async () => {
	for (const stmt of SCHEMA_DDL) await env.DB.prepare(stmt).run()
	for (const stmt of ROOM_INSTANCE_SCHEMA_DDL) await env.DB.prepare(stmt).run()
	const insert = env.DB.prepare('INSERT OR IGNORE INTO rooms (data) VALUES (?1)')
	await env.DB.batch(importRooms.map((r) => insert.bind(JSON.stringify(r))))
})

describe('rooms endpoints', () => {
	it('GET / reports service status', async () => {
		const res = await SELF.fetch(`${ORIGIN}/`)
		expect(res.status).toBe(200)
		expect(await res.json()).toEqual({ service: 'rooms', status: 'ok' })
	})

	it('GET /rooms/1 returns the seeded dorm with its SubRoom scene', async () => {
		const res = await SELF.fetch(`${ORIGIN}/rooms/1?include=1325`)
		expect(res.status).toBe(200)
		const body = (await res.json()) as {
			RoomId: number
			Name: string
			IsDorm: boolean
			SubRooms: Array<{ UnitySceneId: string }>
		}
		expect(body).toMatchObject({ RoomId: 1, Name: 'DormRoom', IsDorm: true })
		expect(body.SubRooms[0].UnitySceneId).toBe('76d98498-60a1-430c-ab76-b54a29b7a163')
	})

	it('GET /rooms/:id 404s for a room not in D1', async () => {
		const res = await SELF.fetch(`${ORIGIN}/rooms/99999`)
		expect(res.status).toBe(404)
	})

	it('GET /rooms?name= resolves a real room case-insensitively', async () => {
		const res = await SELF.fetch(`${ORIGIN}/rooms?name=reccenter`)
		expect(res.status).toBe(200)
		expect(await res.json()).toMatchObject({ Name: 'RecCenter' })
	})

	it('GET /rooms?name= returns {} when nothing matches', async () => {
		const res = await SELF.fetch(`${ORIGIN}/rooms?name=NoSuchRoomHere`)
		expect(await res.json()).toEqual({})
	})

	it('GET /rooms with no id or name returns 400', async () => {
		const res = await SELF.fetch(`${ORIGIN}/rooms`)
		expect(res.status).toBe(400)
	})

	it('GET /rooms/bulk?id= returns the matching rooms', async () => {
		const res = await SELF.fetch(`${ORIGIN}/rooms/bulk?id=1,2`)
		expect(res.status).toBe(200)
		const body = (await res.json()) as Array<{ RoomId: number; Name: string }>
		expect(body.map((r) => r.Name).sort()).toEqual(['DormRoom', 'RecCenter'])
	})

	it('GET /rooms/bulk?name=RecCenter returns [RecCenter]', async () => {
		const res = await SELF.fetch(`${ORIGIN}/rooms/bulk?name=RecCenter`)
		const body = (await res.json()) as Array<{ Name: string }>
		expect(body.map((r) => r.Name)).toEqual(['RecCenter'])
	})

	it('GET /rooms/ownedby/me is auth-gated and scoped to the caller', async () => {
		// No token → 401, no stub-account fallback (would otherwise leak account 1).
		const noAuth = await SELF.fetch(`${ORIGIN}/rooms/ownedby/me`)
		expect(noAuth.status).toBe(401)
		// Account 1 owns all the seeded rooms.
		const mine = (await (
			await SELF.fetch(`${ORIGIN}/rooms/ownedby/me`, { headers: await bearer('1') })
		).json()) as unknown[]
		expect(mine.length).toBe(importRooms.length)
		// A different account owns none of them.
		const other = (await (
			await SELF.fetch(`${ORIGIN}/rooms/ownedby/me`, { headers: await bearer('999') })
		).json()) as unknown[]
		expect(other).toEqual([])
	})

	it('GET /rooms/ownedby/:id returns an account public rooms (no auth)', async () => {
		const res = await SELF.fetch(`${ORIGIN}/rooms/ownedby/1`)
		expect(res.status).toBe(200)
		const body = (await res.json()) as Array<{
			RoomId: number
			Accessibility: number
			IsDorm?: boolean
			CreatorAccountId: number
		}>
		expect(body.length).toBeGreaterThan(0)
		// Only public, non-dorm rooms owned by account 1 — the private dorm (RoomId 1)
		// is excluded.
		expect(
			body.every((r) => r.Accessibility === 1 && r.IsDorm !== true && r.CreatorAccountId === 1)
		).toBe(true)
		expect(body.some((r) => r.RoomId === 1)).toBe(false)

		// An account that owns no public rooms → empty array.
		expect(await (await SELF.fetch(`${ORIGIN}/rooms/ownedby/999`)).json()).toEqual([])
	})

	it('GET /rooms/search returns a paginated { Results, TotalResults }', async () => {
		// Name-term search resolves a known public room.
		const res = await SELF.fetch(`${ORIGIN}/rooms/search?query=reccenter&skip=0&take=100`)
		expect(res.status).toBe(200)
		const body = (await res.json()) as { Results: Array<{ Name: string }>; TotalResults: number }
		expect(body.TotalResults).toBeGreaterThanOrEqual(1)
		expect(body.Results.some((r) => r.Name === 'RecCenter')).toBe(true)
	})

	it('GET /rooms/search excludes dorms and respects pagination shape', async () => {
		const res = await SELF.fetch(`${ORIGIN}/rooms/search?query=dormroom`)
		expect(res.status).toBe(200)
		const body = (await res.json()) as { Results: unknown[]; TotalResults: number }
		// The dorm is non-public/dorm, so a name search for it returns nothing.
		expect(body).toEqual({ Results: [], TotalResults: 0 })
	})

	it('GET /rooms/search?query=#tag returns 200 (tag search)', async () => {
		const res = await SELF.fetch(`${ORIGIN}/rooms/search?query=%23Quest+%23recroomoriginal`)
		expect(res.status).toBe(200)
		const body = (await res.json()) as { Results: unknown[]; TotalResults: number }
		expect(Array.isArray(body.Results)).toBe(true)
		expect(typeof body.TotalResults).toBe('number')
	})

	it('GET /rooms/search aliases #recroomoriginal to the rro tag', async () => {
		// Rooms are tagged `rro`, not `recroomoriginal` — the alias bridges them.
		const aliased = (await (
			await SELF.fetch(`${ORIGIN}/rooms/search?query=%23recroomoriginal`)
		).json()) as { TotalResults: number }
		const direct = (await (await SELF.fetch(`${ORIGIN}/rooms/search?query=%23rro`)).json()) as {
			TotalResults: number
		}
		expect(aliased.TotalResults).toBe(direct.TotalResults)
		expect(aliased.TotalResults).toBeGreaterThan(0)
	})

	it('GET /rooms/favoritedby/me returns a bare array of the caller favorited rooms (auth-scoped)', async () => {
		const headers = await bearer('777')

		// Auth-gated — no token is a 401, never account 1's favorites.
		expect((await SELF.fetch(`${ORIGIN}/rooms/favoritedby/me`)).status).toBe(401)

		// No favorites yet → empty array.
		const empty = (await (
			await SELF.fetch(`${ORIGIN}/rooms/favoritedby/me`, { headers })
		).json()) as unknown[]
		expect(empty).toEqual([])

		// Favorite two real rooms, then they come back.
		for (const id of [2, 12]) {
			await SELF.fetch(`${ORIGIN}/rooms/${id}/interactionby/me/favorite`, {
				method: 'PUT',
				headers,
			})
		}
		const body = (await (
			await SELF.fetch(`${ORIGIN}/rooms/favoritedby/me?skip=0&take=100`, { headers })
		).json()) as Array<{ RoomId: number }>
		expect(body.map((r) => r.RoomId).sort((a, b) => a - b)).toEqual([2, 12])

		// Un-favoriting one drops it from the list.
		await SELF.fetch(`${ORIGIN}/rooms/2/interactionby/me/favorite`, { method: 'PUT', headers })
		const afterUnfav = (await (
			await SELF.fetch(`${ORIGIN}/rooms/favoritedby/me`, { headers })
		).json()) as Array<{ RoomId: number }>
		expect(afterUnfav.map((r) => r.RoomId)).toEqual([12])

		// Scoped per player — a different account sees none.
		const other = (await (
			await SELF.fetch(`${ORIGIN}/rooms/favoritedby/me`, { headers: await bearer('778') })
		).json()) as unknown[]
		expect(other).toEqual([])
	})

	it('GET /rooms/visitedby/me returns a bare array of rooms the caller has interacted with (auth-scoped)', async () => {
		const headers = await bearer('779')

		// No interactions yet → empty array.
		const empty = (await (
			await SELF.fetch(`${ORIGIN}/rooms/visitedby/me`, { headers })
		).json()) as unknown[]
		expect(empty).toEqual([])

		// Interacting (cheer/favorite) records a last-visit on those rooms.
		await SELF.fetch(`${ORIGIN}/rooms/2/interactionby/me/cheer`, { method: 'PUT', headers })
		await SELF.fetch(`${ORIGIN}/rooms/12/interactionby/me/favorite`, { method: 'PUT', headers })

		const body = (await (
			await SELF.fetch(`${ORIGIN}/rooms/visitedby/me?skip=0&take=100`, { headers })
		).json()) as Array<{ RoomId: number }>
		expect(body.map((r) => r.RoomId).sort((a, b) => a - b)).toEqual([2, 12])

		// Un-cheering still counts as visited (the interaction row persists).
		await SELF.fetch(`${ORIGIN}/rooms/2/interactionby/me/cheer`, { method: 'PUT', headers })
		const afterUncheer = (await (
			await SELF.fetch(`${ORIGIN}/rooms/visitedby/me`, { headers })
		).json()) as unknown[]
		expect(afterUncheer.length).toBe(2)

		// Scoped per player — a different account sees none.
		const other = (await (
			await SELF.fetch(`${ORIGIN}/rooms/visitedby/me`, { headers: await bearer('780') })
		).json()) as unknown[]
		expect(other).toEqual([])
	})

	it('GET /rooms/hot returns a paginated { Results, TotalResults } of public rooms', async () => {
		const res = await SELF.fetch(`${ORIGIN}/rooms/hot?skip=0&take=100`)
		expect(res.status).toBe(200)
		const body = (await res.json()) as {
			Results: Array<{ RoomId: number; IsDorm?: boolean }>
			TotalResults: number
		}
		expect(body.Results.length).toBeGreaterThan(0)
		expect(body.TotalResults).toBeGreaterThanOrEqual(body.Results.length)
		// The dorm (RoomId 1) is non-public, so it's never in the feed.
		expect(body.Results.some((r) => r.RoomId === 1 || r.IsDorm === true)).toBe(false)
	})

	it('GET /rooms/hot?tag=rro filters to rro-tagged rooms', async () => {
		const res = await SELF.fetch(`${ORIGIN}/rooms/hot?tag=rro&skip=0&take=100`)
		expect(res.status).toBe(200)
		const body = (await res.json()) as {
			Results: Array<{ Name: string; Tags?: Array<{ Tag: string }> }>
			TotalResults: number
		}
		expect(body.Results.length).toBeGreaterThan(0)
		// Every result carries the rro tag, and a known rro room is present.
		expect(body.Results.every((r) => (r.Tags ?? []).some((t) => t.Tag === 'rro'))).toBe(true)
		expect(body.Results.some((r) => r.Name === 'RecCenter')).toBe(true)
	})

	it('GET /rooms/hot respects take pagination (TotalResults is the full count)', async () => {
		const res = await SELF.fetch(`${ORIGIN}/rooms/hot?tag=rro&skip=0&take=2`)
		const body = (await res.json()) as { Results: unknown[]; TotalResults: number }
		expect(body.Results.length).toBeLessThanOrEqual(2)
		expect(body.TotalResults).toBeGreaterThan(body.Results.length)
	})

	it('GET /rooms/hot aliases #recroomoriginal to the rro tag', async () => {
		const aliased = (await (
			await SELF.fetch(`${ORIGIN}/rooms/hot?tag=recroomoriginal`)
		).json()) as { TotalResults: number }
		const direct = (await (await SELF.fetch(`${ORIGIN}/rooms/hot?tag=rro`)).json()) as {
			TotalResults: number
		}
		expect(aliased.TotalResults).toBe(direct.TotalResults)
		expect(aliased.TotalResults).toBeGreaterThan(0)
	})

	it('GET /rooms/base returns a bare array of base/template rooms (incl. non-public)', async () => {
		const res = await SELF.fetch(`${ORIGIN}/rooms/base`)
		expect(res.status).toBe(200)
		const body = (await res.json()) as Array<{
			RoomId: number
			Accessibility: number
			Tags?: Array<{ Tag: string }>
		}>
		expect(Array.isArray(body)).toBe(true)
		expect(body.length).toBeGreaterThan(0)
		// Every result carries the `base` tag.
		expect(body.every((r) => (r.Tags ?? []).some((t) => t.Tag === 'base'))).toBe(true)
		// Includes rooms that aren't publicly listed (Accessibility != 1) — base
		// rooms bypass the public filter the feeds use.
		expect(body.some((r) => r.Accessibility !== 1)).toBe(true)
	})

	it('GET /rooms/base respects take pagination', async () => {
		const res = await SELF.fetch(`${ORIGIN}/rooms/base?skip=0&take=5`)
		const body = (await res.json()) as unknown[]
		expect(body.length).toBeLessThanOrEqual(5)
	})

	it('GET /rooms/recommendations returns a bare array of public rooms (split-test params ignored)', async () => {
		const res = await SELF.fetch(
			`${ORIGIN}/rooms/recommendations?splitTestId=1&splitTestValue=5`
		)
		expect(res.status).toBe(200)
		const body = (await res.json()) as Array<{ RoomId: number; IsDorm?: boolean }>
		expect(Array.isArray(body)).toBe(true)
		expect(body.length).toBeGreaterThan(0)
		// The dorm (RoomId 1) is non-public, so it's never recommended.
		expect(body.some((r) => r.RoomId === 1 || r.IsDorm === true)).toBe(false)

		// The split-test params don't change the result.
		const plain = (await (
			await SELF.fetch(`${ORIGIN}/rooms/recommendations`)
		).json()) as Array<{ RoomId: number }>
		expect(plain.map((r) => r.RoomId)).toEqual(body.map((r) => r.RoomId))
	})

	it('GET /rooms/recommendations respects take pagination', async () => {
		const res = await SELF.fetch(`${ORIGIN}/rooms/recommendations?skip=0&take=3`)
		const body = (await res.json()) as unknown[]
		expect(body.length).toBeLessThanOrEqual(3)
	})

	it('GET /rooms/:id/similar returns { Results, TotalResults } of tag-sharing rooms (excluding self)', async () => {
		const res = await SELF.fetch(`${ORIGIN}/rooms/2/similar`)
		expect(res.status).toBe(200)
		const body = (await res.json()) as {
			Results: Array<{ RoomId: number; Tags?: Array<{ Tag: string }> }>
			TotalResults: number
		}
		expect(body.Results.length).toBeGreaterThan(0)
		expect(body.TotalResults).toBeGreaterThanOrEqual(body.Results.length)
		// Never includes the target room itself.
		expect(body.Results.some((r) => r.RoomId === 2)).toBe(false)
		// Every result shares the `rro` tag RecCenter (room 2) carries.
		expect(body.Results.every((r) => (r.Tags ?? []).some((t) => t.Tag === 'rro'))).toBe(true)
	})

	it('GET /rooms/:id/similar respects take pagination', async () => {
		const res = await SELF.fetch(`${ORIGIN}/rooms/2/similar?skip=0&take=3`)
		const body = (await res.json()) as { Results: unknown[]; TotalResults: number }
		expect(body.Results.length).toBeLessThanOrEqual(3)
		expect(body.TotalResults).toBeGreaterThan(body.Results.length)
	})

	it('GET /rooms/:id/similar returns an empty result for a room not in D1', async () => {
		const res = await SELF.fetch(`${ORIGIN}/rooms/99999/similar`)
		expect(res.status).toBe(200)
		expect(await res.json()).toEqual({ Results: [], TotalResults: 0 })
	})

	it('POST /rooms/:id/clone clones a base room into a new owned room', async () => {
		const headers = {
			...(await bearer('801')),
			'Content-Type': 'application/x-www-form-urlencoded',
		}
		const post = async (id: number, name: string) =>
			(await (
				await SELF.fetch(`${ORIGIN}/rooms/${id}/clone`, {
					method: 'POST',
					headers,
					body: new URLSearchParams({ name }).toString(),
				})
			).json()) as {
				success: boolean
				error: string
				value: {
					RoomId: number
					Name: string
					CreatorAccountId: number
					Tags?: Array<{ Tag: string }>
				} | null
			}

		// Clone MakerRoom (base, RoomId 24) → a fresh room owned by the caller (801).
		const ok = await post(24, 'MyMakerClone')
		expect(ok.success).toBe(true)
		expect(ok.error).toBe('')
		expect(ok.value).not.toBeNull()
		expect(ok.value!.Name).toBe('MyMakerClone')
		expect(ok.value!.CreatorAccountId).toBe(801)
		expect(ok.value!.RoomId).toBeGreaterThan(51)
		// The `base` template tag is dropped so clones aren't listed as base rooms.
		expect((ok.value!.Tags ?? []).some((t) => t.Tag === 'base')).toBe(false)

		// It persists and is fetchable by its new id.
		const fetched = (await (await SELF.fetch(`${ORIGIN}/rooms/${ok.value!.RoomId}`)).json()) as {
			Name: string
		}
		expect(fetched.Name).toBe('MyMakerClone')

		// Duplicate name is rejected.
		const dup = await post(24, 'MyMakerClone')
		expect(dup).toMatchObject({ success: false, value: null })
		expect(dup.error).toMatch(/already exists/i)
	})

	it('POST /rooms/:id/clone requires auth (401, no account-1 fallback)', async () => {
		// No Authorization header → hard 401, and nothing is created.
		const res = await SELF.fetch(`${ORIGIN}/rooms/24/clone`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
			body: new URLSearchParams({ name: 'UnauthedClone' }).toString(),
		})
		expect(res.status).toBe(401)
		expect(await res.json()).toMatchObject({ success: false, value: null })

		// An invalid/garbage token is also rejected.
		const bad = await SELF.fetch(`${ORIGIN}/rooms/24/clone`, {
			method: 'POST',
			headers: {
				Authorization: 'Bearer not.a.jwt',
				'Content-Type': 'application/x-www-form-urlencoded',
			},
			body: new URLSearchParams({ name: 'UnauthedClone' }).toString(),
		})
		expect(bad.status).toBe(401)

		// The room was never created.
		const lookup = await SELF.fetch(`${ORIGIN}/rooms?name=UnauthedClone`)
		expect(await lookup.json()).toEqual({})
	})

	it('POST /rooms/:id/clone validates name and cloneability', async () => {
		const headers = {
			...(await bearer('802')),
			'Content-Type': 'application/x-www-form-urlencoded',
		}
		const post = async (id: number, body?: string) =>
			(await (
				await SELF.fetch(`${ORIGIN}/rooms/${id}/clone`, { method: 'POST', headers, body })
			).json()) as { success: boolean; error: string; value: unknown }

		// Missing name.
		const noName = await post(24, new URLSearchParams({ name: '' }).toString())
		expect(noName).toMatchObject({ success: false, value: null })
		expect(noName.error).toMatch(/must enter a name/i)

		// The dorm (RoomId 1) disallows cloning.
		const notCloneable = await post(1, new URLSearchParams({ name: 'CannotCloneDorm' }).toString())
		expect(notCloneable).toMatchObject({ success: false, value: null })
		expect(notCloneable.error).toMatch(/can't clone/i)

		// A source room not in D1.
		const missing = await post(99999, new URLSearchParams({ name: 'CloneOfNothing' }).toString())
		expect(missing).toMatchObject({ success: false, value: null })
	})

	const putForm = async (path: string, fields: Record<string, string>, sub?: string) =>
		SELF.fetch(`${ORIGIN}${path}`, {
			method: 'PUT',
			headers: {
				...(sub ? await bearer(sub) : {}),
				'Content-Type': 'application/x-www-form-urlencoded',
			},
			body: new URLSearchParams(fields).toString(),
		})

	// Room-mutation envelope helper.
	type RoomResult = {
		Success: boolean
		Value: unknown
		ErrorId: string | null
		Error: string | null
	}
	const bodyOf = async (res: Response) => (await res.json()) as RoomResult

	it('PUT /rooms/:id/description is auth-gated, owner-only, and persists', async () => {
		// No token → 401 (auth gate).
		expect((await putForm('/rooms/2/description', { description: 'x' })).status).toBe(401)
		// Not the owner (RecCenter is owned by account 1) → 200 envelope, Success:false.
		expect(
			await bodyOf(await putForm('/rooms/2/description', { description: 'x' }, '999'))
		).toMatchObject({ Success: false, ErrorId: 'Rooms.NotOwner' })
		// Unknown room → Rooms.DoesntExist envelope.
		expect(
			await bodyOf(await putForm('/rooms/99999/description', { description: 'x' }, '1'))
		).toMatchObject({
			Success: false,
			ErrorId: 'Rooms.DoesntExist',
			Error: 'This room does not exist!',
		})

		// Owner updates it, and it persists.
		const ok = await putForm('/rooms/2/description', { description: 'blah blah blah' }, '1')
		expect(ok.status).toBe(200)
		expect(await bodyOf(ok)).toMatchObject({
			Success: true,
			Value: null,
			ErrorId: null,
			Error: null,
		})
		const room = (await (await SELF.fetch(`${ORIGIN}/rooms/2`)).json()) as { Description: string }
		expect(room.Description).toBe('blah blah blah')
	})

	it('PUT /rooms/:id/name is auth-gated, owner-only, unique, and persists', async () => {
		// No token → 401 (auth gate).
		expect((await putForm('/rooms/2/name', { name: 'Whatever' })).status).toBe(401)
		// Wrong owner / unknown room → Success:false envelopes.
		expect(await bodyOf(await putForm('/rooms/2/name', { name: 'Whatever' }, '999'))).toMatchObject(
			{
				Success: false,
				ErrorId: 'Rooms.NotOwner',
			}
		)
		expect(
			await bodyOf(await putForm('/rooms/99999/name', { name: 'Whatever' }, '1'))
		).toMatchObject({
			Success: false,
			ErrorId: 'Rooms.DoesntExist',
		})
		// Empty name → Success:false.
		expect(await bodyOf(await putForm('/rooms/2/name', { name: '  ' }, '1'))).toMatchObject({
			Success: false,
			ErrorId: 'Rooms.InvalidName',
		})
		// A name already used by a different room (GoldenTrophy is room 12).
		expect(
			await bodyOf(await putForm('/rooms/2/name', { name: 'GoldenTrophy' }, '1'))
		).toMatchObject({
			Success: false,
			ErrorId: 'Rooms.AlreadyExists',
			Error: 'A room with that name already exists!',
		})

		// Owner renames to a free name, and it persists (findable by the new name).
		const ok = await putForm('/rooms/2/name', { name: 'RenamedCenter' }, '1')
		expect(await bodyOf(ok)).toMatchObject({ Success: true })
		const room = (await (await SELF.fetch(`${ORIGIN}/rooms?name=RenamedCenter`)).json()) as {
			RoomId: number
		}
		expect(room.RoomId).toBe(2)
	})

	it('room_instance: create + read round-trips and hides JsonIgnore fields', async () => {
		const created = await createRoomInstance(env.DB, {
			ownerAccountId: 5,
			roomId: 2,
			subRoomId: 3,
			photonRoomId: crypto.randomUUID(),
			name: '^RecCenter',
			maxCapacity: 20,
			isPrivate: true,
			encryptVoiceChat: true,
		})
		// The DB assigns a sequential id, mapped to `roomInstanceId` in the DTO.
		expect(created.roomInstanceId).toBeGreaterThan(0)
		expect(created.roomId).toBe(2)
		expect(created.isPrivate).toBe(true)
		expect(created.EncryptVoiceChat).toBe(true) // PascalCase JSON key, per the C#

		// Reads back identically; JsonIgnore columns are not in the DTO.
		const fetched = await getRoomInstance(env.DB, created.roomInstanceId)
		expect(fetched).toEqual(created)
		expect('ownerAccountId' in (fetched as object)).toBe(false)
		expect('dataBlob' in (fetched as object)).toBe(false)
		expect('allowNewUsers' in (fetched as object)).toBe(false)
	})

	it('GET /photon_access_token (bare + /roomserver) returns permissions', async () => {
		for (const path of ['/photon_access_token', '/roomserver/photon_access_token']) {
			const res = await SELF.fetch(`${ORIGIN}${path}`)
			expect(res.status).toBe(200)
			const body = (await res.json()) as { Permissions: unknown[]; RoomInstanceId: number }
			expect(body.Permissions.length).toBeGreaterThan(0)
		}
	})

	it('interaction: defaults to false, cheer/favorite toggle and persist', async () => {
		type Interaction = { Cheered: boolean; Favorited: boolean; LastVisitedAt: string }
		const headers = await bearer('555')
		const get = async () =>
			(await (
				await SELF.fetch(`${ORIGIN}/rooms/12/interactionby/me`, { headers })
			).json()) as Interaction
		const put = async (action: 'cheer' | 'favorite') =>
			(await (
				await SELF.fetch(`${ORIGIN}/rooms/12/interactionby/me/${action}`, {
					method: 'PUT',
					headers,
				})
			).json()) as Interaction

		// No row yet → both false.
		expect(await get()).toMatchObject({ Cheered: false, Favorited: false })

		// Cheer on, then favorite on.
		expect(await put('cheer')).toMatchObject({ Cheered: true, Favorited: false })
		expect(await put('favorite')).toMatchObject({ Cheered: true, Favorited: true })
		// Persisted across a fresh GET.
		expect(await get()).toMatchObject({ Cheered: true, Favorited: true })

		// Toggling again flips back.
		expect(await put('cheer')).toMatchObject({ Cheered: false, Favorited: true })

		// Scoped per player — a different account starts fresh.
		const other = await bearer('556')
		const otherGet = (await (
			await SELF.fetch(`${ORIGIN}/rooms/12/interactionby/me`, { headers: other })
		).json()) as Interaction
		expect(otherGet).toMatchObject({ Cheered: false, Favorited: false })
	})

	it('DELETE /rooms/:id/interactionby/me/cheer clears the cheer (auth-gated, idempotent)', async () => {
		type Interaction = { Cheered: boolean; Favorited: boolean }
		const headers = await bearer('557')
		const del = () =>
			SELF.fetch(`${ORIGIN}/rooms/12/interactionby/me/cheer`, { method: 'DELETE', headers })

		// No token → 401.
		expect(
			(await SELF.fetch(`${ORIGIN}/rooms/12/interactionby/me/cheer`, { method: 'DELETE' })).status
		).toBe(401)

		// Cheer + favorite on, then DELETE clears only the cheer (favorite untouched).
		await SELF.fetch(`${ORIGIN}/rooms/12/interactionby/me/cheer`, { method: 'PUT', headers })
		await SELF.fetch(`${ORIGIN}/rooms/12/interactionby/me/favorite`, { method: 'PUT', headers })
		expect(await (await del()).json()).toMatchObject({ Cheered: false, Favorited: true })

		// Idempotent — a second DELETE stays cleared.
		expect(await (await del()).json()).toMatchObject({ Cheered: false, Favorited: true })

		// Idempotent on a never-interacted room, and it doesn't create a visited row.
		const fresh = await bearer('558')
		const res = await SELF.fetch(`${ORIGIN}/rooms/2/interactionby/me/cheer`, {
			method: 'DELETE',
			headers: fresh,
		})
		expect(await res.json()).toMatchObject({ Cheered: false, Favorited: false })
		const visited = (await (
			await SELF.fetch(`${ORIGIN}/rooms/visitedby/me`, { headers: fresh })
		).json()) as unknown[]
		expect(visited).toEqual([])
	})

	it('DELETE /rooms/:id/interactionby/me/favorite clears the favorite (auth-gated, idempotent)', async () => {
		const headers = await bearer('559')
		const del = () =>
			SELF.fetch(`${ORIGIN}/rooms/12/interactionby/me/favorite`, { method: 'DELETE', headers })

		// No token → 401.
		expect(
			(await SELF.fetch(`${ORIGIN}/rooms/12/interactionby/me/favorite`, { method: 'DELETE' })).status
		).toBe(401)

		// Favorite + cheer on, then DELETE clears only the favorite (cheer untouched).
		await SELF.fetch(`${ORIGIN}/rooms/12/interactionby/me/favorite`, { method: 'PUT', headers })
		await SELF.fetch(`${ORIGIN}/rooms/12/interactionby/me/cheer`, { method: 'PUT', headers })
		expect(await (await del()).json()).toMatchObject({ Cheered: true, Favorited: false })
		// It drops out of the caller's favorited list.
		const favs = (await (
			await SELF.fetch(`${ORIGIN}/rooms/favoritedby/me`, { headers })
		).json()) as unknown[]
		expect(favs).toEqual([])

		// Idempotent — a second DELETE stays cleared.
		expect(await (await del()).json()).toMatchObject({ Cheered: true, Favorited: false })

		// Idempotent on a never-interacted room, without creating a visited row.
		const fresh = await bearer('560')
		const res = await SELF.fetch(`${ORIGIN}/rooms/2/interactionby/me/favorite`, {
			method: 'DELETE',
			headers: fresh,
		})
		expect(await res.json()).toMatchObject({ Cheered: false, Favorited: false })
		const visited = (await (
			await SELF.fetch(`${ORIGIN}/rooms/visitedby/me`, { headers: fresh })
		).json()) as unknown[]
		expect(visited).toEqual([])
	})
})
