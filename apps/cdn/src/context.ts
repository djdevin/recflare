import type { HonoApp } from '@repo/hono-helpers'
import type { SharedHonoEnv, SharedHonoVariables } from '@repo/hono-helpers/src/types'

export type Env = SharedHonoEnv & {
	// R2 bucket holding CDN binaries: signature blobs under `sigs/<name>` and
	// room build data under `room/<name>`.
	CDN_ASSETS: R2Bucket
}

/** Variables can be extended */
export type Variables = SharedHonoVariables

export interface App extends HonoApp {
	Bindings: Env
	Variables: Variables
}
