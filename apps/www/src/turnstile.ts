import { logger } from '@repo/hono-helpers'

import type { Env } from './context'

/**
 * Cloudflare Turnstile, the bot check in front of web signup. Two keys make a widget:
 * the SITE key, which is public (it ships in the page markup so the browser can render
 * the widget), and the SECRET key, which stays on the worker and is the only thing that
 * can turn a widget token into a verdict.
 *
 * The verdict is fetched server-side, here in the BFF — never from the browser, which
 * would hand the secret to anyone who viewed source. The browser's only job is to carry
 * the widget's token to `POST /api/signup`.
 *
 * Turnstile is what makes web signup safe to leave open: `auth`'s per-IP cap is the only
 * other thing standing in front of the password/anonymous account path (it has no
 * platform identity to count), and that cap is coarse enough that it can't be the whole
 * defence. So signup FAILS CLOSED — no usable keypair, no signup (see `turnstileKeys`).
 */

/** Turnstile's verdict endpoint. Called from the worker only; the secret never leaves it. */
const SITEVERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify'

/**
 * Turnstile's documented always-passes test keypair. Account-independent: it belongs to
 * no widget, and the verdict is "pass" without any human involvement.
 *
 * Used ONLY when nothing is configured AND we're running locally (`just dev`, tests), so
 * a fresh checkout has a working signup form before anyone has created a widget. Never a
 * fallback in a deployed environment — there, unconfigured means signup is closed, so a
 * missing key can't quietly leave an unprotected endpoint open.
 */
const TEST_SITE_KEY = '1x00000000000000000000AA'
const TEST_SECRET_KEY = '1x0000000000000000000000000000000AA'

/** True for `just dev` and the vitest pool, where the test keypair is allowed. */
function isLocal(env: Env): boolean {
	return env.ENVIRONMENT === 'development' || env.ENVIRONMENT === 'VITEST'
}

/**
 * The keypair web signup runs on, or null when there isn't a usable one — which is what
 * closes signup (`/api/config` reports it, `/api/signup` refuses).
 *
 * Both keys must be present, and they always come from the same source: a real widget's
 * pair, or the local test pair. Half a configuration (a site key with no secret, e.g. the
 * `wrangler secret put` step skipped) is treated as unconfigured rather than run with the
 * test secret, which would render a real widget whose token is never actually checked.
 */
export function turnstileKeys(env: Env): { siteKey: string; secretKey: string } | null {
	const siteKey = env.TURNSTILE_SITE_KEY ?? ''
	const secretKey = env.TURNSTILE_SECRET_KEY ?? ''
	if (siteKey !== '' && secretKey !== '') return { siteKey, secretKey }
	if (isLocal(env)) return { siteKey: TEST_SITE_KEY, secretKey: TEST_SECRET_KEY }
	if (siteKey !== '' || secretKey !== '') {
		logger.error('turnstile is half-configured, so web signup is closed', {
			hasSiteKey: siteKey !== '',
			hasSecretKey: secretKey !== '',
		})
	}
	return null
}

/** Turnstile's siteverify response, narrowed to the fields we act on. */
interface SiteVerifyResponse {
	success?: boolean
	'error-codes'?: string[]
}

/**
 * Ask Turnstile whether a widget token is good. `remoteIp` is the client's real IP per
 * Cloudflare (`CF-Connecting-IP`), which Turnstile cross-checks against the one that
 * solved the challenge; it's omitted when absent rather than sent empty.
 *
 * A token is single-use, so a failed verdict means the widget has to be reset before the
 * player can retry — the client does that (see the signup form).
 *
 * Any failure to reach Turnstile is a rejection, not a pass: this is the only bot check
 * in front of signup, so a broken verdict path must not open the door.
 */
export async function verifyTurnstile(
	secretKey: string,
	token: string,
	remoteIp?: string
): Promise<boolean> {
	const fields: Record<string, string> = { secret: secretKey, response: token }
	if (remoteIp) fields.remoteip = remoteIp

	try {
		const res = await fetch(SITEVERIFY_URL, {
			method: 'POST',
			headers: { 'content-type': 'application/x-www-form-urlencoded' },
			body: new URLSearchParams(fields).toString(),
		})
		if (!res.ok) {
			logger.error('turnstile siteverify failed', { status: res.status })
			return false
		}
		const verdict = (await res.json()) as SiteVerifyResponse
		if (verdict.success !== true) {
			// The codes name the reason (`invalid-input-response`, `timeout-or-duplicate`,
			// `invalid-input-secret`, …) — the last of those is a misconfiguration, not a bot,
			// and this log line is the only place it shows up.
			logger.info('turnstile rejected a signup', { codes: verdict['error-codes'] ?? [] })
			return false
		}
		return true
	} catch (err) {
		logger.error('turnstile siteverify threw', { error: String(err) })
		return false
	}
}
