/**
 * Account storage on the shared `recflare` D1 database. Each account is a single
 * JSON blob in the `data` column; queryable fields (AccountId, Username) are
 * SQLite generated (virtual) columns extracted from that JSON and indexed —
 * the same JSON-blob pattern the `rooms` worker uses.
 *
 * The `auth` worker owns this schema/migration (see apps/auth/migrations/
 * 0001_accounts.sql, applied with its own `migrations_table` so it doesn't clash
 * with the rooms migrations that share the database). This module is the single
 * source of truth for the helpers; the `auth` and `accounts` workers both import
 * it from `@repo/domain` (each uses the subset it needs).
 */

/** Schema DDL (mirror of migrations 0001_accounts + 0002_avatar, sans seed INSERTs). */
export const SCHEMA_DDL: string[] = [
	`CREATE TABLE IF NOT EXISTS account (
		data TEXT NOT NULL,
		avatar TEXT,
		account_id INTEGER GENERATED ALWAYS AS (json_extract(data, '$.accountId')) VIRTUAL,
		username_lower TEXT GENERATED ALWAYS AS (lower(json_extract(data, '$.username'))) VIRTUAL,
		platform_id TEXT GENERATED ALWAYS AS (json_extract(data, '$.platformId')) VIRTUAL
	)`,
	`CREATE UNIQUE INDEX IF NOT EXISTS idx_accounts_account_id ON account (account_id)`,
	`CREATE INDEX IF NOT EXISTS idx_accounts_username_lower ON account (username_lower)`,
	`CREATE INDEX IF NOT EXISTS idx_accounts_platform_id ON account (platform_id)`,
]

/** Client-facing account shape (camelCase, exactly as the client's AccountDTO). */
export interface Account {
	accountId: number
	username: string
	displayName: string
	profileImage: string
	isJunior: boolean
	platforms: number
	personalPronouns: number
	identityFlags: number
	createdAt: string
	/**
	 * The platform-native identity linked to this account (e.g. a SteamID64 for
	 * platform 0). Stored as a STRING on purpose — a SteamID64 exceeds 2^53 and
	 * would lose precision as a JS number. Set at account creation from the login's
	 * `platform_id`. A cached login is authorized ONLY to the account whose stored
	 * `platformId` matches the (platform_auth-ticket-proven) platform id presented,
	 * so no one but that platform user can log into the account.
	 */
	platformId?: string
	/** PlatformType int (0 = Steam) that `platformId` belongs to. */
	platform?: number
	/** ISO-8601 time of the account's most recent successful login. */
	lastLoginTime?: string
	/** Set via POST /account/me/email; absent until the player provides one. */
	email?: string
	/** Set via POST /account/me/phone; absent until the player provides one. */
	phone?: string
	/** Set via PUT /account/me/bio; read back via GET /account/:id/bio. */
	bio?: string
	/**
	 * Hardware/install id the client last reported (POST /api/PlayerReporting/v1/deviceId).
	 * The client rotates it — it posts the id it believes we hold plus the new one —
	 * so this is simply the most recent value it told us about, not a proven identity.
	 */
	deviceId?: string
	/** Remaining username changes; decremented by PUT /account/me/username. */
	availableUsernameChanges?: number
	/**
	 * PBKDF2 `salt:hash` for credential login; set via /account/me/changepassword
	 * or create_account. Kept in the JSON blob but never projected into a public
	 * DTO (the DTO builders pick only known fields), so it doesn't leak.
	 */
	passwordHash?: string
}

interface AccountRow {
	data: string
}

const parseOne = (row: AccountRow | null): Account | null =>
	row ? (JSON.parse(row.data) as Account) : null
const parseAll = (rows: AccountRow[]): Account[] => rows.map((r) => JSON.parse(r.data) as Account)

/** Word lists for auto-assigned usernames (players don't pick one on signup). */
const ADJECTIVES = [
	'Swift',
	'Brave',
	'Clever',
	'Happy',
	'Mighty',
	'Lucky',
	'Sunny',
	'Cosmic',
	'Witty',
	'Nimble',
	'Jolly',
	'Bold',
	'Gentle',
	'Fuzzy',
	'Speedy',
	'Shiny',
]
const NOUNS = [
	'Fox',
	'Otter',
	'Falcon',
	'Panda',
	'Tiger',
	'Comet',
	'Maple',
	'Pixel',
	'Robin',
	'Wolf',
	'Koala',
	'Dragon',
	'Penguin',
	'Badger',
	'Heron',
	'Lynx',
]

/** A random, readable username (e.g. "SwiftFox4821"). */
export function randomUsername(): string {
	const adj = ADJECTIVES[Math.floor(Math.random() * ADJECTIVES.length)]
	const noun = NOUNS[Math.floor(Math.random() * NOUNS.length)]
	const n = Math.floor(Math.random() * 10000)
	return `${adj}${noun}${n}`
}

/**
 * Build a full account object from an id, applying default fallbacks for any
 * column the caller doesn't override. Used both to synthesize accounts that
 * aren't in the DB and as the base for a freshly created account.
 */
export function defaultAccount(id: number, overrides: Partial<Account> = {}): Account {
	return {
		accountId: id,
		username: `Player${id}`,
		displayName: `Player${id}`,
		profileImage: 'DefaultProfileImage.jpg',
		isJunior: false,
		platforms: 0,
		personalPronouns: 0,
		identityFlags: 0,
		createdAt: new Date().toISOString(),
		...overrides,
	}
}

/** Look up a single account by AccountId. */
export async function getAccount(db: D1Database, id: number): Promise<Account | null> {
	return parseOne(
		await db.prepare('SELECT data FROM account WHERE account_id = ?1').bind(id).first<AccountRow>()
	)
}

