import { SELF } from 'cloudflare:test'
import { describe, expect, it } from 'vitest'

import '../../commerce.app'

const ORIGIN = 'https://commerce.rec.djdevin.net'

describe('commerce endpoints', () => {
	it('GET / reports service status', async () => {
		const res = await SELF.fetch(`${ORIGIN}/`)
		expect(res.status).toBe(200)
		expect(await res.json()).toEqual({ service: 'commerce', status: 'ok' })
	})

	it('GET /purchase/v1/hasspentmoney returns false', async () => {
		const res = await SELF.fetch(`${ORIGIN}/purchase/v1/hasspentmoney`)
		expect(res.status).toBe(200)
		expect(await res.json()).toBe(false)
	})
})
