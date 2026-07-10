import { adminSecretsStore, env } from 'cloudflare:test'
import { exports } from 'cloudflare:workers'
import { beforeAll, describe, expect, test } from 'vitest'

import '../../clubs.app'

import { SCHEMA_DDL } from '../../clubs-db'

import type { Env } from '../../context'

declare module 'cloudflare:test' {
	interface ProvidedEnv extends Env {}
}

const ORIGIN = 'https://example.com'

beforeAll(async () => {
	// Seed the shared JWT signing key into the local Secrets Store so .get() resolves.
	await adminSecretsStore(env.JWT_SECRET).create('test-signing-key')
	// Build the club / club_member tables (mirrors the migration).
	for (const stmt of SCHEMA_DDL) await env.DB.prepare(stmt).run()
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

	test('GET /club/mine/member is auth-gated and lists the caller’s clubs', async () => {
		expect((await exports.default.fetch(`${ORIGIN}/club/mine/member`)).status).toBe(401)
		const res = await exports.default.fetch(`${ORIGIN}/club/mine/member`, {
			headers: await bearer('4242'),
		})
		expect(res.status).toBe(200)
		expect(await res.json()).toEqual([])
	})

	test('unknown routes 404', async () => {
		const res = await exports.default.fetch(`${ORIGIN}/nope`)
		expect(res.status).toBe(404)
	})

	// Full club lifecycle: create → get → other player joins/leaves, with the
	// creator auto-membership and MemberCount upkeep, plus the mine/* lists.
	test('create → get → join → leave a club, with MemberCount and my-clubs lists', async () => {
		type Club = {
			ClubId: number
			Name: string
			Category: string
			Visibility: number
			AllowJuniors: boolean
			MainImageName: string
			CreatorAccountId: number
			MemberCount: number
		}
		const post = async (path: string, sub: string | null, fields: Record<string, string> = {}) =>
			exports.default.fetch(`${ORIGIN}${path}`, {
				method: 'POST',
				headers: {
					...(sub ? await bearer(sub) : {}),
					'Content-Type': 'application/x-www-form-urlencoded',
				},
				body: new URLSearchParams(fields).toString(),
			})

		// Create requires auth.
		expect((await post('/club', null, { Name: 'Nope' })).status).toBe(401)
		// Create requires a name.
		expect((await post('/club', '800', { Name: '  ' })).status).toBe(400)

		// 800 creates a club → defaults applied, creator auto-joined (MemberCount 1).
		const created = (await (
			await post('/club', '800', { Name: 'Speedrunners', Category: 'Competitive' })
		).json()) as Club
		expect(created).toMatchObject({
			Name: 'Speedrunners',
			Category: 'Competitive',
			Visibility: 1, // default
			AllowJuniors: true, // default
			MainImageName: 'DefaultImgPurple', // default
			CreatorAccountId: 800,
			MemberCount: 1,
		})
		const clubId = created.ClubId

		// Public get by id returns it; unknown id 404s.
		const fetched = (await (await exports.default.fetch(`${ORIGIN}/club/${clubId}`)).json()) as Club
		expect(fetched.ClubId).toBe(clubId)
		expect((await exports.default.fetch(`${ORIGIN}/club/99999`)).status).toBe(404)

		// It shows in the creator's created + member lists.
		const created800 = (await (
			await exports.default.fetch(`${ORIGIN}/club/mine/created`, { headers: await bearer('800') })
		).json()) as Club[]
		expect(created800.map((c) => c.ClubId)).toContain(clubId)

		// 801 joins → MemberCount 2, and the club appears in 801's member list (not created).
		const joined = (await (await post(`/club/${clubId}/join`, '801')).json()) as Club
		expect(joined.MemberCount).toBe(2)
		const member801 = (await (
			await exports.default.fetch(`${ORIGIN}/club/mine/member`, { headers: await bearer('801') })
		).json()) as Club[]
		expect(member801.map((c) => c.ClubId)).toContain(clubId)
		const createdBy801 = (await (
			await exports.default.fetch(`${ORIGIN}/club/mine/created`, { headers: await bearer('801') })
		).json()) as Club[]
		expect(createdBy801).toEqual([])

		// Joining again is idempotent (still 2).
		expect(((await (await post(`/club/${clubId}/join`, '801')).json()) as Club).MemberCount).toBe(2)

		// 801 leaves → back to 1, and it drops out of their member list.
		expect(((await (await post(`/club/${clubId}/leave`, '801')).json()) as Club).MemberCount).toBe(1)
		const afterLeave = (await (
			await exports.default.fetch(`${ORIGIN}/club/mine/member`, { headers: await bearer('801') })
		).json()) as Club[]
		expect(afterLeave.map((c) => c.ClubId)).not.toContain(clubId)

		// Join/leave on a missing club 404s.
		expect((await post('/club/99999/join', '801')).status).toBe(404)
	})

	test('joining a non-open club records a pending request, not a membership', async () => {
		const post = async (path: string, sub: string, fields: Record<string, string> = {}) =>
			exports.default.fetch(`${ORIGIN}${path}`, {
				method: 'POST',
				headers: { ...(await bearer(sub)), 'Content-Type': 'application/x-www-form-urlencoded' },
				body: new URLSearchParams(fields).toString(),
			})
		type Club = { ClubId: number; Joinability: number; MemberCount: number }

		// 810 creates an ask-to-join club (Joinability 2) → only the creator counts.
		const club = (await (
			await post('/club', '810', { Name: 'Inner Circle', Joinability: '2' })
		).json()) as Club
		expect(club).toMatchObject({ Joinability: 2, MemberCount: 1 })

		// 811 asks to join → pending, so MemberCount is unchanged and it isn't a membership.
		const joined = (await (await post(`/club/${club.ClubId}/join`, '811')).json()) as Club
		expect(joined.MemberCount).toBe(1)
		const member811 = (await (
			await exports.default.fetch(`${ORIGIN}/club/mine/member`, { headers: await bearer('811') })
		).json()) as Club[]
		expect(member811.map((c) => c.ClubId)).not.toContain(club.ClubId)
	})
})
