import type { HonoApp } from '@repo/hono-helpers'
import type { SharedHonoEnv, SharedHonoVariables } from '@repo/hono-helpers/src/types'

export type Env = SharedHonoEnv & {
	// Shared rooms/accounts D1 database. The `auth` worker owns the `accounts`
	// table (creates accounts on signup, seeds the system + Coach accounts).
	DB: D1Database
	// Shared match-presence KV (owned by the `match` worker). On account creation
	// the new player's presence is seeded to the Orientation room so the match
	// heartbeat keeps them there instead of bouncing them to the dorm.
	RECFLARE_MATCH_PRESENCE: KVNamespace
	// HS256 signing key for issued access tokens. Set as a Cloudflare secret
	// (`wrangler secret put JWT_SECRET`) in deployed environments and via `.dev.vars`
	// locally — never committed. `keep_vars` in wrangler.jsonc stops deploys from
	// clearing it.
	JWT_SECRET: string
}

/** Variables can be extended */
export type Variables = SharedHonoVariables

export interface App extends HonoApp {
	Bindings: Env
	Variables: Variables
}
