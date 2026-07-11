/**
 * Player presence — the room instance a player is currently in, plus the status
 * fields the match heartbeat echoes back. Stored on the shared `recflare` D1 with
 * the same JSON-blob pattern as the rooms/room_instance tables: the full presence
 * is a JSON blob in `data`, and the fields we query on (account_id,
 * room_instance_id, room_id, expires_at) are SQLite generated (virtual) columns
 * extracted from it. One row per account (unique `account_id`); writes upsert via
 * `INSERT OR REPLACE`.
 *
 * The `match` worker owns presence — written on matchmake/heartbeat, read by the
 * heartbeat and the batch `/player` lookup. The `auth` worker seeds it for new
 * players (Orientation) and the `rooms` worker reads it (Photon access token). All
 * three import these helpers from `@repo/domain`; the `rooms` worker owns the
 * schema (migrations/0006_presence.sql).
 *
 * This replaces the old match-presence KV. D1 gives strong reads (no cross-PoP
 * staleness that would read presence as out-of-sync and bounce the player), a
 * single-query batch lookup for `/player`, and lets matchmaking count players per
 * instance (see {@link countPlayersInInstance}). Rows carry an absolute
 * `expiresAt` (epoch seconds); reads filter expired rows out and
 * {@link deleteExpiredPresence} purges them.
 */

/** Presence is kept this long (s) after the last matchmake/heartbeat refresh. */
export const PRESENCE_TTL_SECONDS = 900

/** Schema DDL (mirror of migrations/0006_presence.sql). */
export const PRESENCE_SCHEMA_DDL: string[] = [
	`CREATE TABLE IF NOT EXISTS presence (
		data TEXT NOT NULL,
		account_id INTEGER GENERATED ALWAYS AS (json_extract(data, '$.accountId')) VIRTUAL,
		room_instance_id INTEGER GENERATED ALWAYS AS (json_extract(data, '$.roomInstance.roomInstanceId')) VIRTUAL,
		room_id INTEGER GENERATED ALWAYS AS (json_extract(data, '$.roomInstance.roomId')) VIRTUAL,
		expires_at INTEGER GENERATED ALWAYS AS (json_extract(data, '$.expiresAt')) VIRTUAL
	)`,
	`CREATE UNIQUE INDEX IF NOT EXISTS idx_presence_account ON presence (account_id)`,
	`CREATE INDEX IF NOT EXISTS idx_presence_room_instance ON presence (room_instance_id)`,
	`CREATE INDEX IF NOT EXISTS idx_presence_expires ON presence (expires_at)`,
]

/**
 * The presence a caller writes — the room instance the player is in plus the
 * status fields the heartbeat echoes. Generic over the room-instance shape so each
 * worker keeps its own typing (`match` its full instance, `rooms` just the id).
 */
export interface PresenceInput<TRoomInstance = unknown> {
	accountId: number
	roomInstance: TRoomInstance | null
	statusVisibility: number
	deviceClass: number
	vrMovementMode: number
	platform: number
	appVersion: string
}

/** A stored presence row — the input plus its absolute expiry (epoch seconds). */
export interface StoredPresence<TRoomInstance = unknown> extends PresenceInput<TRoomInstance> {
	expiresAt: number
}

const nowSeconds = () => Math.floor(Date.now() / 1000)

/**
 * Upsert a player's presence, stamping a fresh absolute expiry (now +
 * PRESENCE_TTL_SECONDS). One row per account: `INSERT OR REPLACE` resolves on the
 * unique `account_id` index. Returns the stored row (with its new expiry).
 */
export async function setPresence<TRoomInstance>(
	db: D1Database,
	input: PresenceInput<TRoomInstance>
): Promise<StoredPresence<TRoomInstance>> {
	const stored: StoredPresence<TRoomInstance> = {
		...input,
		expiresAt: nowSeconds() + PRESENCE_TTL_SECONDS,
	}
	await db
		.prepare('INSERT OR REPLACE INTO presence (data) VALUES (?1)')
		.bind(JSON.stringify(stored))
		.run()
	return stored
}

/** Read a player's live presence, or null when they're absent or expired. */
export async function getPresence<TRoomInstance>(
	db: D1Database,
	accountId: number,
	now = nowSeconds()
): Promise<StoredPresence<TRoomInstance> | null> {
	const row = await db
		.prepare('SELECT data FROM presence WHERE account_id = ?1 AND expires_at > ?2')
		.bind(accountId, now)
		.first<{ data: string }>()
	return row ? (JSON.parse(row.data) as StoredPresence<TRoomInstance>) : null
}

/**
 * Read many players' live presence in one query, keyed by account id (absent or
 * expired players are simply missing from the map). Replaces the N point reads the
 * batch `/player?id=…` lookup did against KV.
 */
export async function getPresences<TRoomInstance>(
	db: D1Database,
	accountIds: number[],
	now = nowSeconds()
): Promise<Map<number, StoredPresence<TRoomInstance>>> {
	const out = new Map<number, StoredPresence<TRoomInstance>>()
	if (accountIds.length === 0) return out
	const placeholders = accountIds.map((_, i) => `?${i + 1}`).join(', ')
	const { results } = await db
		.prepare(
			`SELECT data FROM presence
			 WHERE account_id IN (${placeholders}) AND expires_at > ?${accountIds.length + 1}`
		)
		.bind(...accountIds, now)
		.all<{ data: string }>()
	for (const r of results) {
		const p = JSON.parse(r.data) as StoredPresence<TRoomInstance>
		out.set(p.accountId, p)
	}
	return out
}

/**
 * How many players are currently in a room instance — the live head-count
 * matchmaking can use to spread players and avoid full instances (something KV
 * couldn't answer without scanning every key). Counts only unexpired presence.
 */
export async function countPlayersInInstance(
	db: D1Database,
	roomInstanceId: number,
	now = nowSeconds()
): Promise<number> {
	const row = await db
		.prepare('SELECT COUNT(*) AS n FROM presence WHERE room_instance_id = ?1 AND expires_at > ?2')
		.bind(roomInstanceId, now)
		.first<{ n: number }>()
	return row?.n ?? 0
}

/**
 * Purge expired presence rows — housekeeping only, since reads already ignore them
 * (and `INSERT OR REPLACE` keeps a single row per account, so the table is bounded
 * by account count). Returns the number of rows removed.
 */
export async function deleteExpiredPresence(db: D1Database, now = nowSeconds()): Promise<number> {
	const res = await db.prepare('DELETE FROM presence WHERE expires_at <= ?1').bind(now).run()
	return res.meta.changes ?? 0
}
