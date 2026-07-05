import type { HonoApp } from '@repo/hono-helpers'
import type { SharedHonoEnv, SharedHonoVariables } from '@repo/hono-helpers/src/types'

export type Env = SharedHonoEnv & {
	/** Shared `recflare` D1 — the `images` metadata table this worker owns. */
	DB: D1Database
	/** R2 bucket holding the served image objects, keyed by filename. */
	IMAGES: R2Bucket
	/** Static assets (fallback images) served from `static/`. */
	ASSETS: Fetcher
	/**
	 * RSA-2048 private key (PKCS8 DER, base64) used to sign image responses
	 * requested with `?sig=p1`. Optional — when absent, responses are unsigned.
	 */
	IMG_SIGNING_KEY?: string
}

/** Variables can be extended */
export type Variables = SharedHonoVariables

export interface App extends HonoApp {
	Bindings: Env
	Variables: Variables
}
