import type { HonoApp } from '@repo/hono-helpers'
import type { SharedHonoEnv, SharedHonoVariables } from '@repo/hono-helpers/src/types'

export type Env = SharedHonoEnv & {
	// Per-player presence (the room instance they're currently in). Written by
	// matchmake/goto, read by the heartbeat, cleared on login — mirrors the
	// reference server's HeartbeatDB.
	MATCH_PRESENCE: KVNamespace
}

/** Variables can be extended */
export type Variables = SharedHonoVariables

export interface App extends HonoApp {
	Bindings: Env
	Variables: Variables
}