/** Look up a single account by username (case-insensitive), or null if none. */
export async function getAccountByUsername(
	db: D1Database,
	username: string
): Promise<Account | null> {
	return parseOne(
		await db
			.prepare('SELECT data FROM account WHERE username_lower = ?1')
			.bind(username.toLowerCase())
			.first<AccountRow>()
	)
}

/** Default cap on how many matches `searchAccounts` returns. */
export const SEARCH_LIMIT = 20

/** Escape LIKE wildcards so user input is matched literally (using `\` as the escape char). */
const escapeLike = (s: string): string => s.replace(/[\\%_]/g, '\\$&')

/**
 * Prefix-search accounts by username (case-insensitive, "begins with"), ordered
 * alphabetically. Backed by the indexed `username_lower` generated column, so the
 * `name%` LIKE stays index-friendly. Returns up to `limit` matches.
 */
export async function searchAccounts(
	db: D1Database,
	name: string,
	limit = SEARCH_LIMIT
): Promise<Account[]> {
	const q = name.trim().toLowerCase()
	if (q === '') return []
	const { results } = await db
		.prepare(
			`SELECT data FROM account WHERE username_lower LIKE ?1 ESCAPE '\\' ORDER BY username_lower LIMIT ?2`
		)
		.bind(`${escapeLike(q)}%`, limit)
		.all<AccountRow>()
	return parseAll(results)
}

/**
 * Accounts linked to a platform-native id (e.g. a SteamID64), for the cached-login
 * account picker. Backed by the indexed `platform_id` generated column. Empty id
 * yields no matches (avoids matching every account whose `platformId` is null).
 */
export async function getAccountsByPlatformId(
	db: D1Database,
	platformId: string
): Promise<Account[]> {
	if (platformId === '') return []
	const { results } = await db
		.prepare('SELECT data FROM account WHERE platform_id = ?1')
		.bind(platformId)
		.all<AccountRow>()
	return parseAll(results)
}

/** Record the account's most recent successful login time (ISO-8601). */
export async function setLastLoginTime(db: D1Database, id: number, time: string): Promise<void> {
	await db
		.prepare("UPDATE account SET data = json_set(data, '$.lastLoginTime', ?2) WHERE account_id = ?1")
		.bind(id, time)
		.run()
}

/** Record the device id the client last reported. False when no such account exists. */
export async function setDeviceId(db: D1Database, id: number, deviceId: string): Promise<boolean> {
	const { meta } = await db
		.prepare("UPDATE account SET data = json_set(data, '$.deviceId', ?2) WHERE account_id = ?1")
		.bind(id, deviceId)
		.run()
	return meta.changes > 0
}

/** Look up multiple accounts by AccountId (order not guaranteed). */
export async function getAccountsByIds(db: D1Database, ids: number[]): Promise<Account[]> {
	if (ids.length === 0) return []
	const placeholders = ids.map((_, i) => `?${i + 1}`).join(',')
	const { results } = await db
		.prepare(`SELECT data FROM account WHERE account_id IN (${placeholders})`)
		.bind(...ids)
		.all<AccountRow>()
	return parseAll(results)
}

/**
 * Merge `overrides` into the account row for `id` and persist it. Reads the
 * current account (falling back to a synthesized default), applies the
 * overrides, and writes the whole JSON blob back — inserting the row when the
 * account isn't in the table yet. Returns the updated account.
 */
export async function updateAccount(
	db: D1Database,
	id: number,
	overrides: Partial<Account>
): Promise<Account> {
	const current = (await getAccount(db, id)) ?? defaultAccount(id)
	const updated: Account = { ...current, ...overrides, accountId: id }
	const data = JSON.stringify(updated)
	const res = await db
		.prepare('UPDATE account SET data = ?2 WHERE account_id = ?1')
		.bind(id, data)
		.run()
	if (!res.meta.changes) {
		await db.prepare('INSERT INTO account (data) VALUES (?1)').bind(data).run()
	}
	return updated
}

/**
 * Create and persist a new account. The id is the next free integer (above the
 * seeded system accounts); the username is auto-assigned (players don't choose
 * one initially) and the display name defaults to it.
 */
export async function createAccount(
	db: D1Database,
	overrides: Partial<Account> = {}
): Promise<Account> {
	const row = await db
		.prepare('SELECT COALESCE(MAX(account_id), 1) + 1 AS next FROM account')
		.first<{ next: number }>()
	const id = row?.next ?? 2
	const username = overrides.username ?? randomUsername()
	const account = defaultAccount(id, { username, displayName: username, ...overrides })
	await db.prepare('INSERT INTO account (data) VALUES (?1)').bind(JSON.stringify(account)).run()
	return account
}

/**
 * Read the account's stored password hash (`salt:hash`), or null when the account
 * has none / doesn't exist. Kept in the account JSON blob but out of the public
 * account DTO (which projects only known fields), so it never leaks.
 */
export async function getPasswordHash(db: D1Database, id: number): Promise<string | null> {
	const row = await db
		.prepare(
			"SELECT json_extract(data, '$.passwordHash') AS hash FROM account WHERE account_id = ?1"
		)
		.bind(id)
		.first<{ hash: string | null }>()
	return row?.hash ?? null
}

/** Persist the account's password hash. Returns false when no such account exists. */
export async function setPasswordHash(db: D1Database, id: number, hash: string): Promise<boolean> {
	const { meta } = await db
		.prepare(
			"UPDATE account SET data = json_set(data, '$.passwordHash', ?2) WHERE account_id = ?1"
		)
		.bind(id, hash)
		.run()
	return meta.changes > 0
}
