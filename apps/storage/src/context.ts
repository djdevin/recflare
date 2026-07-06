import type { HonoApp } from '@repo/hono-helpers'
import type { SharedHonoEnv, SharedHonoVariables } from '@repo/hono-helpers/src/types'

export type Env = SharedHonoEnv & {
	// Shared CDN R2 bucket (`recflare-cdn`, owned by the `cdn` worker). Client
	// uploads are written here under a per-FileType subfolder; the `cdn` worker
	// serves them back.
	CDN_ASSETS: R2Bucket
}

/** Variables can be extended */
export type Variables = SharedHonoVariables

export interface App extends HonoApp {
	Bindings: Env
	Variables: Variables
}
