import { exports } from 'cloudflare:workers'
import { describe, expect, test } from 'vitest'

import '../../auth.app'

const ORIGIN = 'https://auth.rec.djdevin.net'

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
		// Matches the C#'s JSON/eacchallenge.txt content (BOM is stripped on read).
		expect(await res.text()).toBe('"AA=="')
	})

	test('GET /cachedlogin/forplatformid/:platform/:id returns a cached login', async () => {
		const res = await exports.default.fetch(`${ORIGIN}/cachedlogin/forplatformid/1/abc123`)
		expect(res.status).toBe(200)
		const logins = (await res.json()) as Array<{ accountId: number }>
		expect(logins[0]).toMatchObject({ accountId: 1 })
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

	test('POST /connect/token falls back to account 1 when no account_id is posted', async () => {
		const res = await exports.default.fetch(`${ORIGIN}/connect/token`, { method: 'POST' })
		expect(res.status).toBe(200)
		const { access_token } = (await res.json()) as { access_token: string }
		const payload = JSON.parse(
			new TextDecoder().decode(
				Uint8Array.from(
					atob(access_token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')),
					(ch) => ch.charCodeAt(0)
				)
			)
		) as { sub: string }
		expect(payload.sub).toBe('1')
	})

	test('POST /connect/token grant_type=create_account mints a new account id', async () => {
		const payload = await tokenFor('grant_type=create_account&platform_id=steam-123')
		const sub = Number.parseInt(payload.sub as string, 10)
		expect(sub).toBeGreaterThanOrEqual(10000)
		expect(sub).toBeLessThanOrEqual(99999)
	})

	test('POST /connect/token maps the platform int to its enum name', async () => {
		const payload = await tokenFor('account_id=42&platform=0')
		expect(payload.platform).toBe('Steam')
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
