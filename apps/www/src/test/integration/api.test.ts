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
