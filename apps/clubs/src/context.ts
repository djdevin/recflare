import type { HonoApp } from '@repo/hono-helpers'
import type { SharedHonoEnv, SharedHonoVariables } from '@repo/hono-helpers/src/types'

export type Env = SharedHonoEnv & {
	// Shared Secrets Store binding for the HS256 JWT signing key. Resolve the value
	// with `await env.JWT_SECRET.get()`; all workers bind the same store so tokens
	// signed by `auth` verify here.
	JWT_SECRET: SecretsStoreSecret
	// Shared `recflare` D1 database holding the club / club_member tables. See clubs-db.ts.
	DB: D1Database
	// How many clubs one account may create (optional). Unset falls back to
	// DEFAULT_MAX_CLUBS_PER_ACCOUNT in clubs.app.ts; 0 lifts the cap. Typed
	// `string | number` because a var declared in wrangler.jsonc `vars` arrives as a
	// number while the same var set from the dashboard or `--var` arrives as a string —
	// read it through `intVar`, never as a bare number.
	MAX_CLUBS_PER_ACCOUNT?: string | number
	// add additional Bindings here
}

/** Variables can be extended */
export type Variables = SharedHonoVariables

export interface App extends HonoApp {
	Bindings: Env
	Variables: Variables
}
