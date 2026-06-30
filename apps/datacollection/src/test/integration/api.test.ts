import { SELF } from 'cloudflare:test'
import { describe, expect, it } from 'vitest'

import '../../datacollection.app'

const ORIGIN = 'https://example.com'

describe('datacollection endpoints', () => {
	it('GET / reports service status', async () => {
		const res = await SELF.fetch(`${ORIGIN}/`)
		expect(res.status).toBe(200)
		expect(await res.json()).toEqual({ service: 'datacollection', status: 'ok' })
	})

	it('POST /data/event accepts an event and returns 200', async () => {
		const res = await SELF.fetch(`${ORIGIN}/data/event`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ name: 'app_start', properties: { foo: 'bar' } }),
		})
		expect(res.status).toBe(200)
	})

	it('POST /data/event accepts an empty body', async () => {
		const res = await SELF.fetch(`${ORIGIN}/data/event`, { method: 'POST' })
		expect(res.status).toBe(200)
	})

	it('POST /data/heartbeat returns 200', async () => {
		const res = await SELF.fetch(`${ORIGIN}/data/heartbeat`, { method: 'POST' })
		expect(res.status).toBe(200)
	})
})
