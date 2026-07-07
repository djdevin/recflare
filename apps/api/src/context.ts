import type { HonoApp } from '@repo/hono-helpers'
import type { SharedHonoEnv, SharedHonoVariables } from '@repo/hono-helpers/src/types'

export type Env = SharedHonoEnv & {
	// Shared Secrets Store binding for the HS256 JWT signing key. Resolve the value
	// with `await env.JWT_SECRET.get()`; all workers bind the same store so tokens
	// signed by `auth` verify here.
	JWT_SECRET: SecretsStoreSecret
	/**
	 * Base domain the share-link URL is derived from, e.g. `rec.example.com`.
	 * Injected at deploy time via `--var DOMAIN`; defaults in `wrangler.jsonc`
	 * for local dev and tests.
	 */
	DOMAIN: string
	// Shared rooms database (schema/migrations owned by the `rooms` worker). Used
	// read-only here to resolve room roles for `/api/rooms/v1/verifyRole`.
	DB: D1Database
	// Image bucket (shared with the `img` worker, which serves objects back by
	// key). Uploaded saved images are written here.
	IMAGES: R2Bucket
}

/** Variables can be extended */
export type Variables = SharedHonoVariables

export interface App extends HonoApp {
	Bindings: Env
	Variables: Variables
}
