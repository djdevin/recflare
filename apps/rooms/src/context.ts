import type { HonoApp } from '@repo/hono-helpers'
import type { SharedHonoEnv, SharedHonoVariables } from '@repo/hono-helpers/src/types'
// Type-only import (erased at build) of the DO class owned by the `notify`
// worker, so the cross-worker RPC stub is fully typed.
import type { NotificationsHub } from '../../notify/src/notifications-hub'

export type Env = SharedHonoEnv & {
	// Shared Secrets Store binding for the HS256 JWT signing key. Resolve the value
	// with `await env.JWT_SECRET.get()`; all workers bind the same store so tokens
	// signed by `auth` verify here.
	JWT_SECRET: SecretsStoreSecret
	// D1 database holding rooms (JSON blob + generated columns). See rooms-db.ts.
	DB: D1Database
	// Shared player-presence KV (owned by the `match` worker). Read here to resolve
	// the caller's current room instance for the photon access token — the
	// equivalent of the reference server's HeartbeatDB.GetPlayerHeartbeat.
	RECFLARE_MATCH_PRESENCE: KVNamespace
	// SignalR notifications hub (DO owned by the `notify` worker). Bound here to
	// push RoomUpdate notifications when a room is mutated.
	RECFLARE_NOTIFICATIONS_HUB: DurableObjectNamespace<NotificationsHub>
}

/** Variables can be extended */
export type Variables = SharedHonoVariables

export interface App extends HonoApp {
	Bindings: Env
	Variables: Variables
}
