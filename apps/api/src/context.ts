import type { HonoApp } from '@repo/hono-helpers'
import type { SharedHonoEnv, SharedHonoVariables } from '@repo/hono-helpers/src/types'

export type Env = SharedHonoEnv & {
	/**
	 * Base domain the share-link URL is derived from, e.g. `rec.example.com`.
	 * Injected at deploy time via `--var DOMAIN`; defaults in `wrangler.jsonc`
	 * for local dev and tests.
	 */
	DOMAIN: string
	// Shared rooms database (schema/migrations owned by the `rooms` worker). Used
	// read-only here for the /roomserver/rooms/* endpoints.
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
