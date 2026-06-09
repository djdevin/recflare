import type { NotificationsHub } from './notifications-hub'
import type { HonoApp } from '@repo/hono-helpers'
import type { SharedHonoEnv, SharedHonoVariables } from '@repo/hono-helpers/src/types'

export type Env = SharedHonoEnv & {
	/** Durable Object hosting the SignalR notifications hub. */
	NOTIFICATIONS_HUB: DurableObjectNamespace<NotificationsHub>
}

/** Variables can be extended */
export type Variables = SharedHonoVariables

export interface App extends HonoApp {
	Bindings: Env
	Variables: Variables
}
