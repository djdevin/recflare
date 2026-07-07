import { adminSecretsStore, env } from 'cloudflare:test'
import { exports } from 'cloudflare:workers'
import { beforeAll, describe, expect, test } from 'vitest'

import '../../clubs.app'

import type { Env } from '../../context'

declare module 'cloudflare:test' {
	interface ProvidedEnv extends Env {}
}

const ORIGIN = 'https://example.com'

beforeAll(async () => {
	// Seed the shared JWT signing key into the local Secrets Store so .get() resolves.
	await adminSecretsStore(env.JWT_SECRET).create('test-signing-key')
})

// Mint a token the way the `auth` worker does, signing with the shared test key seeded into the JWT_SECRET store.
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

describe('clubs endpoints', () => {
	test('GET /club/home/me 401s without a token', async () => {
		const res = await exports.default.fetch(`${ORIGIN}/club/home/me`)
		expect(res.status).toBe(401)
	})

	test('GET /club/home/me returns an empty object with a valid token', async () => {
		const res = await exports.default.fetch(`${ORIGIN}/club/home/me`, { headers: await bearer() })
		expect(res.status).toBe(200)
		expect(await res.json()).toEqual({})
	})

	test('GET /subscription/mine/member returns an empty array without a token', async () => {
		// The client calls this on the clubs host with no /club prefix and no auth.
		const res = await exports.default.fetch(`${ORIGIN}/subscription/mine/member`)
		expect(res.status).toBe(200)
		expect(await res.json()).toEqual([])
	})

	test('GET /subscription/details/:subscription returns an empty object', async () => {
		const res = await exports.default.fetch(`${ORIGIN}/subscription/details/rrplus`)
		expect(res.status).toBe(200)
		expect(await res.json()).toEqual({})
	})

	test('GET /subscription/details/:accountId returns simulated details', async () => {
		const res = await exports.default.fetch(`${ORIGIN}/subscription/details/2`)
		expect(res.status).toBe(200)
		expect(await res.json()).toEqual({ accountId: 2, clubId: 0, subscriberCount: 0 })
	})

	test('GET /subscription/subscriberCount/:id returns 0', async () => {
		const res = await exports.default.fetch(`${ORIGIN}/subscription/subscriberCount/2`)
		expect(res.status).toBe(200)
		expect(await res.json()).toBe(0)
	})

	test('GET /announcements/v2/mine/unread returns []', async () => {
		const res = await exports.default.fetch(`${ORIGIN}/announcements/v2/mine/unread`)
		expect(res.status).toBe(200)
		expect(await res.json()).toEqual([])
	})

	test('GET /club/mine/member returns []', async () => {
		const res = await exports.default.fetch(`${ORIGIN}/club/mine/member`)
		expect(res.status).toBe(200)
		expect(await res.json()).toEqual([])
	})

	test('unknown routes 404', async () => {
		const res = await exports.default.fetch(`${ORIGIN}/nope`)
		expect(res.status).toBe(404)
	})
})
