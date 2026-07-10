/**
 * Avatar storage on the shared `recflare` accounts table. The avatar is a single
 * JSON payload the client sends/consumes and never queries on, so it lives in a
 * dedicated nullable `avatar` TEXT column on the player's account row (added by
 * the auth worker's migration 0002_avatar).
 *
 * The `auth` worker owns the accounts schema/migrations; econ only reads/writes
 * the avatar column. SCHEMA_DDL mirrors the table so tests can build it without
 * depending on the auth worker — keep it in sync with @repo/domain's accounts-db.ts.
 */

/** Schema DDL for tests — the accounts table including the avatar column. */
export const SCHEMA_DDL: string[] = [
	`CREATE TABLE IF NOT EXISTS account (
		data TEXT NOT NULL,
		avatar TEXT,
		account_id INTEGER GENERATED ALWAYS AS (json_extract(data, '$.accountId')) VIRTUAL,
		username_lower TEXT GENERATED ALWAYS AS (lower(json_extract(data, '$.username'))) VIRTUAL
	)`,
	`CREATE UNIQUE INDEX IF NOT EXISTS idx_accounts_account_id ON account (account_id)`,
]

/** The stored avatar payload — opaque JSON the client sets and reads back. */
export type Avatar = Record<string, unknown>

interface AvatarRow {
	avatar: string | null
}

/** Read the player's stored avatar, or null when they have none yet. */
export async function getAvatar(db: D1Database, accountId: number): Promise<Avatar | null> {
	const row = await db
		.prepare('SELECT avatar FROM account WHERE account_id = ?1')
		.bind(accountId)
		.first<AvatarRow>()
	return row?.avatar ? (JSON.parse(row.avatar) as Avatar) : null
}

/**
 * Persist the player's avatar onto their account row. Returns false when no
 * account row exists for the id (nothing was updated).
 */
export async function setAvatar(
	db: D1Database,
	accountId: number,
	avatar: Avatar
): Promise<boolean> {
	const { meta } = await db
		.prepare('UPDATE account SET avatar = ?2 WHERE account_id = ?1')
		.bind(accountId, JSON.stringify(avatar))
		.run()
	return meta.changes > 0
}
