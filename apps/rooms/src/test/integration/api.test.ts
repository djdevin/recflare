import { env, SELF } from 'cloudflare:test'
import { beforeAll, describe, expect, it } from 'vitest'

import '../../rooms.app'

import importRooms from '../../../static/ImportRooms.json'
import { SCHEMA_DDL } from '../../rooms-db'

import type { Env } from '../../context'

declare module 'cloudflare:test' {
	interface ProvidedEnv extends Env {}
}

const ORIGIN = 'https://rooms.rec.djdevin.net'

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

	it('GET /rooms/ownedby/me returns the caller created rooms (auth-scoped)', async () => {
		// No token → stub account 1, which owns all the seeded rooms.
		const mine = (await (await SELF.fetch(`${ORIGIN}/rooms/ownedby/me`)).json()) as unknown[]
		expect(mine.length).toBe(importRooms.length)
		// A different account owns none of them.
		const other = (await (
			await SELF.fetch(`${ORIGIN}/rooms/ownedby/me`, { headers: await bearer('999') })
		).json()) as unknown[]
		expect(other).toEqual([])
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
				await SELF.fetch(`${ORIGIN}/rooms/12/interactionby/me/${action}`, { method: 'PUT', headers })
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
})
