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

	it('GET /photon_access_token (bare + /roomserver) returns permissions', async () => {
		for (const path of ['/photon_access_token', '/roomserver/photon_access_token']) {
			const res = await SELF.fetch(`${ORIGIN}${path}`)
			expect(res.status).toBe(200)
			const body = (await res.json()) as { Permissions: unknown[]; RoomInstanceId: number }
			expect(body.Permissions.length).toBeGreaterThan(0)
		}
	})
})
