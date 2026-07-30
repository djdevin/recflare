import type { HonoApp } from '@repo/hono-helpers'
import type { SharedHonoEnv, SharedHonoVariables } from '@repo/hono-helpers/src/types'

export type Env = SharedHonoEnv & {
	/** Base domain the auth/accounts hosts are derived from (see wrangler.jsonc). */
	DOMAIN: string
	/** Static-asset fetcher for the built React SPA (see wrangler.jsonc `assets`). */
	ASSETS: Fetcher
	/**
	 * The Turnstile widget's public site key, injected as a var from the operator's .env
	 * (`RECFLARE_TURNSTILE_SITE_KEY`). Public by design — it ships to the browser so the
	 * widget can render.
	 */
	TURNSTILE_SITE_KEY?: string
	/**
	 * The Turnstile widget's secret key — a real secret, so it is NOT a var: set it on the
	 * worker with `wrangler secret put TURNSTILE_SECRET_KEY --name www` (secrets survive a
	 * deploy; vars are replaced wholesale), and in `.dev.vars` for local dev.
	 *
	 * Both keys unset falls back to Turnstile's test keypair locally, and closes web signup
	 * everywhere else — see src/turnstile.ts.
	 */
	TURNSTILE_SECRET_KEY?: string
}

/** Variables can be extended */
export type Variables = SharedHonoVariables

export interface App extends HonoApp {
	Bindings: Env
	Variables: Variables
}
