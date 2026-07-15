import { SELF } from 'cloudflare:test'
import { describe, expect, it } from 'vitest'

import '../../commerce.app'

const ORIGIN = 'https://example.com'

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

	it('GET /api/catalog/v1/all serves the SKU catalog', async () => {
		const res = await SELF.fetch(`${ORIGIN}/api/catalog/v1/all?onlyAvailableSkus=true`)
		expect(res.status).toBe(200)
		const skus = (await res.json()) as Array<{ skuId: number }>
		expect(Array.isArray(skus)).toBe(true)
		expect(skus.length).toBeGreaterThan(0)
		expect(skus[0]).toHaveProperty('skuId')
	})

	it('GET /purchasecampaign/allcurrent/v2 returns []', async () => {
		const res = await SELF.fetch(`${ORIGIN}/purchasecampaign/allcurrent/v2`)
		expect(res.status).toBe(200)
		expect(await res.json()).toEqual([])
	})

	it('GET /reminder/currentTokenBundles/v2 returns []', async () => {
		const res = await SELF.fetch(`${ORIGIN}/reminder/currentTokenBundles/v2`)
		expect(res.status).toBe(200)
		expect(await res.json()).toEqual([])
	})
})
