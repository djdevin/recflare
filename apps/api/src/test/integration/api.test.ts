import { exports } from 'cloudflare:workers'
import { describe, expect, test } from 'vitest'

import '../../api.app'
import { DEFAULT_AVATAR_ITEMS } from '../../default-avatar-items'

const ORIGIN = 'https://api.rec.djdevin.net'

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
		expect(await res.json()).toEqual({ AmplitudeKey: 'NoKeyProvided' })
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

	test('GET /api/storefronts/v1/p2p/betaEnabled returns false', async () => {
		const res = await exports.default.fetch(`${ORIGIN}/api/storefronts/v1/p2p/betaEnabled`)
		expect(await res.json()).toBe(false)
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

	test('GET /api/settings/v2 seeds defaults for the account', async () => {
		const res = await exports.default.fetch(`${ORIGIN}/api/settings/v2`, {
			headers: await bearer(),
		})
		expect(res.status).toBe(200)
		const settings = (await res.json()) as Array<{ PlayerId: number; Key: string }>
		expect(settings[0]).toMatchObject({ PlayerId: 42, Key: 'Recroom.OOBE' })
	})

	test('GET /api/avatar/v2 returns a default avatar', async () => {
		const res = await exports.default.fetch(`${ORIGIN}/api/avatar/v2`, { headers: await bearer() })
		expect(await res.json()).toMatchObject({ FaceFeatures: '{}' })
	})
})

describe('room server', () => {
	test('GET /roomserver/rooms/bulk requires id or name', async () => {
		const res = await exports.default.fetch(`${ORIGIN}/roomserver/rooms/bulk`)
		expect(res.status).toBe(400)
	})

	test('GET /roomserver/rooms/bulk with id returns empty array', async () => {
		const res = await exports.default.fetch(`${ORIGIN}/roomserver/rooms/bulk?id=1,2`)
		expect(res.status).toBe(200)
		expect(await res.json()).toEqual([])
	})

	test('GET /roomserver/rooms/hot returns an empty result set', async () => {
		const res = await exports.default.fetch(`${ORIGIN}/roomserver/rooms/hot`)
		expect(await res.json()).toEqual({ Results: [], TotalResults: 0 })
	})

	test('GET /roomserver/rooms/:id 404s without data', async () => {
		const res = await exports.default.fetch(`${ORIGIN}/roomserver/rooms/5`)
		expect(res.status).toBe(404)
	})

	test('GET /roomserver/rooms/:id/interactionby/me', async () => {
		const res = await exports.default.fetch(`${ORIGIN}/roomserver/rooms/5/interactionby/me`)
		expect(await res.json()).toEqual({ Cheered: false, Favorited: false })
	})
})
