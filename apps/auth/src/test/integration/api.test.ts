import { env } from 'cloudflare:test'
import { exports } from 'cloudflare:workers'
import { beforeAll, describe, expect, test } from 'vitest'

import '../../auth.app'

import { SCHEMA_DDL } from '../../accounts-db'

import type { Env } from '../../context'

declare module 'cloudflare:test' {
	interface ProvidedEnv extends Env {}
}

const ORIGIN = 'https://example.com'

// The Orientation room (RoomId 13) new accounts are placed into on signup.
const ORIENTATION_SCENE = 'c79709d8-a31b-48aa-9eb8-cc31ba9505e8'

// Apply the accounts schema so create_account can persist (mirrors the migration),
// and seed the Orientation room (owned by the rooms worker) so signup can place
// the new player there.
beforeAll(async () => {
	for (const stmt of SCHEMA_DDL) await env.DB.prepare(stmt).run()
	await env.DB.prepare(
		`CREATE TABLE IF NOT EXISTS rooms (
			data TEXT NOT NULL,
			room_id INTEGER GENERATED ALWAYS AS (json_extract(data, '$.RoomId')) VIRTUAL
		)`
	).run()
	await env.DB.prepare('INSERT OR IGNORE INTO rooms (data) VALUES (?1)')
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

async function tokenFor(body: string): Promise<Record<string, unknown>> {
	const res = await exports.default.fetch(`${ORIGIN}/connect/token`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
		body,
	})
	const { access_token } = (await res.json()) as { access_token: string }
	return decodePayload(access_token)
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
			body: 'account_id=42&platform_id=steam-123',
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
		expect(payload.iss).toBe('https://auth.lapis.codes')
		expect(payload.aud).toBe('https://auth.lapis.codes/resources')
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
		const payload = await tokenFor('account_id=42&platform=0')
		expect(payload.platform).toBe('Steam')
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

	test('GET /role/developer/:id returns ok', async () => {
		const res = await exports.default.fetch(`${ORIGIN}/role/developer/42`)
		expect(res.status).toBe(200)
		expect(await res.json()).toEqual({ success: true })
	})

	test('unknown path returns 404', async () => {
		const res = await exports.default.fetch(`${ORIGIN}/nope`)
		expect(res.status).toBe(404)
	})
})
