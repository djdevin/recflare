import { SELF } from 'cloudflare:test'
import { expect, it } from 'vitest'

import { DOCUMENTED_SERVICES } from '../../docs'
import { DISCORD_INVITE, ISSUES_URL, PRIVACY_EMAIL } from '../../links'

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
	// Driven off the constant so adding a service can't leave the page (or this test)
	// behind.
	for (const { slug } of DOCUMENTED_SERVICES) {
		expect(html).toContain(`/docs/openapi/${slug}.json`)
	}
})

it('404s a spec proxy for an unknown service (not an open proxy)', async () => {
	// An un-allowlisted service is rejected before any upstream fetch, so this can't be
	// turned into a proxy to `https://<anything>.<DOMAIN>`.
	const res = await SELF.fetch('https://example.com/docs/openapi/evil.json')
	expect(res.status).toBe(404)
})

// The privacy policy is what the Meta Horizon Store's VRC.Privacy.1–4 checks are run
// against, and a reviewer only sees the rendered page — so the four things they look
// for are pinned here. If a section is renamed, re-read the VRC before loosening the
// assertion: these strings are the requirement, not incidental copy.
it('serves the privacy policy as real server-rendered HTML', async () => {
	const res = await SELF.fetch('https://example.com/privacy')
	// VRC.Privacy.1 — live, public, no sign-in, and text without JavaScript.
	expect(res.status).toBe(200)
	expect(res.headers.get('content-type')).toContain('text/html')
	const html = await res.text()
	expect(html).toContain('Privacy Policy')

	// VRC.Privacy.2 — what is collected, VRC.Privacy.3 — what it is used for.
	expect(html).toContain('What we collect')
	expect(html).toContain('Why we use it')

	// VRC.Privacy.4 — deletion is explained, free, and open to every region.
	expect(html).toContain('Deleting your data')
	expect(html).toMatch(/delete your account[^.]*at any\s+time, from anywhere in the world/)
	expect(html).toContain('There is no charge for this')

	// A deletion route a reader can actually follow. Discord and GitHub are always
	// listed; the mailbox only when one is configured (see PRIVACY_EMAIL).
	expect(html).toContain(DISCORD_INVITE)
	expect(html).toContain(ISSUES_URL)
	if (PRIVACY_EMAIL) expect(html).toContain(`mailto:${PRIVACY_EMAIL}`)
})
