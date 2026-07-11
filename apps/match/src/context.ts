import type { HonoApp } from '@repo/hono-helpers'
import type { SharedHonoEnv, SharedHonoVariables } from '@repo/hono-helpers/src/types'

export type Env = SharedHonoEnv & {
	// Shared Secrets Store binding for the HS256 JWT signing key. Resolve the value
	// with `await env.JWT_SECRET.get()`; all workers bind the same store so tokens
	// signed by `auth` verify here.
	JWT_SECRET: SecretsStoreSecret
	// Shared `recflare` DB. Resolves room scenes for matchmaking (read), writes a
	// player's personal dorm room on first entry, and holds player presence — the
	// room instance each player is currently in (written by matchmake/heartbeat,
	// read by the heartbeat and the batch `/player` lookup). See @repo/domain's
	// presence-db (table owned/migrated by the `rooms` worker).
	DB: D1Database
}

/** Variables can be extended */
export type Variables = SharedHonoVariables

export interface App extends HonoApp {
	Bindings: Env
	Variables: Variables
}
