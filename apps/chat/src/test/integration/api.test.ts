import { SELF } from 'cloudflare:test'
import { describe, expect, it } from 'vitest'

import '../../chat.app'

const ORIGIN = 'https://example.com'

describe('chat endpoints', () => {
	it('GET / reports service status', async () => {
		const res = await SELF.fetch(`${ORIGIN}/`)
		expect(res.status).toBe(200)
		expect(await res.json()).toEqual({ service: 'chat', status: 'ok' })
	})

	it('GET /thread returns an empty array', async () => {
		const res = await SELF.fetch(`${ORIGIN}/thread`)
		expect(res.status).toBe(200)
		expect(await res.json()).toEqual([])
	})
})
