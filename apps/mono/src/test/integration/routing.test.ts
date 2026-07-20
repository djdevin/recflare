import { exports } from 'cloudflare:workers'
import { describe, expect, test } from 'vitest'

import type { Env } from '../../context'

declare module 'cloudflare:test' {
	interface ProvidedEnv extends Env {}
}

const ORIGIN = 'https://example.com'

// The facade's job is routing, not business logic, so one request that reaches a
// mounted app through the path prefix is enough to prove the wiring. `api` serves a
// static game-config with no auth/DB, so it's a clean target. The api worker namespaces
// its own routes under `/api`, hence the `/api` prefix (service) + `/api/...` (real path).
describe('mono routing', () => {
	test('path prefix routes to the api worker (gameconfigs)', async () => {
		const res = await exports.default.fetch(`${ORIGIN}/api/api/gameconfigs/v1/all`)
		expect(res.status).toBe(200)
		// Reached the api app's real handler, not the facade's 404.
		expect(res.headers.get('content-type')).toContain('application/json')
	})

	test('the facade host (mono.<domain>) falls back to the ns discovery worker', async () => {
		const res = await exports.default.fetch('https://mono.recflare.net/')
		expect(res.status).toBe(200)
		// The ns worker serves the service-discovery document.
		expect(await res.json()).toHaveProperty('Auth')
	})

	test('unknown service prefix returns the facade 404', async () => {
		const res = await exports.default.fetch(`${ORIGIN}/nope/whatever`)
		expect(res.status).toBe(404)
		expect(await res.json()).toMatchObject({ error: 'unknown_service' })
	})
})
