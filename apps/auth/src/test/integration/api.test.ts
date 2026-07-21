import { adminSecretsStore, env } from 'cloudflare:test'
import { exports } from 'cloudflare:workers'
import { beforeAll, describe, expect, test } from 'vitest'

import '../../auth.app'

import { getAccountsByDeviceId, hashPassword, PRESENCE_SCHEMA_DDL, SCHEMA_DDL } from '@repo/domain'

import { isLinkedToPlatformIdentity } from '../../auth.app'
import { REFRESH_SCHEMA_DDL } from '../../refresh-db'

import type { Env } from '../../context'

declare module 'cloudflare:test' {
	interface ProvidedEnv extends Env {}
}

const ORIGIN = 'https://example.com'

// The Orientation room (RoomId 13) new accounts are placed into on signup.
const ORIENTATION_SCENE = 'c79709d8-a31b-48aa-9eb8-cc31ba9505e8'

// Credential login requires the account's password; seed a known one for the
// accounts the login tests authenticate as (42, 77).
const LOGIN_PASSWORD = 'correct-horse'

// Apply the accounts schema so create_account can persist (mirrors the migration),
// and seed the Orientation room (owned by the rooms worker) so signup can place
// the new player there.
beforeAll(async () => {
	// Seed the shared JWT signing key into the local Secrets Store so .get() resolves.
	await adminSecretsStore(env.JWT_SECRET).create('test-signing-key')
	for (const stmt of SCHEMA_DDL) await env.DB.prepare(stmt).run()
	for (const stmt of REFRESH_SCHEMA_DDL) await env.DB.prepare(stmt).run()
	// Presence table (owned by the rooms worker) — signup seeds the Orientation row.
	for (const stmt of PRESENCE_SCHEMA_DDL) await env.DB.prepare(stmt).run()

	// Seed the accounts the credential-login tests use, each with LOGIN_PASSWORD set.
	const hash = await hashPassword(LOGIN_PASSWORD)
	for (const id of [42, 77]) {
		await env.DB.prepare('INSERT OR IGNORE INTO account (data) VALUES (?1)')
			.bind(JSON.stringify({ accountId: id, username: `Player${id}`, passwordHash: hash }))
			.run()
	}
	await env.DB.prepare(
		`CREATE TABLE IF NOT EXISTS room (
			data TEXT NOT NULL,
			room_id INTEGER GENERATED ALWAYS AS (json_extract(data, '$.RoomId')) VIRTUAL
		)`
	).run()
	await env.DB.prepare('INSERT OR IGNORE INTO room (data) VALUES (?1)')
		.bind(
			JSON.stringify({
				RoomId: 13,
				Name: 'Orientation',
				IsDorm: false,
				SubRooms: [{ SubRoomId: 23, UnitySceneId: ORIENTATION_SCENE, MaxPlayers: 1 }],
			})
		)
		.run()
})

/** Decode a JWT payload (no verification) for asserting claims. */
function decodePayload(token: string): Record<string, unknown> {
	const part = token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')
	return JSON.parse(
		new TextDecoder().decode(Uint8Array.from(atob(part), (ch) => ch.charCodeAt(0)))
	) as Record<string, unknown>
}

async function accessTokenFor(body: string, ip?: string): Promise<string> {
	return (await postToken(body, ip)).json.access_token as string
}

async function tokenFor(body: string, ip?: string): Promise<Record<string, unknown>> {
	return decodePayload(await accessTokenFor(body, ip))
}

/**
 * POST a form-urlencoded body to /connect/token, returning status + parsed JSON.
 * `ip` sets CF-Connecting-IP (what Cloudflare's edge sets in production); omit it and
 * the request looks IP-less, which is how the other tests dodge the per-IP signup cap.
 */
async function postToken(
	body: string,
	ip?: string
): Promise<{ status: number; json: Record<string, unknown> }> {
	const res = await exports.default.fetch(`${ORIGIN}/connect/token`, {
		method: 'POST',
		headers: {
			'Content-Type': 'application/x-www-form-urlencoded',
			...(ip ? { 'CF-Connecting-IP': ip } : {}),
		},
		body,
	})
	return { status: res.status, json: (await res.json()) as Record<string, unknown> }
}

