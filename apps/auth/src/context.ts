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
	// Signup caps, both optional (see auth.app.ts for what each arm counts and why).
	// Unset falls back to the DEFAULT_MAX_ACCOUNTS_* constants there; 0 disables that arm.
	// Typed `string | number` because a var declared in wrangler.jsonc `vars` arrives as a
	// number while the same var set from the dashboard or `--var` arrives as a string —
	// read them through `intVar`, never as a bare number.
	MAX_ACCOUNTS_PER_PLATFORM_ID?: string | number
	MAX_ACCOUNTS_PER_IP?: string | number
}

/** Variables can be extended */
export type Variables = SharedHonoVariables

export interface App extends HonoApp {
	Bindings: Env
	Variables: Variables
}
