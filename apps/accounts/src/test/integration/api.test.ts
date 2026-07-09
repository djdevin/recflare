import { adminSecretsStore, env } from 'cloudflare:test'
import { exports } from 'cloudflare:workers'
import { beforeAll, describe, expect, test } from 'vitest'

import '../../accounts.app'

import { SCHEMA_DDL } from '@repo/domain'

import type { Env } from '../../context'

declare module 'cloudflare:test' {
	interface ProvidedEnv extends Env {}
}

const ORIGIN = 'https://example.com'

// Apply the accounts schema + seed the system (uid 0) and Coach (uid 1) accounts
// into the test D1 (mirrors apps/auth/migrations/0001_accounts.sql).
beforeAll(async () => {
	// Seed the shared JWT signing key into the local Secrets Store so .get() resolves.
	await adminSecretsStore(env.JWT_SECRET).create('test-signing-key')
	for (const stmt of SCHEMA_DDL) await env.DB.prepare(stmt).run()
	const insert = env.DB.prepare('INSERT OR IGNORE INTO accounts (data) VALUES (?1)')
	await env.DB.batch([
		insert.bind(JSON.stringify({ accountId: 0, username: 'RecRoom', displayName: 'Rec Room' })),
		insert.bind(JSON.stringify({ accountId: 1, username: 'Coach', displayName: 'Coach' })),
	])
})

