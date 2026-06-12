import { exports } from 'cloudflare:workers'
import { describe, expect, test } from 'vitest'

import '../../auth.app'

const ORIGIN = 'https://auth.rec.djdevin.net'

describe('auth worker routes', () => {
	test('GET /eac/challenge returns a JSON-quoted GUID', async () => {
		const res = await exports.default.fetch(`${ORIGIN}/eac/challenge`)
		expect(res.status).toBe(200)
		expect(res.headers.get('content-type')).toContain('text/plain')
		expect(await res.text()).toMatch(/^"[0-9a-f-]{36}"$/)
	})

	test('GET /cachedlogin/forplatformid/:platform/:id returns empty list', async () => {
		const res = await exports.default.fetch(`${ORIGIN}/cachedlogin/forplatformid/1/abc123`)
		expect(res.status).toBe(200)
		expect(await res.json()).toEqual([])
	})

	test('POST /connect/token issues a bearer token', async () => {
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
		expect(json.access_token.split('.')).toHaveLength(3)
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
