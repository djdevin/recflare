import type { HonoApp } from '@repo/hono-helpers'
import type { SharedHonoEnv, SharedHonoVariables } from '@repo/hono-helpers/src/types'

export type Env = SharedHonoEnv & {
	// D1 database holding rooms (JSON blob + generated columns). See rooms-db.ts.
	DB: D1Database
	// Shared player-presence KV (owned by the `match` worker). Read here to resolve
	// the caller's current room instance for the photon access token — the
	// equivalent of the reference server's HeartbeatDB.GetPlayerHeartbeat.
	RECFLARE_MATCH_PRESENCE: KVNamespace
}

/** Variables can be extended */
export type Variables = SharedHonoVariables

export interface App extends HonoApp {
	Bindings: Env
	Variables: Variables
}
