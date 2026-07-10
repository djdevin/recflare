import { adminSecretsStore, env } from 'cloudflare:test'
import { exports } from 'cloudflare:workers'
import { beforeAll, describe, expect, test } from 'vitest'

import '../../auth.app'

import { SCHEMA_DDL } from '@repo/domain'

import { hashPassword } from '../../password'
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

	// Seed the accounts the credential-login tests use, each with LOGIN_PASSWORD set.
	const hash = await hashPassword(LOGIN_PASSWORD)
	for (const id of [42, 77]) {
		await env.DB.prepare('INSERT OR IGNORE INTO accounts (data) VALUES (?1)')
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

async function accessTokenFor(body: string): Promise<string> {
	const res = await exports.default.fetch(`${ORIGIN}/connect/token`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
		body,
	})
	return ((await res.json()) as { access_token: string }).access_token
}

async function tokenFor(body: string): Promise<Record<string, unknown>> {
	return decodePayload(await accessTokenFor(body))
}

/** POST a form-urlencoded body to /connect/token, returning status + parsed JSON. */
async function postToken(body: string): Promise<{ status: number; json: Record<string, unknown> }> {
	const res = await exports.default.fetch(`${ORIGIN}/connect/token`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
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

	test('GET /cachedlogin/forplatformid/:platform/:id returns [] (no cached login)', async () => {
		const res = await exports.default.fetch(`${ORIGIN}/cachedlogin/forplatformid/1/abc123`)
		expect(res.status).toBe(200)
		expect(await res.json()).toEqual([])
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
		expect(payload.scope).toContain('rn.api')
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
		await env.DB.prepare('INSERT OR IGNORE INTO accounts (data) VALUES (?1)')
			.bind(JSON.stringify({ accountId: 999, username: 'NoPass' }))
			.run()
		const res = await postToken('account_id=999&password=anything')
		expect(res.status).toBe(400)
		expect(res.json.error).toBe('invalid_grant')
	})

	test('POST /connect/token create_account can set a password used for later login', async () => {
		const created = await postToken('grant_type=create_account&platform_id=steam-pw2&password=hunter2')
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
		const row = await env.DB.prepare('SELECT data FROM accounts WHERE account_id = ?1')
			.bind(sub)
			.first<{ data: string }>()
		expect(row).not.toBeNull()
		const account = JSON.parse(row!.data) as { username: string }
		expect(account.username).not.toMatch(/^Player\d+$/)
	})

	test('POST /connect/token create_account seeds the new player into Orientation', async () => {
		const payload = await tokenFor('grant_type=create_account&platform_id=steam-456')
		const sub = payload.sub as string
		const presence = await env.RECFLARE_MATCH_PRESENCE.get<{
			roomInstance: { roomInstanceId: number; roomId: number; location: string; name: string }
		}>(`presence:${sub}`, 'json')
		expect(presence).not.toBeNull()
		expect(presence!.roomInstance).toMatchObject({
			roomInstanceId: -2,
			roomId: 13,
			location: ORIENTATION_SCENE,
			name: '^Orientation',
		})
	})

	test('POST /connect/token maps the platform int to its enum name', async () => {
		const payload = await tokenFor(`account_id=42&platform=0&password=${LOGIN_PASSWORD}`)
		expect(payload.platform).toBe('Steam')
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
		// A fresh access token for the same account, carrying the stored platform.
		const payload = decodePayload(refreshed.json.access_token as string)
		expect(payload.sub).toBe('42')
		expect(payload.platform).toBe('Steam')
		expect(payload.platform_id).toBe('steam-123')
		// The refresh token is rotated (single-use), so a new one is returned.
		expect(refreshed.json.refresh_token).not.toBe(refreshToken)
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

	test('GET /role/developer/:id does not grant developer', async () => {
		const res = await exports.default.fetch(`${ORIGIN}/role/developer/42`)
		expect(res.status).toBe(200)
		expect(await res.json()).toEqual({ success: false })
	})

	test('unknown path returns 404', async () => {
		const res = await exports.default.fetch(`${ORIGIN}/nope`)
		expect(res.status).toBe(404)
	})
})