/** POST a form-urlencoded body to changepassword with an optional bearer token. */
function changePassword(body: string, token?: string): Promise<Response> {
	return exports.default.fetch(`${ORIGIN}/account/me/changepassword`, {
		method: 'POST',
		headers: {
			...(token ? { Authorization: `Bearer ${token}` } : {}),
			'Content-Type': 'application/x-www-form-urlencoded',
		},
		body,
	})
}

describe('auth worker routes', () => {
	test('GET /eac/challenge returns the EAC challenge as text/plain', async () => {
		const res = await exports.default.fetch(`${ORIGIN}/eac/challenge`)
		expect(res.status).toBe(200)
		expect(res.headers.get('content-type')).toContain('text/plain')
		// EAC challenge content (BOM is stripped on read).
		expect(await res.text()).toBe('"AA=="')
	})

	// Platform 0 (Steam), not 1 — platform 1 is Oculus, which is stubbed below.
	test('GET /cachedlogin/forplatformid/:platform/:id returns [] (no cached login)', async () => {
		const res = await exports.default.fetch(`${ORIGIN}/cachedlogin/forplatformid/0/abc123`)
		expect(res.status).toBe(200)
		expect(await res.json()).toEqual([])
	})

	// Oculus is stubbed: no DB lookup, one canned entry whatever the id.
	test('GET /cachedlogin/forplatformid/1/:id returns the canned Oculus entry', async () => {
		const res = await exports.default.fetch(`${ORIGIN}/cachedlogin/forplatformid/1/anything`)
		expect(res.status).toBe(200)
		expect(await res.json()).toEqual([
			{
				platform: 1,
				platformId: '1',
				accountId: 1,
				lastLoginTime: '2026-07-19T17:13:29.225Z',
				requirePassword: true,
			},
		])
	})

	// Only Steam (platform 0) can be verified (via its signed platform_auth ticket),
	// so every OTHER platform is rejected on the platform-authenticated grants — we
	// won't bind or authorize an identity we can't prove.
	test.each([1, 2, 3, 4, 5, 6, 7, 8])(
		'create_account rejects unverifiable platform %i',
		async (platform) => {
			const res = await postToken(
				`grant_type=create_account&platform=${platform}&platform_id=whoever`
			)
			expect(res.status).toBe(400)
			expect(res.json.error).toBe('invalid_grant')
			expect(res.json.error_description).toContain('only Steam')
		}
	)

	test.each([1, 2, 3, 4, 5, 6, 7, 8])(
		'cached_login rejects unverifiable platform %i',
		async (platform) => {
			const res = await postToken(
				`grant_type=cached_login&account_id=42&platform=${platform}&platform_id=whoever`
			)
			expect(res.status).toBe(400)
			expect(res.json.error).toBe('invalid_grant')
			expect(res.json.error_description).toContain('only Steam')
		}
	)

	test('Steam create_account requires a valid platform_auth ticket', async () => {
		// platform=0 (Steam) with no verifiable ticket must not bind the spoofable
		// platform_id field — it's rejected outright.
		const res = await postToken(
			'grant_type=create_account&platform=0&platform_id=76561197962463211'
		)
		expect(res.status).toBe(400)
		expect(res.json.error).toBe('invalid_grant')
		expect(res.json.error_description).toContain('platform_auth')
	})

	test('Steam cached_login requires a valid platform_auth ticket', async () => {
		const res = await postToken(
			'grant_type=cached_login&account_id=42&platform=0&platform_id=76561197962463211'
		)
		expect(res.status).toBe(400)
		expect(res.json.error).toBe('invalid_grant')
		expect(res.json.error_description).toContain('platform_auth')
	})

	test('cachedlogin/forplatformid returns the DTO for a bound (Steam) account', async () => {
		// Seed a Steam-linked account directly (a real create_account needs a live
		// ticket); assert the picker projects the CachedLogin DTO the client expects.
		const steamId = '76561197962463299'
		await env.DB.prepare('INSERT OR IGNORE INTO account (data) VALUES (?1)')
			.bind(
				JSON.stringify({
					accountId: 31380,
					username: 'SteamPlayer',
					platform: 0,
					platformId: steamId,
					lastLoginTime: '2026-07-09T21:20:31.419Z',
				})
			)
			.run()
		const res = await exports.default.fetch(`${ORIGIN}/cachedlogin/forplatformid/0/${steamId}`)
		expect(res.status).toBe(200)
		expect(await res.json()).toEqual([
			{
				platform: 0,
				platformId: steamId,
				accountId: 31380,
				lastLoginTime: '2026-07-09T21:20:31.419Z',
				requirePassword: false,
			},
		])
	})

	test('a Steam-linked account with no stored `platform` field still cached-logs in', async () => {
		// Regression: nothing defaults an account's `platform` (see defaultAccount), so a
		// Steam-linked account can carry a platformId with no platform. The picker offered
		// such an account (it treats a missing platform as Steam) while the cached_login
		// grant rejected it — "no linked account for this platform identity" forever.
		// Both now run the same check.
		const steamId = '76561197962463211'
		const account = { platformId: steamId } // no `platform` field

		// The grant now accepts it — this is what was returning invalid_grant.
		expect(isLinkedToPlatformIdentity(account, 0, steamId)).toBe(true)

		// The identity is still the credential: another SteamID, an account with no
		// platform identity, and an account bound to a different platform are all refused.
		expect(isLinkedToPlatformIdentity(account, 0, '76561197962463299')).toBe(false)
		expect(isLinkedToPlatformIdentity({}, 0, steamId)).toBe(false)
		expect(isLinkedToPlatformIdentity({ ...account, platform: 3 }, 0, steamId)).toBe(false)

		// And the picker offers exactly the accounts the grant accepts.
		await env.DB.prepare('INSERT OR IGNORE INTO account (data) VALUES (?1)')
			.bind(JSON.stringify({ accountId: 8, username: 'SteamOnly', platformId: steamId }))
			.run()
		const res = await exports.default.fetch(`${ORIGIN}/cachedlogin/forplatformid/0/${steamId}`)
		const offered = (await res.json()) as Array<{ accountId: number; platform: number }>
		expect(offered.map((a) => a.accountId)).toContain(8)
		expect(offered.find((a) => a.accountId === 8)?.platform).toBe(0)
	})

	test('POST /connect/token issues a bearer token with role/scope claims', async () => {
		const res = await exports.default.fetch(`${ORIGIN}/connect/token`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
			body: `account_id=42&platform_id=steam-123&password=${LOGIN_PASSWORD}`,
		})
		expect(res.status).toBe(200)
		const json = (await res.json()) as {
			access_token: string
			token_type: string
			expires_in: number
		}
		expect(json.token_type).toBe('Bearer')
		expect(json.expires_in).toBe(3600)
		// header.payload.signature
		const parts = json.access_token.split('.')
		expect(parts).toHaveLength(3)

		// The client reads these claims to authorize itself; decode and assert them.
		const payload = JSON.parse(
			new TextDecoder().decode(
				Uint8Array.from(atob(parts[1].replace(/-/g, '+').replace(/_/g, '/')), (ch) =>
					ch.charCodeAt(0)
				)
			)
		) as Record<string, unknown>
		expect(payload.sub).toBe('42') // account_id from the body is honored
		expect(payload.iss).toBe('https://auth.recflare.net')
		expect(payload.aud).toBe('https://auth.recflare.net')
		expect(payload.role).toContain('gameClient')
		// A plain account carries only the base role — no elevated roles.
		expect(payload.role).not.toContain('developer')
		expect(payload.role).not.toContain('moderator')
		expect(payload.scope).toContain('rn.api')
	})

	test('POST /connect/token stamps developer/moderator roles into the token', async () => {
		await env.DB.prepare('INSERT OR IGNORE INTO account (data) VALUES (?1)')
			.bind(
				JSON.stringify({
					accountId: 91,
					username: 'StaffPlayer',
					passwordHash: await hashPassword(LOGIN_PASSWORD),
					isDeveloper: true,
					isModerator: true,
				})
			)
			.run()
		const payload = await tokenFor(`account_id=91&password=${LOGIN_PASSWORD}`)
		expect(payload.role).toEqual(expect.arrayContaining(['gameClient', 'developer', 'moderator']))
	})

	test('POST /connect/token 400s when no account_id is posted (never defaults to 1)', async () => {
		const res = await exports.default.fetch(`${ORIGIN}/connect/token`, { method: 'POST' })
		expect(res.status).toBe(400)
		expect((await res.json()) as { error: string }).toMatchObject({ error: 'invalid_request' })
	})

	test('POST /connect/token 400s on a non-numeric account_id', async () => {
		const res = await exports.default.fetch(`${ORIGIN}/connect/token`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
			body: 'account_id=notanumber',
		})
		expect(res.status).toBe(400)
	})

	test('POST /connect/token rejects a credential login with the wrong password', async () => {
		const res = await postToken('account_id=42&password=wrong-password')
		expect(res.status).toBe(400)
		expect(res.json.error).toBe('invalid_grant')
	})

	test('POST /connect/token rejects a credential login with no password', async () => {
		const res = await postToken('account_id=42')
		expect(res.status).toBe(400)
		expect(res.json.error).toBe('invalid_grant')
	})

	test('POST /connect/token refuses login to an account with no password set', async () => {
		// Account 999 exists but never set a password — it has no credential to verify,
		// so login by id alone is refused (this is the closed takeover hole).
		await env.DB.prepare('INSERT OR IGNORE INTO account (data) VALUES (?1)')
			.bind(JSON.stringify({ accountId: 999, username: 'NoPass' }))
			.run()
		const res = await postToken('account_id=999&password=anything')
		expect(res.status).toBe(400)
		expect(res.json.error).toBe('invalid_grant')
	})

	test('POST /connect/token create_account can set a password used for later login', async () => {
		const created = await postToken(
			'grant_type=create_account&platform_id=steam-pw2&password=hunter2'
		)
		expect(created.status).toBe(200)
		const sub = decodePayload(created.json.access_token as string).sub as string

		// The password set at creation authenticates a subsequent credential login.
		const ok = await postToken(`account_id=${sub}&password=hunter2`)
		expect(ok.status).toBe(200)
		// A wrong password for that same account is rejected.
		const bad = await postToken(`account_id=${sub}&password=nope`)
		expect(bad.status).toBe(400)
	})

	test('POST /connect/token logs in by username (RecRoom password grant)', async () => {
		// The RecRoom client posts the username, not the account_id — case-insensitively
		// and with a trailing space, both of which must still resolve account 42.
		const res = await postToken(
			`grant_type=password&username=player42%20&password=${LOGIN_PASSWORD}`
		)
		expect(res.status).toBe(200)
		expect(decodePayload(res.json.access_token as string).sub).toBe('42')
	})

	test('POST /connect/token rejects a username login with the wrong password', async () => {
		const res = await postToken(`grant_type=password&username=Player42&password=wrong`)
		expect(res.status).toBe(400)
		expect(res.json.error).toBe('invalid_grant')
	})

	test('POST /connect/token 400s on an unknown username', async () => {
		const res = await postToken(`grant_type=password&username=NoSuchUser&password=whatever`)
		expect(res.status).toBe(400)
		expect(res.json.error).toBe('invalid_request')
	})

	test('POST /connect/token grant_type=create_account persists a new account', async () => {
		const payload = await tokenFor('grant_type=create_account&platform_id=steam-123')
		// The token's sub is the new account id, allocated above the system accounts.
		const sub = Number.parseInt(payload.sub as string, 10)
		expect(sub).toBeGreaterThanOrEqual(2)
		// The account exists in the DB with an auto-assigned (non-default) username.
		const row = await env.DB.prepare('SELECT data FROM account WHERE account_id = ?1')
			.bind(sub)
			.first<{ data: string }>()
		expect(row).not.toBeNull()
		const account = JSON.parse(row!.data) as { username: string }
		expect(account.username).not.toMatch(/^Player\d+$/)
	})

	test('POST /connect/token create_account stores the login device on the account', async () => {
		const deviceId = '69640e6ae1b54ae5b0ca8eeb4a8872ec6cf8fd88'
		const payload = await tokenFor(
			`grant_type=create_account&platform_id=steam-dev1&device_id=${deviceId}&device_class=2`
		)
		const sub = Number.parseInt(payload.sub as string, 10)
		const row = await env.DB.prepare('SELECT data FROM account WHERE account_id = ?1')
			.bind(sub)
			.first<{ data: string }>()
		const account = JSON.parse(row!.data) as { deviceId: string; deviceClass: number }
		expect(account.deviceId).toBe(deviceId)
		expect(account.deviceClass).toBe(2)

		// Accounts sharing a device can be found later (account linkup).
		const shared = await getAccountsByDeviceId(env.DB, deviceId)
		expect(shared.map((a) => a.accountId)).toContain(sub)
	})

	test('POST /connect/token stores deviceClass as an integer, not a REAL', async () => {
		// D1 binds a JS number as a SQLite REAL, so a naive json_set writes `"deviceClass":2.0`
		// into the blob. JSON.parse tolerates that, but the raw JSON is what other readers
		// (and any strict int parser) see, so assert on the stored TEXT, not the parsed value.
		await postToken(
			`grant_type=password&username=Player77&password=${LOGIN_PASSWORD}&device_id=dev-int&device_class=2`
		)
		const row = await env.DB.prepare('SELECT data FROM account WHERE account_id = ?1')
			.bind(77)
			.first<{ data: string }>()
		expect(row!.data).toContain('"deviceClass":2')
		expect(row!.data).not.toContain('2.0')
	})

	test('POST /connect/token refreshes the stored device on a credential login', async () => {
		// Account 42 was seeded with no device; a later login records the one it came from.
		const res = await postToken(
			`grant_type=password&username=Player42&password=${LOGIN_PASSWORD}&device_id=dev-42-new&device_class=3`
		)
		expect(res.status).toBe(200)
		const row = await env.DB.prepare('SELECT data FROM account WHERE account_id = ?1')
			.bind(42)
			.first<{ data: string }>()
		const account = JSON.parse(row!.data) as { deviceId: string; deviceClass: number }
		expect(account.deviceId).toBe('dev-42-new')
		expect(account.deviceClass).toBe(3)
	})

	test('POST /connect/token create_account records the client IP', async () => {
		const payload = await tokenFor('grant_type=create_account&platform_id=steam-ip1', '203.0.113.7')
		const sub = Number.parseInt(payload.sub as string, 10)
		const row = await env.DB.prepare('SELECT data FROM account WHERE account_id = ?1')
			.bind(sub)
			.first<{ data: string }>()
		const account = JSON.parse(row!.data) as { signupIp: string; lastLoginIp: string }
		expect(account.signupIp).toBe('203.0.113.7')
		expect(account.lastLoginIp).toBe('203.0.113.7')
	})

	test('POST /connect/token caps the accounts created from one IP', async () => {
		const ip = '198.51.100.22'
		for (let i = 0; i < 3; i++) {
			const ok = await postToken(`grant_type=create_account&platform_id=steam-cap${i}`, ip)
			expect(ok.status).toBe(200)
		}
		// The 4th signup from that IP is refused — the cap is 3.
		const capped = await postToken('grant_type=create_account&platform_id=steam-cap3', ip)
		expect(capped.status).toBe(400)
		expect(capped.json.error).toBe('invalid_grant')
		expect(capped.json.error_description).toMatch(/network/)

		// A different IP is unaffected, and the capped IP can still LOG IN to what it has.
		const other = await postToken(
			'grant_type=create_account&platform_id=steam-cap4',
			'198.51.100.23'
		)
		expect(other.status).toBe(200)
	})

	test('the signup caps come from vars, and 0 disables an arm', async () => {
		// The cap an operator actually runs is the `MAX_ACCOUNTS_PER_IP` var; the constant in
		// auth.app.ts is only the fallback. `env` is shared by every test in this file, so the
		// override is restored in `finally` rather than leaking a cap of 0 into the tests above.
		const original = env.MAX_ACCOUNTS_PER_IP
		try {
			env.MAX_ACCOUNTS_PER_IP = 1
			const ip = '198.51.100.30'
			const first = await postToken('grant_type=create_account&platform_id=steam-var0', ip)
			expect(first.status).toBe(200)
			const capped = await postToken('grant_type=create_account&platform_id=steam-var1', ip)
			expect(capped.status).toBe(400)
			expect(capped.json.error_description).toMatch(/network/)

			// 0 disables the arm entirely: the IP that was just capped can sign up again.
			env.MAX_ACCOUNTS_PER_IP = 0
			const uncapped = await postToken('grant_type=create_account&platform_id=steam-var2', ip)
			expect(uncapped.status).toBe(200)
		} finally {
			env.MAX_ACCOUNTS_PER_IP = original
		}
	})

	test('POST /connect/token does not cap logins, only signups', async () => {
		// Account 42's owner may be over the signup cap; that must never lock them out of
		// an account they already have.
		const res = await postToken(
			`grant_type=password&username=Player42&password=${LOGIN_PASSWORD}`,
			'198.51.100.22'
		)
		expect(res.status).toBe(200)
	})

	test('POST /connect/token create_account seeds the new player into Orientation', async () => {
		const payload = await tokenFor('grant_type=create_account&platform_id=steam-456')
		const sub = payload.sub as string
		// Presence is written to the shared `presence` D1 table (account_id keyed).
		const row = await env.DB.prepare('SELECT data FROM presence WHERE account_id = ?1')
			.bind(Number(sub))
			.first<{ data: string }>()
		expect(row).not.toBeNull()
		const presence = JSON.parse(row!.data) as {
			roomInstance: { roomInstanceId: number; roomId: number; location: string; name: string }
		}
		expect(presence.roomInstance).toMatchObject({
			roomInstanceId: -2,
			roomId: 13,
			location: ORIENTATION_SCENE,
			name: '^Orientation',
		})
	})

	test('POST /connect/token carries the platform int on the token', async () => {
		const payload = await tokenFor(`account_id=42&platform=5&password=${LOGIN_PASSWORD}`)
		expect(payload.platform).toBe(5)
		// `rn.plat` is the same int, not a pinned 0.
		expect(payload['rn.plat']).toBe(5)
	})

	test('POST /connect/token defaults the platform claim when none is posted', async () => {
		const payload = await tokenFor(`account_id=42&password=${LOGIN_PASSWORD}`)
		expect(payload.platform).toBe(0)
		expect(payload['rn.plat']).toBe(0)
	})

	test('POST /connect/token returns a refresh_token that redeems for a new token', async () => {
		const login = await postToken(
			`account_id=42&platform=0&platform_id=steam-123&password=${LOGIN_PASSWORD}`
		)
		expect(login.status).toBe(200)
		const refreshToken = login.json.refresh_token as string
		expect(typeof refreshToken).toBe('string')
		expect(refreshToken.length).toBeGreaterThan(0)

		const refreshed = await postToken(
			`grant_type=refresh_token&refresh_token=${encodeURIComponent(refreshToken)}`
		)
		expect(refreshed.status).toBe(200)
		const payload = decodePayload(refreshed.json.access_token as string)
		expect(payload.sub).toBe('42')
		// The platform identity comes off the account, not the refresh token. Account 42
		// has none bound (the posted `platform_id` above was never Steam-verified, so it
		// was never written), so the refreshed token carries no identity either.
		expect(payload.platform).toBe(0)
		expect(payload.platform_id).toBe('')
		// The refresh token is rotated (single-use), so a new one is returned.
		expect(refreshed.json.refresh_token).not.toBe(refreshToken)
	})

	test('a refreshed token carries the identity bound to the account', async () => {
		// A Steam-bound account: only a verified ticket writes `platformId`, so seed it
		// directly rather than posting an (unverified) platform_id on the login.
		await env.DB.prepare('INSERT OR IGNORE INTO account (data) VALUES (?1)')
			.bind(
				JSON.stringify({
					accountId: 43,
					username: 'Player43',
					passwordHash: await hashPassword(LOGIN_PASSWORD),
					platform: 0,
					platformId: 'steam-123',
				})
			)
			.run()

		const login = await postToken(`account_id=43&password=${LOGIN_PASSWORD}`)
		expect(login.status).toBe(200)
		const refreshed = await postToken(
			`grant_type=refresh_token&refresh_token=${encodeURIComponent(login.json.refresh_token as string)}`
		)
		expect(refreshed.status).toBe(200)
		const payload = decodePayload(refreshed.json.access_token as string)
		expect(payload.sub).toBe('43')
		expect(payload.platform).toBe(0)
		expect(payload.platform_id).toBe('steam-123')
	})

	test('POST /connect/token refresh_token is single-use (rejected on reuse)', async () => {
		const login = await postToken(`account_id=77&platform=0&password=${LOGIN_PASSWORD}`)
		const refreshToken = login.json.refresh_token as string

		const first = await postToken(
			`grant_type=refresh_token&refresh_token=${encodeURIComponent(refreshToken)}`
		)
		expect(first.status).toBe(200)
		// Redeeming the same token again fails — it was consumed (rotated) above.
		const reuse = await postToken(
			`grant_type=refresh_token&refresh_token=${encodeURIComponent(refreshToken)}`
		)
		expect(reuse.status).toBe(400)
		expect(reuse.json.error).toBe('invalid_grant')
	})

	test('POST /connect/token 400s on an unknown refresh_token', async () => {
		const res = await postToken('grant_type=refresh_token&refresh_token=NOPE-1')
		expect(res.status).toBe(400)
		expect(res.json.error).toBe('invalid_grant')
	})

	test('POST /cachedlogin/forplatformids returns []', async () => {
		const res = await exports.default.fetch(`${ORIGIN}/cachedlogin/forplatformids`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
			body: 'id=76561197971551621&id=76561197976728738',
		})
		expect(res.status).toBe(200)
		expect(await res.json()).toEqual([])
	})

	test('POST /account/me/changepassword 401s without a token', async () => {
		const res = await changePassword('oldPassword=&newPassword=secret123')
		expect(res.status).toBe(401)
	})

	test('POST /account/me/changepassword 400s without a new password', async () => {
		const token = await accessTokenFor('grant_type=create_account&platform_id=steam-pw0')
		const res = await changePassword('oldPassword=&newPassword=', token)
		expect(res.status).toBe(400)
	})

	test('POST /account/me/changepassword sets then rotates the password', async () => {
		const token = await accessTokenFor('grant_type=create_account&platform_id=steam-pw1')

		// First set — oldPassword is empty (as the client sends it).
		const set = await changePassword('oldPassword=&newPassword=first-password', token)
		expect(set.status).toBe(200)
		expect(await set.json()).toEqual({ success: true })

		// A wrong old password is now rejected.
		const wrong = await changePassword('oldPassword=nope&newPassword=second-password', token)
		expect(wrong.status).toBe(400)

		// The correct old password rotates it.
		const rotate = await changePassword(
			'oldPassword=first-password&newPassword=second-password',
			token
		)
		expect(rotate.status).toBe(200)
		expect(await rotate.json()).toEqual({ success: true })
	})

	test('GET /role/developer/:id returns a bare false for an un-flagged account', async () => {
		const res = await exports.default.fetch(`${ORIGIN}/role/developer/42`)
		expect(res.status).toBe(200)
		expect(await res.json()).toBe(false)
	})

	test('GET /role/developer/:id returns a bare true when the account is flagged', async () => {
		await env.DB.prepare('INSERT OR IGNORE INTO account (data) VALUES (?1)')
			.bind(JSON.stringify({ accountId: 4242, username: 'DevPlayer', isDeveloper: true }))
			.run()
		const res = await exports.default.fetch(`${ORIGIN}/role/developer/4242`)
		expect(res.status).toBe(200)
		expect(await res.json()).toBe(true)
	})

	test('GET /role/developer/:id 404s for an unknown player', async () => {
		const res = await exports.default.fetch(`${ORIGIN}/role/developer/99999`)
		expect(res.status).toBe(404)
	})

	test('GET /role/moderator/:id reflects the isModerator flag as a bare boolean', async () => {
		await env.DB.prepare('INSERT OR IGNORE INTO account (data) VALUES (?1)')
			.bind(JSON.stringify({ accountId: 4343, username: 'ModPlayer', isModerator: true }))
			.run()
		const granted = await exports.default.fetch(`${ORIGIN}/role/moderator/4343`)
		expect(await granted.json()).toBe(true)
		// An account without the flag (42) is not a moderator.
		const plain = await exports.default.fetch(`${ORIGIN}/role/moderator/42`)
		expect(await plain.json()).toBe(false)
		// Unknown player → 404.
		expect((await exports.default.fetch(`${ORIGIN}/role/moderator/99999`)).status).toBe(404)
	})

	test('unknown path returns 404', async () => {
		const res = await exports.default.fetch(`${ORIGIN}/nope`)
		expect(res.status).toBe(404)
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
			'GET /cachedlogin/forplatformid/{platform}/{id}',
			'GET /eac/challenge',
			'GET /role/developer/{id}',
			'GET /role/moderator/{id}',
			'POST /account/me/changepassword',
			'POST /cachedlogin/forplatformids',
			'POST /connect/token',
		])

		// Every operation carries a summary — a path present but undescribed is not
		// documentation.
		for (const ops of Object.values(spec.paths)) {
			for (const op of Object.values(ops)) expect(op.summary).toBeTruthy()
		}
	})
})
