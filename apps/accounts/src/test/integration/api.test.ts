import { exports } from 'cloudflare:workers'
import { describe, expect, test } from 'vitest'

import '../../accounts.app'

const ORIGIN = 'https://accounts.rec.djdevin.net'

// Mint a token the way the `auth` worker does, using the same dev secret, so the
// accounts worker's validation accepts it. Kept inline to avoid a cross-package
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

const form = (fields: Record<string, string>): RequestInit => ({
	method: 'PUT',
	headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
	body: new URLSearchParams(fields).toString(),
})

describe('public endpoints', () => {
	test('GET / returns a health response', async () => {
		const res = await exports.default.fetch(`${ORIGIN}/`)
		expect(res.status).toBe(200)
		expect(await res.json()).toEqual({ service: 'accounts', status: 'ok' })
	})

	test('GET /account/:id returns a default account', async () => {
		const res = await exports.default.fetch(`${ORIGIN}/account/123`)
		expect(res.status).toBe(200)
		expect(await res.json()).toMatchObject({
			AccountId: 123,
			Username: 'Player123',
			DisplayName: 'Player123',
			ProfileImage: 'DefaultProfileImage.jpg',
		})
	})

	test('GET /account/:id rejects a non-numeric id', async () => {
		const res = await exports.default.fetch(`${ORIGIN}/account/abc`)
		expect(res.status).toBe(400)
	})

	test('GET /account/bulk returns one account per id', async () => {
		const res = await exports.default.fetch(`${ORIGIN}/account/bulk?id=1&id=2,3`)
		expect(res.status).toBe(200)
		const accounts = (await res.json()) as Array<{ AccountId: number }>
		expect(accounts.map((a) => a.AccountId)).toEqual([1, 2, 3])
	})

	test('GET /account/:id/bio returns an empty bio', async () => {
		const res = await exports.default.fetch(`${ORIGIN}/account/7/bio`)
		expect(await res.json()).toEqual({ accountId: 7, bio: '' })
	})

	test('POST /account/create returns a wrapped account', async () => {
		const res = await exports.default.fetch(`${ORIGIN}/account/create`, { method: 'POST' })
		expect(res.status).toBe(200)
		const body = (await res.json()) as { success: boolean; value: { AccountId: number } }
		expect(body.success).toBe(true)
		expect(body.value.AccountId).toBeGreaterThanOrEqual(10000)
		expect(body.value.AccountId).toBeLessThanOrEqual(99999)
	})
})

describe('auth-gated endpoints', () => {
	test('GET /account/me 401s without a token', async () => {
		const res = await exports.default.fetch(`${ORIGIN}/account/me`)
		expect(res.status).toBe(401)
	})

	test('GET /account/me 401s with a garbage token', async () => {
		const res = await exports.default.fetch(`${ORIGIN}/account/me`, {
			headers: { Authorization: 'Bearer not-a-real-token' },
		})
		expect(res.status).toBe(401)
	})

	test('GET /account/me returns the self account with a valid token', async () => {
		const res = await exports.default.fetch(`${ORIGIN}/account/me`, { headers: await bearer() })
		expect(res.status).toBe(200)
		const body = (await res.json()) as Record<string, unknown>
		expect(body).toMatchObject({
			AccountId: 42,
			Username: 'Player42',
			AvailableUsernameChanges: 1,
		})
		// JuniorState + ParentAccountId must be omitted when null, not emitted as
		// null, or the client's enum parser throws on `juniorState`.
		expect('JuniorState' in body).toBe(false)
		expect('ParentAccountId' in body).toBe(false)
	})

	test('GET /parentalcontrol/me returns the flags', async () => {
		const res = await exports.default.fetch(`${ORIGIN}/parentalcontrol/me`, {
			headers: await bearer(),
		})
		expect(await res.json()).toEqual({ accountId: 42, disallowInAppPurchases: false })
	})

	test('PUT /account/me/displayname 401s without a token', async () => {
		const res = await exports.default.fetch(`${ORIGIN}/account/me/displayname`, {
			...form({ displayName: 'Bob' }),
		})
		expect(res.status).toBe(401)
	})

	test('PUT /account/me/displayname acks with a valid token', async () => {
		const res = await exports.default.fetch(`${ORIGIN}/account/me/displayname`, {
			...form({ displayName: 'Bob' }),
			headers: { ...(await bearer()), 'Content-Type': 'application/x-www-form-urlencoded' },
		})
		expect(res.status).toBe(200)
		expect(await res.json()).toEqual({ success: true })
	})
})
