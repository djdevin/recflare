import type { HonoApp } from '@repo/hono-helpers'
import type { SharedHonoEnv, SharedHonoVariables } from '@repo/hono-helpers/src/types'

export type Env = SharedHonoEnv & {
	/** Per-player settings store. Key `player:<id>` → JSON map of `{ key: value }`. */
	PLAYER_SETTINGS: KVNamespace
}

/** Variables can be extended */
export type Variables = SharedHonoVariables

export interface App extends HonoApp {
	Bindings: Env
	Variables: Variables
}
