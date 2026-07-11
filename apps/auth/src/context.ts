import type { HonoApp } from '@repo/hono-helpers'
import type { SharedHonoEnv, SharedHonoVariables } from '@repo/hono-helpers/src/types'

export type Env = SharedHonoEnv & {
	// Shared rooms/accounts D1 database. The `auth` worker owns the `accounts`
	// table (creates accounts on signup, seeds the system + Coach accounts). Also
	// seeds new players' presence to the Orientation room (the shared `presence`
	// table, see @repo/domain) so the match heartbeat keeps them there.
	DB: D1Database
	// Shared Secrets Store binding for the HS256 signing key. Resolve the value with
	// `await env.JWT_SECRET.get()`. Every worker binds the same store, so tokens
	// signed here verify in all of them. Provisioned via `wrangler secrets-store`;
	// the store id is spliced into wrangler.jsonc at deploy time (RECFLARE_SECRETS_STORE).
	JWT_SECRET: SecretsStoreSecret
}

/** Variables can be extended */
export type Variables = SharedHonoVariables

export interface App extends HonoApp {
	Bindings: Env
	Variables: Variables
}
