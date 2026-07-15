import type { HonoApp } from '@repo/hono-helpers'
import type { SharedHonoEnv, SharedHonoVariables } from '@repo/hono-helpers/src/types'
// Type-only import (erased at build) of the DO class owned by the `notify` worker,
// so this worker can push websocket notifications through its RPC surface.
import type { NotificationsHub } from '../../notify/src/notifications-hub'

export type Env = SharedHonoEnv & {
	// Shared Secrets Store binding for the HS256 JWT signing key. Resolve the value
	// with `await env.JWT_SECRET.get()`; all workers bind the same store so tokens
	// signed by `auth` verify here.
	JWT_SECRET: SecretsStoreSecret
	/** Shared `recflare` D1 (accounts table) — stores the player's avatar. */
	DB: D1Database
	/** Static storefront catalogs (`static/storefronts/sf*.json`), fetched by path. */
	ASSETS: Fetcher
	/** The `notify` worker's NotificationsHub DO — push websocket notifications to a player. */
	RECFLARE_NOTIFICATIONS_HUB: DurableObjectNamespace<NotificationsHub>
	/**
	 * The RecCenterTokens a new player is granted (see balance-db.ts). Optional — unset
	 * falls back to DEFAULT_STARTING_TOKENS, and 0 means players start broke.
	 *
	 * Typed `string | number` because a var declared in wrangler.jsonc `vars` arrives as a
	 * number while the same var set from the dashboard or `--var` arrives as a string —
	 * read it through `intVar`, never as a bare number.
	 */
	STARTING_TOKENS?: string | number
}

/** Variables can be extended */
export type Variables = SharedHonoVariables

export interface App extends HonoApp {
	Bindings: Env
	Variables: Variables
}
