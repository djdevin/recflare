import { exports } from 'cloudflare:workers'
import { describe, expect, test } from 'vitest'

import '../../ns.app'
import { buildEndpoints } from '../../endpoints'

const ORIGIN = 'https://example.com'

// Must match the DOMAIN var default in apps/ns/wrangler.jsonc.
const TEST_DOMAIN = 'rec.example.com'

describe('ns endpoints', () => {
	test('GET / returns the endpoints document', async () => {
		const res = await exports.default.fetch(`${ORIGIN}/`)
		expect(res.status).toBe(200)
		const body = await res.json()
		expect(body).toEqual(buildEndpoints(TEST_DOMAIN))
	})

	test('unknown path returns 404', async () => {
		const res = await exports.default.fetch(`${ORIGIN}/nope`)
		expect(res.status).toBe(404)
	})
})
