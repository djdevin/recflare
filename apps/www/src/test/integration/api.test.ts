import { SELF } from 'cloudflare:test'
import { expect, it } from 'vitest'

it('rejects unauthenticated account reads', async () => {
	const res = await SELF.fetch('https://example.com/api/me')
	expect(res.status).toBe(401)
	expect(await res.json()).toEqual({ error: 'not signed in' })
})

it('refuses manual signups (disabled)', async () => {
	const res = await SELF.fetch('https://example.com/api/signup', {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ password: 'whatever' }),
	})
	expect(res.status).toBe(403)
	expect(await res.json()).toEqual({ error: 'Account creation is currently disabled.' })
})

it('requires credentials to log in', async () => {
	const res = await SELF.fetch('https://example.com/api/login', {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ username: 'alice' }),
	})
	expect(res.status).toBe(400)
	expect(await res.json()).toEqual({ error: 'Username and password are required.' })
})

it('rejects an unauthenticated maintenance broadcast', async () => {
	const res = await SELF.fetch('https://example.com/api/maintenance', {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ startsInMinutes: 15 }),
	})
	expect(res.status).toBe(401)
	expect(await res.json()).toEqual({ error: 'not signed in' })
})

it('rejects an unauthenticated coach message', async () => {
	const res = await SELF.fetch('https://example.com/api/coach-message', {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ messageContent: 'hello all' }),
	})
	expect(res.status).toBe(401)
	expect(await res.json()).toEqual({ error: 'not signed in' })
})

it('serves the aggregated docs page with a source per documented service', async () => {
	const res = await SELF.fetch('https://example.com/docs')
	expect(res.status).toBe(200)
	expect(res.headers.get('content-type')).toContain('text/html')
	const html = await res.text()
	// Mounts the self-hosted Scalar bundle (not a CDN) and lists every service's spec.
	expect(html).toContain('/docs/scalar.standalone.js')
	for (const slug of ['auth', 'accounts', 'match', 'econ']) {
		expect(html).toContain(`/docs/openapi/${slug}.json`)
	}
})

it('404s a spec proxy for an unknown service (not an open proxy)', async () => {
	// An un-allowlisted service is rejected before any upstream fetch, so this can't be
	// turned into a proxy to `https://<anything>.<DOMAIN>`.
	const res = await SELF.fetch('https://example.com/docs/openapi/evil.json')
	expect(res.status).toBe(404)
})
