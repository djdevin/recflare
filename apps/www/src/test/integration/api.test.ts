import { SELF } from 'cloudflare:test'
import { expect, it } from 'vitest'

it('rejects unauthenticated account reads', async () => {
	const res = await SELF.fetch('https://example.com/api/me')
	expect(res.status).toBe(401)
	expect(await res.json()).toEqual({ error: 'not signed in' })
})

it('requires a password to sign up', async () => {
	const res = await SELF.fetch('https://example.com/api/signup', {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({}),
	})
	expect(res.status).toBe(400)
	expect(await res.json()).toEqual({ error: 'A password is required.' })
})

it('requires credentials to log in', async () => {
	const res = await SELF.fetch('https://example.com/api/login', {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ accountId: '1' }),
	})
	expect(res.status).toBe(400)
	expect(await res.json()).toEqual({ error: 'Account id and password are required.' })
})
