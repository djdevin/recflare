import { exports } from 'cloudflare:workers'
import { describe, expect, test } from 'vitest'

import '../../ns.app'

const ORIGIN = 'https://ns.rec.djdevin.net'

describe('ns endpoints', () => {
	test('GET / returns the endpoints document', async () => {
		const res = await exports.default.fetch(`${ORIGIN}/`)
		expect(res.status).toBe(200)
		const body = (await res.json()) as Record<string, string>
		expect(body.API).toBe('https://api.rec.djdevin.net')
		expect(body.Notifications).toBe('https://notify.rec.djdevin.net')
		expect(body.Econ).toBe('https://econ.rec.djdevin.net')
	})

	test('unknown path returns 404', async () => {
		const res = await exports.default.fetch(`${ORIGIN}/nope`)
		expect(res.status).toBe(404)
	})
})
