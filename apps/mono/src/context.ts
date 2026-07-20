import type { SharedHonoEnv, SharedHonoVariables } from '@repo/hono-helpers/src/types'

/**
 * Union of every mounted worker's bindings.
 *
 * Because the split workers already share the same underlying resources — one
 * `recflare` D1, one Secrets Store, the shared R2 buckets, the single KV namespace and
 * the Notifications Durable Object — this is a de-duplicated union, not a migration.
 * Each mounted app reads only the subset it needs; a superset `Env` is assignable to
 * each app's narrower `Env`, so the sub-apps type-check unchanged.
 */
export type Env = SharedHonoEnv & {
	// HS256 JWT signing key (shared Secrets Store). Tokens signed by `auth` verify everywhere.
	JWT_SECRET: SecretsStoreSecret
	// Shared `recflare` database (accounts, auth, api, clubs, match, rooms, …).
	DB: D1Database
	// Image storage bucket (api, img).
	IMAGES: R2Bucket
	// Binary room-data CDN bucket (cdn, rooms, storage).
	CDN_ASSETS: R2Bucket
	// Per-player settings (playersettings).
	RECFLARE_PLAYER_SETTINGS: KVNamespace
	// Real-time notifications hub. The class is defined in `notify` and re-exported by
	// this worker's entry so the binding resolves in-process (no `script_name`).
	RECFLARE_NOTIFICATIONS_HUB: DurableObjectNamespace
}

export type Variables = SharedHonoVariables
