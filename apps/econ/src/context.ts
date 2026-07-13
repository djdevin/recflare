import type { HonoApp } from '@repo/hono-helpers'
import type { SharedHonoEnv, SharedHonoVariables } from '@repo/hono-helpers/src/types'
// Type-only import (erased at build) of the DO class owned by the `notify` worker, so
// the RPC methods on the hub binding are typed here.
import type { NotificationsHub } from '../../notify/src/notifications-hub'

export type Env = SharedHonoEnv & {
	// Shared Secrets Store binding for the HS256 JWT signing key. Resolve the value
	// with `await env.JWT_SECRET.get()`; all workers bind the same store so tokens
	// signed by `auth` verify here.
	JWT_SECRET: SecretsStoreSecret
	/** Shared `recflare` D1: the accounts table (avatar) + this worker's reward_selection. */
	DB: D1Database
	/** Static storefront catalogs (`static/storefronts/sf*.json`), fetched by path. */
	ASSETS: Fetcher
	/** Notifications hub (DO in `notify`) — game rewards are pushed over the websocket. */
	RECFLARE_NOTIFICATIONS_HUB: DurableObjectNamespace<NotificationsHub>
}

/** Variables can be extended */
export type Variables = SharedHonoVariables

export interface App extends HonoApp {
	Bindings: Env
	Variables: Variables
}
