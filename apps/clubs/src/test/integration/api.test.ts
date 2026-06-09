import { exports } from 'cloudflare:workers'
import { describe, expect, test } from 'vitest'

import '../../clubs.app'

const ORIGIN = 'https://clubs.rec.djdevin.net'

describe('clubs endpoints', () => {
	test('GET /club/home/me returns 404', async () => {
		const res = await exports.default.fetch(`${ORIGIN}/club/home/me`)
		expect(res.status).toBe(404)
	})

	test('unknown routes 404', async () => {
		const res = await exports.default.fetch(`${ORIGIN}/nope`)
		expect(res.status).toBe(404)
	})
})
