/**
 * Account storage on the shared `recflare` D1 database. Each account is a single
 * JSON blob in the `data` column; queryable fields (AccountId, Username) are
 * SQLite generated (virtual) columns extracted from that JSON and indexed —
 * the same JSON-blob pattern the `rooms` worker uses.
 *
 * The `auth` worker owns this schema/migration (see migrations/0001_accounts.sql,
 * applied with its own `migrations_table` so it doesn't clash with the rooms
 * migrations that share the database). Other workers bind the table read/write
 * and keep these helpers in sync.
 */

/** Schema DDL (mirror of migrations 0001_accounts + 0002_avatar, sans seed INSERTs). */
export const SCHEMA_DDL: string[] = [
	`CREATE TABLE IF NOT EXISTS accounts (
		data TEXT NOT NULL,
		avatar TEXT,
		account_id INTEGER GENERATED ALWAYS AS (json_extract(data, '$.accountId')) VIRTUAL,
		username_lower TEXT GENERATED ALWAYS AS (lower(json_extract(data, '$.username'))) VIRTUAL
	)`,
	`CREATE UNIQUE INDEX IF NOT EXISTS idx_accounts_account_id ON accounts (account_id)`,
	`CREATE INDEX IF NOT EXISTS idx_accounts_username_lower ON accounts (username_lower)`,
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
	/** Set via POST /account/me/email; absent until the player provides one. */
	email?: string
	/** Set via PUT /account/me/bio; read back via GET /account/:id/bio. */
	bio?: string
}

interface AccountRow {
	data: string
}

const parseOne = (row: AccountRow | null): Account | null =>
	row ? (JSON.parse(row.data) as Account) : null
const parseAll = (rows: AccountRow[]): Account[] => rows.map((r) => JSON.parse(r.data) as Account)

/** Word lists for auto-assigned usernames (players don't pick one on signup). */
const ADJECTIVES = [
	'Swift', 'Brave', 'Clever', 'Happy', 'Mighty', 'Lucky', 'Sunny', 'Cosmic',
	'Witty', 'Nimble', 'Jolly', 'Bold', 'Gentle', 'Fuzzy', 'Speedy', 'Shiny',
]
const NOUNS = [
	'Fox', 'Otter', 'Falcon', 'Panda', 'Tiger', 'Comet', 'Maple', 'Pixel',
	'Robin', 'Wolf', 'Koala', 'Dragon', 'Penguin', 'Badger', 'Heron', 'Lynx',
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
		await db.prepare('SELECT data FROM accounts WHERE account_id = ?1').bind(id).first<AccountRow>()
	)
}

/** Look up multiple accounts by AccountId (order not guaranteed). */
export async function getAccountsByIds(db: D1Database, ids: number[]): Promise<Account[]> {
	if (ids.length === 0) return []
	const placeholders = ids.map((_, i) => `?${i + 1}`).join(',')
	const { results } = await db
		.prepare(`SELECT data FROM accounts WHERE account_id IN (${placeholders})`)
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
		.prepare('UPDATE accounts SET data = ?2 WHERE account_id = ?1')
		.bind(id, data)
		.run()
	if (!res.meta.changes) {
		await db.prepare('INSERT INTO accounts (data) VALUES (?1)').bind(data).run()
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
		.prepare('SELECT COALESCE(MAX(account_id), 1) + 1 AS next FROM accounts')
		.first<{ next: number }>()
	const id = row?.next ?? 2
	const username = overrides.username ?? randomUsername()
	const account = defaultAccount(id, { username, displayName: username, ...overrides })
	await db.prepare('INSERT INTO accounts (data) VALUES (?1)').bind(JSON.stringify(account)).run()
	return account
}