// Mint a token the way the `auth` worker does, signing with the shared test key seeded into the JWT_SECRET store, so the
// accounts worker's validation accepts it. Kept inline to avoid a cross-package
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
			accountId: 123,
			username: 'Player123',
			displayName: 'Player123',
			profileImage: 'DefaultProfileImage.jpg',
		})
	})

	test('GET /account/:id rejects a non-numeric id', async () => {
		const res = await exports.default.fetch(`${ORIGIN}/account/abc`)
		expect(res.status).toBe(400)
	})

	test('GET /account/bulk resolves stored accounts and synthesizes the rest', async () => {
		const res = await exports.default.fetch(`${ORIGIN}/account/bulk?id=1&id=2,3`)
		expect(res.status).toBe(200)
		const accounts = (await res.json()) as Array<{ accountId: number; username: string }>
		// Every requested id is present and in order.
		expect(accounts.map((a) => a.accountId)).toEqual([1, 2, 3])
		// id 1 is the seeded Coach account; 2 and 3 fall back to synthesized defaults.
		expect(accounts[0].username).toBe('Coach')
		expect(accounts[1].username).toBe('Player2')
	})

	test('GET /account/search prefix-matches usernames, returns public DTOs', async () => {
		const res = await exports.default.fetch(`${ORIGIN}/account/search?name=coa`)
		expect(res.status).toBe(200)
		const accounts = (await res.json()) as Array<{ accountId: number; username: string }>
		// "Coach" (seeded uid 1) matches the "coa" prefix, case-insensitively.
		expect(accounts.some((a) => a.accountId === 1 && a.username === 'Coach')).toBe(true)
		// A non-matching prefix yields nothing.
		const none = await exports.default.fetch(`${ORIGIN}/account/search?name=zzzznope`)
		expect(await none.json()).toEqual([])
		// An empty query yields nothing (no full-table dump).
		const empty = await exports.default.fetch(`${ORIGIN}/account/search?name=`)
		expect(await empty.json()).toEqual([])
	})

	test('GET /account/:id/bio returns an empty bio', async () => {
		const res = await exports.default.fetch(`${ORIGIN}/account/7/bio`)
		expect(await res.json()).toEqual({ accountId: 7, bio: '' })
	})

	test('POST /account/create persists a new account with a random username', async () => {
		const res = await exports.default.fetch(`${ORIGIN}/account/create`, { method: 'POST' })
		expect(res.status).toBe(200)
		const body = (await res.json()) as {
			success: boolean
			value: { accountId: number; username: string; displayName: string }
		}
		expect(body.success).toBe(true)
		// Id is allocated above the seeded system accounts (0, 1).
		expect(body.value.accountId).toBeGreaterThanOrEqual(2)
		// Username is auto-assigned (not the synthesized "Player<id>" fallback) and
		// the display name mirrors it.
		expect(body.value.username).not.toMatch(/^Player\d+$/)
		expect(body.value.username.length).toBeGreaterThan(0)
		expect(body.value.displayName).toBe(body.value.username)
		// It's retrievable afterwards.
		const lookup = await exports.default.fetch(`${ORIGIN}/account/${body.value.accountId}`)
		const found = (await lookup.json()) as { username: string }
		expect(found.username).toBe(body.value.username)
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
		// Account JSON is camelCase (the client's AccountDTO), not the PascalCase we
		// store internally.
		expect(body).toMatchObject({
			accountId: 42,
			username: 'Player42',
			personalPronouns: 0,
			identityFlags: 0,
			availableUsernameChanges: 1,
		})
		// juniorState + parentAccountId must be omitted when null, not emitted as
		// null, or the client's enum parser throws on `juniorState`. `phone` isn't
		// part of the shape.
		expect('juniorState' in body).toBe(false)
		expect('parentAccountId' in body).toBe(false)
		expect('phone' in body).toBe(false)
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

	test('PUT /account/me/displayname persists the display name', async () => {
		const headers = {
			...(await bearer('895')),
			'Content-Type': 'application/x-www-form-urlencoded',
		}
		const res = await exports.default.fetch(`${ORIGIN}/account/me/displayname`, {
			...form({ displayName: 'laskdjfasdlfkj' }),
			headers,
		})
		expect(res.status).toBe(200)
		expect(await res.json()).toEqual({ success: true })

		const me = await exports.default.fetch(`${ORIGIN}/account/me`, { headers: await bearer('895') })
		expect(((await me.json()) as { displayName: string }).displayName).toBe('laskdjfasdlfkj')
	})

	test('PUT /account/me/username 401s without a token', async () => {
		const res = await exports.default.fetch(`${ORIGIN}/account/me/username`, {
			...form({ username: 'whoever' }),
		})
		expect(res.status).toBe(401)
	})

	test('PUT /account/me/username returns a Success:false envelope for a taken name', async () => {
		// "Coach" is the seeded account 1.
		const res = await exports.default.fetch(`${ORIGIN}/account/me/username`, {
			...form({ username: 'Coach' }),
			headers: { ...(await bearer('893')), 'Content-Type': 'application/x-www-form-urlencoded' },
		})
		// Business errors are HTTP 200 with the { success, error, value } envelope.
		expect(res.status).toBe(200)
		const body = (await res.json()) as { success: boolean; error: string; value: string }
		expect(body.success).toBe(false)
		expect(body.error).toMatch(/already taken/i)
		expect(body.value).toBe('')
	})

	test('PUT /account/me/username changes the name, decrements the counter, then blocks', async () => {
		const headers = {
			...(await bearer('892')),
			'Content-Type': 'application/x-www-form-urlencoded',
		}
		// First change succeeds — value is the updated account.
		const ok = await exports.default.fetch(`${ORIGIN}/account/me/username`, {
			...form({ username: 'coachx' }),
			headers,
		})
		expect(ok.status).toBe(200)
		const okBody = (await ok.json()) as {
			success: boolean
			error: string
			value: { accountId: number; username: string }
		}
		expect(okBody.success).toBe(true)
		expect(okBody.error).toBe('')
		expect(okBody.value).toMatchObject({ accountId: 892, username: 'coachx' })

		// /account/me reflects the new name and the decremented counter.
		const me = (await (
			await exports.default.fetch(`${ORIGIN}/account/me`, { headers: await bearer('892') })
		).json()) as { username: string; availableUsernameChanges: number }
		expect(me.username).toBe('coachx')
		expect(me.availableUsernameChanges).toBe(0)

		// A second change is blocked — no changes remaining (still HTTP 200).
		const blocked = await exports.default.fetch(`${ORIGIN}/account/me/username`, {
			...form({ username: 'coachy' }),
			headers,
		})
		expect(blocked.status).toBe(200)
		const blockedBody = (await blocked.json()) as { success: boolean; error: string }
		expect(blockedBody.success).toBe(false)
		expect(blockedBody.error).toMatch(/no username changes/i)
	})

	test('PUT /account/me/profileimage 401s without a token', async () => {
		const res = await exports.default.fetch(`${ORIGIN}/account/me/profileimage`, {
			...form({ imageName: 'abc.jpg' }),
		})
		expect(res.status).toBe(401)
	})

	test('PUT /account/me/profileimage 400s without an imageName', async () => {
		const res = await exports.default.fetch(`${ORIGIN}/account/me/profileimage`, {
			...form({}),
			headers: { ...(await bearer('777')), 'Content-Type': 'application/x-www-form-urlencoded' },
		})
		expect(res.status).toBe(400)
	})

	test('PUT /account/me/profileimage persists the avatar on the account', async () => {
		const res = await exports.default.fetch(`${ORIGIN}/account/me/profileimage`, {
			...form({ imageName: 'deadbeef.jpg' }),
			headers: { ...(await bearer('777')), 'Content-Type': 'application/x-www-form-urlencoded' },
		})
		expect(res.status).toBe(200)
		expect(await res.json()).toEqual({ success: true })

		// The stored value is returned by the self account (no hardcoded override).
		const me = await exports.default.fetch(`${ORIGIN}/account/me`, { headers: await bearer('777') })
		expect(((await me.json()) as { profileImage: string }).profileImage).toBe('deadbeef.jpg')
	})

	test('PUT /account/me/identityflags 401s without a token', async () => {
		const res = await exports.default.fetch(`${ORIGIN}/account/me/identityflags`, {
			...form({ identityFlags: '384' }),
		})
		expect(res.status).toBe(401)
	})

	test('PUT /account/me/identityflags 400s on a non-numeric value', async () => {
		const res = await exports.default.fetch(`${ORIGIN}/account/me/identityflags`, {
			...form({ identityFlags: 'nope' }),
			headers: { ...(await bearer('889')), 'Content-Type': 'application/x-www-form-urlencoded' },
		})
		expect(res.status).toBe(400)
	})

	test('PUT /account/me/identityflags persists the flags, surfaced by /account/me', async () => {
		const res = await exports.default.fetch(`${ORIGIN}/account/me/identityflags`, {
			...form({ identityFlags: '384' }),
			headers: { ...(await bearer('889')), 'Content-Type': 'application/x-www-form-urlencoded' },
		})
		expect(res.status).toBe(200)
		expect(await res.json()).toEqual({ success: true })

		const me = await exports.default.fetch(`${ORIGIN}/account/me`, { headers: await bearer('889') })
		expect(((await me.json()) as { identityFlags: number }).identityFlags).toBe(384)
	})

	test('POST /account/me/phone 401s without a token', async () => {
		const res = await exports.default.fetch(`${ORIGIN}/account/me/phone`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
			body: 'phone=%2B14444444444',
		})
		expect(res.status).toBe(401)
	})

	test('POST /account/me/phone 400s on empty, persists a real number', async () => {
		const headers = {
			...(await bearer('891')),
			'Content-Type': 'application/x-www-form-urlencoded',
		}
		// Empty phone → 400.
		const empty = await exports.default.fetch(`${ORIGIN}/account/me/phone`, {
			method: 'POST',
			headers,
			body: 'phone=',
		})
		expect(empty.status).toBe(400)

		// Set it → success.
		const res = await exports.default.fetch(`${ORIGIN}/account/me/phone`, {
			method: 'POST',
			headers,
			body: 'phone=%2B14444444444',
		})
		expect(res.status).toBe(200)
		expect(await res.json()).toEqual({ success: true })
	})

	test('PUT /account/me/personalpronouns persists the value, surfaced by /account/me', async () => {
		const res = await exports.default.fetch(`${ORIGIN}/account/me/personalpronouns`, {
			...form({ pronounFlags: '2' }),
			headers: { ...(await bearer('894')), 'Content-Type': 'application/x-www-form-urlencoded' },
		})
		expect(res.status).toBe(200)
		expect(await res.json()).toEqual({ success: true })

		const me = await exports.default.fetch(`${ORIGIN}/account/me`, { headers: await bearer('894') })
		expect(((await me.json()) as { personalPronouns: number }).personalPronouns).toBe(2)
	})

	test('PUT /account/me/bio 401s without a token', async () => {
		const res = await exports.default.fetch(`${ORIGIN}/account/me/bio`, { ...form({ bio: 'x' }) })
		expect(res.status).toBe(401)
	})

	test('PUT /account/me/bio persists the bio, read back via GET /account/:id/bio', async () => {
		const res = await exports.default.fetch(`${ORIGIN}/account/me/bio`, {
			...form({ bio: 'Devin!' }),
			headers: { ...(await bearer('890')), 'Content-Type': 'application/x-www-form-urlencoded' },
		})
		expect(res.status).toBe(200)
		expect(await res.json()).toEqual({ success: true })

		const bio = await exports.default.fetch(`${ORIGIN}/account/890/bio`)
		expect(await bio.json()).toEqual({ accountId: 890, bio: 'Devin!' })
	})

	test('POST /account/me/email 401s without a token', async () => {
		const res = await exports.default.fetch(`${ORIGIN}/account/me/email`, {
			...form({ email: 'a@b.com' }),
			method: 'POST',
		})
		expect(res.status).toBe(401)
	})

	test('POST /account/me/email 400s on a malformed email', async () => {
		const res = await exports.default.fetch(`${ORIGIN}/account/me/email`, {
			...form({ email: 'notanemail' }),
			method: 'POST',
			headers: { ...(await bearer('888')), 'Content-Type': 'application/x-www-form-urlencoded' },
		})
		expect(res.status).toBe(400)
	})

	test('POST /account/me/email persists the email, surfaced by /account/me', async () => {
		const res = await exports.default.fetch(`${ORIGIN}/account/me/email`, {
			...form({ email: 'ners@recroom.com' }),
			method: 'POST',
			headers: { ...(await bearer('888')), 'Content-Type': 'application/x-www-form-urlencoded' },
		})
		expect(res.status).toBe(200)
		expect(await res.json()).toEqual({ success: true })

		// The stored email is now returned by the self account (was a null stub).
		const me = await exports.default.fetch(`${ORIGIN}/account/me`, { headers: await bearer('888') })
		expect(((await me.json()) as { email: string }).email).toBe('ners@recroom.com')
	})
})
