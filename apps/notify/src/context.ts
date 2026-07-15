import type { HonoApp } from '@repo/hono-helpers'
import type { SharedHonoEnv, SharedHonoVariables } from '@repo/hono-helpers/src/types'
import type { NotificationsHub } from './notifications-hub'

export type Env = SharedHonoEnv & {
	/** Durable Object hosting the SignalR notifications hub. */
	RECFLARE_NOTIFICATIONS_HUB: DurableObjectNamespace<NotificationsHub>
	/**
	 * HS256 JWT signing key, read with `await env.JWT_SECRET.get()`; all workers
	 * bind the same store so tokens signed by `auth` verify here. Used to gate the
	 * internal send/broadcast endpoints.
	 */
	JWT_SECRET: SecretsStoreSecret
}

/** Variables can be extended */
export type Variables = SharedHonoVariables

export interface App extends HonoApp {
	Bindings: Env
	Variables: Variables
}
