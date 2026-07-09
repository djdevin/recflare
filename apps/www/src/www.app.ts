import { Hono } from 'hono'
import { deleteCookie, getCookie, setCookie } from 'hono/cookie'
import { useWorkersLogger } from 'workers-tagged-logger'

import { withOnError } from '@repo/hono-helpers'

import { accountsBase, authBase, postForm } from './upstream'

import type { Context } from 'hono'
import type { CookieOptions } from 'hono/utils/cookie'
import type { App } from './context'

/**
 * www — the first frontend worker. It serves the React SPA (create account, set
 * email, change password) and acts as a backend-for-frontend: the browser talks
 * only to www, and www forwards to the `auth`/`accounts` workers server-side (see
 * `upstream.ts`). The account's JWT lives in an httpOnly cookie set here, so it's
 * never exposed to page JS.
 */

/** Name of the httpOnly session cookie holding the account's access token. */
const SESSION_COOKIE = 'rf_token'

/**
 * `create_account` needs a platform; RecNet (4) is the web platform. It's also
 * passed on credential logins for parity, though the auth worker ignores it there.
 */
const WEB_PLATFORM = '4'

/** Cookie flags for the session token. `secure` is dropped for local http dev. */
function sessionCookieOptions(c: Context<App>, maxAge: number): CookieOptions {
	const local = c.env.ENVIRONMENT === 'development' || c.env.ENVIRONMENT === 'VITEST'
	return {
		httpOnly: true,
		secure: !local,
		sameSite: 'Lax',
		path: '/',
		maxAge,
	}
}

/** Pull the session token out of the request cookie, or null when absent. */
function sessionToken(c: Context<App>): string | null {
	return getCookie(c, SESSION_COOKIE) ?? null
}

/** Relay an upstream worker's JSON response back to the browser unchanged. */
async function relay(c: Context<App>, res: Response) {
	const body = await res.text()
	return c.body(body, res.status as never, {
		'content-type': res.headers.get('content-type') ?? 'application/json',
	})
}

/**
 * Exchange an auth `/connect/token` response for a session: persist the returned
 * access token in the httpOnly cookie, then return the caller's self account
 * (fetched from the accounts worker with the fresh token).
 */
async function establishSession(c: Context<App>, tokenResponse: Response) {
	if (!tokenResponse.ok) return relay(c, tokenResponse)

	const token = (await tokenResponse.json()) as { access_token?: string; expires_in?: number }
	if (!token.access_token) {
		return c.json({ error: 'auth did not return an access token' }, 502)
	}

	setCookie(
		c,
		SESSION_COOKIE,
		token.access_token,
		sessionCookieOptions(c, token.expires_in ?? 3600)
	)

	const me = await fetch(`${accountsBase(c.env)}/account/me`, {
		headers: { authorization: `Bearer ${token.access_token}` },
	})
	if (!me.ok) return c.json({ error: 'failed to load account after auth' }, 502)
	return c.json({ account: await me.json() })
}

const app = new Hono<App>()
	.use(
		'*',
		// middleware
		(c, next) =>
			useWorkersLogger(c.env.NAME, {
				environment: c.env.ENVIRONMENT,
				release: c.env.SENTRY_RELEASE,
			})(c, next)
	)

	.onError(withOnError())

	// ---- BFF API ------------------------------------------------------------

	// Create a new account with a login password, then start a session.
	.post('/api/signup', async (c) => {
		const { password } = await c.req
			.json<{ password?: string }>()
			.catch(() => ({}) as { password?: string })
		if (!password) return c.json({ error: 'A password is required.' }, 400)

		const res = await postForm(`${authBase(c.env)}/connect/token`, {
			grant_type: 'create_account',
			platform: WEB_PLATFORM,
			password,
		})
		return establishSession(c, res)
	})

	// Log in with an existing account id + password, then start a session.
	.post('/api/login', async (c) => {
		const { accountId, password } = await c.req
			.json<{ accountId?: string; password?: string }>()
			.catch(() => ({}) as { accountId?: string; password?: string })
		if (!accountId || !password) {
			return c.json({ error: 'Account id and password are required.' }, 400)
		}

		const res = await postForm(`${authBase(c.env)}/connect/token`, {
			grant_type: 'password',
			account_id: String(accountId),
			platform: WEB_PLATFORM,
			password,
		})
		return establishSession(c, res)
	})

	// Clear the session cookie.
	.post('/api/logout', (c) => {
		deleteCookie(c, SESSION_COOKIE, { path: '/' })
		return c.json({ success: true })
	})

	// Current session's self account (used to restore UI state on page load).
	.get('/api/me', async (c) => {
		const token = sessionToken(c)
		if (!token) return c.json({ error: 'not signed in' }, 401)

		const res = await fetch(`${accountsBase(c.env)}/account/me`, {
			headers: { authorization: `Bearer ${token}` },
		})
		// Token expired/invalid — drop the stale cookie so the client shows sign-in.
		if (res.status === 401) {
			deleteCookie(c, SESSION_COOKIE, { path: '/' })
			return c.json({ error: 'session expired' }, 401)
		}
		return relay(c, res)
	})

	// Set the signed-in account's email.
	.post('/api/email', async (c) => {
		const token = sessionToken(c)
		if (!token) return c.json({ error: 'not signed in' }, 401)

		const { email } = await c.req.json<{ email?: string }>().catch(() => ({}) as { email?: string })
		if (!email) return c.json({ error: 'An email is required.' }, 400)

		const res = await postForm(`${accountsBase(c.env)}/account/me/email`, { email }, token)
		return relay(c, res)
	})

	// Change the signed-in account's password (current password required).
	.post('/api/password', async (c) => {
		const token = sessionToken(c)
		if (!token) return c.json({ error: 'not signed in' }, 401)

		const { oldPassword, newPassword } = await c.req
			.json<{ oldPassword?: string; newPassword?: string }>()
			.catch(() => ({}) as { oldPassword?: string; newPassword?: string })
		if (!newPassword) return c.json({ error: 'A new password is required.' }, 400)

		const res = await postForm(
			`${authBase(c.env)}/account/me/changepassword`,
			{ oldPassword: oldPassword ?? '', newPassword },
			token
		)
		return relay(c, res)
	})

	// ---- Static SPA ---------------------------------------------------------
	// Everything else is served from the built client assets. With
	// `not_found_handling: single-page-application`, unknown routes return
	// index.html so the React app can handle client-side routing.
	.all('*', (c) => {
		if (!c.env.ASSETS) return c.notFound()
		return c.env.ASSETS.fetch(c.req.raw)
	})

export default app
