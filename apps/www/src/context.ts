import type { HonoApp } from '@repo/hono-helpers'
import type { SharedHonoEnv, SharedHonoVariables } from '@repo/hono-helpers/src/types'

export type Env = SharedHonoEnv & {
	/** Base domain the auth/accounts hosts are derived from (see wrangler.jsonc). */
	DOMAIN: string
	/** Static-asset fetcher for the built React SPA (see wrangler.jsonc `assets`). */
	ASSETS: Fetcher
	/**
	 * The Turnstile widget's public site key. Public by design — it ships to the browser so
	 * the widget can render — but kept alongside its secret as a worker secret rather than a
	 * var, so one pair of commands configures signup and there's a single place to look.
	 *
	 *   wrangler secret put TURNSTILE_SITE_KEY --name www
	 */
	TURNSTILE_SITE_KEY?: string
	/**
	 * The Turnstile widget's secret key — the one that turns a widget token into a verdict.
	 *
	 *   wrangler secret put TURNSTILE_SECRET_KEY --name www
	 *
	 * Secrets survive a deploy (vars are replaced wholesale), so both are set once and left
	 * alone. Locally they come from `apps/www/.dev.vars`. Either one unset closes web
	 * signup — see src/turnstile.ts.
	 */
	TURNSTILE_SECRET_KEY?: string
}

/** Variables can be extended */
export type Variables = SharedHonoVariables

export interface App extends HonoApp {
	Bindings: Env
	Variables: Variables
}
