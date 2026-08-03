import { SELF } from 'cloudflare:test'
import { expect, it } from 'vitest'

import { DOCUMENTED_SERVICES } from '../../docs'
import { DISCORD_INVITE, ISSUES_URL, PRIVACY_EMAIL } from '../../links'
import { turnstileKeys } from '../../turnstile'

import type { Env } from '../../context'

it('rejects unauthenticated account reads', async () => {
	const res = await SELF.fetch('https://example.com/api/me')
	expect(res.status).toBe(401)
	expect(await res.json()).toEqual({ error: 'not signed in' })
})

// Web signup is open, but only behind the Turnstile check. These pin the closed door:
// the pass path can't be tested here (it would call Cloudflare's siteverify for real).
it('advertises signup with the Turnstile site key the widget needs', async () => {
	const res = await SELF.fetch('https://example.com/api/config')
	expect(res.status).toBe(200)
	// The test keypair bound in vitest.config.ts stands in for the worker secrets a
	// deployed www carries.
	expect(await res.json()).toEqual({
		signupEnabled: true,
		turnstileSiteKey: '1x00000000000000000000AA',
	})
})

// The keypair is the on/off switch for signup, so a worker with no secrets set must report
// it closed — that's the state every fresh deploy starts in, and nothing in the environment
// may override it. Checked directly because the bindings are fixed for the fetch tests
// above.
it('treats a missing or half-configured keypair as signup being off', () => {
	const env = (over: Partial<Env>) => ({ ENVIRONMENT: 'development', ...over }) as Env
	expect(turnstileKeys(env({}))).toBeNull()
	expect(turnstileKeys(env({ TURNSTILE_SITE_KEY: '0xsite' }))).toBeNull()
	expect(turnstileKeys(env({ TURNSTILE_SECRET_KEY: '0xsecret' }))).toBeNull()
	expect(
		turnstileKeys(env({ TURNSTILE_SITE_KEY: '0xsite', TURNSTILE_SECRET_KEY: '0xsecret' }))
	).toEqual({ siteKey: '0xsite', secretKey: '0xsecret' })
})

it('refuses a signup with no Turnstile token', async () => {
	const res = await SELF.fetch('https://example.com/api/signup', {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ password: 'whatever' }),
	})
	// Rejected before any upstream call, so a bot can't reach create_account by omitting it.
	expect(res.status).toBe(400)
	expect(await res.json()).toEqual({ error: 'Please complete the bot check.' })
})

it('refuses a signup with no password', async () => {
	const res = await SELF.fetch('https://example.com/api/signup', {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ turnstileToken: 'dummy' }),
	})
	expect(res.status).toBe(400)
	expect(await res.json()).toEqual({ error: 'A password is required.' })
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
