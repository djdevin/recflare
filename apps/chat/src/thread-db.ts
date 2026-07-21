/**
 * Chat threads and their membership on the shared `recflare` D1 database. A thread is a
 * conversation — a DM pair, a named group chat, or a system thread; the messages in it
 * live in `message` (see message-db.ts).
 *
 * Membership (`thread_member`) does double duty: it is the authorization gate — a
 * player may read or post to a thread only if they hold a row — and it is what renders
 * the `playerIds` array the client shows. Nothing here has a foreign key to accounts,
 * here or on a message's sender: that table belongs to the `auth` worker, and a thread
 * outlives the accounts in it.
 *
 * The thread denormalizes `latest_message_id` so the thread list renders from one
 * indexed row per thread rather than a per-thread MAX() over `message`, and so it can
 * be ordered by recency without a join — message ids are monotonic, so the highest id
 * is the newest thread. `postMessage` keeps it in sync.
 *
 * The per-viewer fields — `lastReadMessageId`, `snoozedUntil`, `isFavorited` — live on
 * the membership row, not the thread: two players in one DM have independent read
 * positions, snoozes, and favorites.
 *
 * The `chat` worker owns this schema/migration (migrations/0002_thread.sql).
 * `THREAD_SCHEMA_DDL` mirrors it so tests can build the tables directly.
 */

import { insertMessage } from './message-db'

import type { ChatMessage, NewChatMessage } from './message-db'

/** Schema DDL (mirror of migrations/0002_thread.sql). */
export const THREAD_SCHEMA_DDL: string[] = [
	`CREATE TABLE IF NOT EXISTS message_thread (
		chat_thread_id INTEGER PRIMARY KEY AUTOINCREMENT,
		chat_thread_name TEXT,
		latest_message_id INTEGER,
		created_at TEXT NOT NULL
	)`,
	`CREATE INDEX IF NOT EXISTS idx_message_thread_latest ON message_thread (latest_message_id)`,
	`CREATE TABLE IF NOT EXISTS thread_member (
		chat_thread_id INTEGER NOT NULL,
		player_id INTEGER NOT NULL,
		last_read_message_id INTEGER,
		snoozed_until TEXT,
		is_favorited INTEGER NOT NULL DEFAULT 0,
		PRIMARY KEY (chat_thread_id, player_id)
	)`,
	// The thread-list query is "every thread this player is in", so player_id leads.
	`CREATE INDEX IF NOT EXISTS idx_thread_member_player ON thread_member (player_id)`,
]

/**
 * A thread as the client receives it: the thread, its members, its most recent message,
 * and the viewing player's own read/snooze/favorite state. This is the element shape of
 * the thread-list response.
 */
export interface ChatThread {
	/** Null only for a thread with no messages yet. */
	latestMessage: ChatMessage | null
	chatThreadId: number
	playerIds: number[]
	/**
	 * 0 when the player has never read the thread — never null. The client deserializes
	 * this into a non-nullable int and fails the whole response on a null ("expected
	 * 'Number Token', actual 'null'"), unlike `latestMessage`, which it accepts as null.
	 */
	lastReadMessageId: number
	/**
	 * Empty for DMs and unnamed groups — never null. The client dereferences this name
	 * without a null check (a null NullReferenceExceptions its way out of
	 * GetChatBetweenPlayers) and falls back to naming the members when it's blank.
	 */
	chatThreadName: string
	snoozedUntil: string | null
	isFavorited: boolean
}

/** The joined row backing a rendered thread, before it's shaped for the client. */
interface ThreadRow {
	chat_thread_id: number
	chat_thread_name: string | null
	player_ids: string | null
	last_read_message_id: number | null
	snoozed_until: string | null
	is_favorited: number
	msg_chat_message_id: number | null
	msg_chat_thread_id: number | null
	msg_sender_player_id: number | null
	msg_time_sent: string | null
	msg_contents: string | null
	msg_moderation_state: number | null
}

function toThread(row: ThreadRow): ChatThread {
	return {
		latestMessage:
			row.msg_chat_message_id === null
				? null
				: {
						chatMessageId: row.msg_chat_message_id,
						chatThreadId: row.msg_chat_thread_id!,
						senderPlayerId: row.msg_sender_player_id!,
						timeSent: row.msg_time_sent!,
						contents: row.msg_contents!,
						moderationState: row.msg_moderation_state!,
					},
		chatThreadId: row.chat_thread_id,
		// group_concat of the membership rows, already ordered by player id.
		playerIds: row.player_ids === null ? [] : row.player_ids.split(',').map(Number),
		// Null in the column means "never read"; the client insists on a number.
		lastReadMessageId: row.last_read_message_id ?? 0,
		// Null in the column means "unnamed"; the client dereferences it unchecked.
		chatThreadName: row.chat_thread_name ?? '',
		snoozedUntil: row.snoozed_until,
		isFavorited: row.is_favorited !== 0,
	}
}

/**
 * The thread list as it renders for one player, newest conversation first — the
 * `?MessageCount=N` page of the thread endpoint.
 *
 * Reads only threads the player is a member of, so the membership join is the
 * authorization check as well as the query. The inner ordered subquery around
 * group_concat is what makes `playerIds` come back sorted rather than in row order.
 */
export async function getThreadsForPlayer(
	db: D1Database,
	playerId: number,
	{ limit = 50 }: { limit?: number } = {}
): Promise<ChatThread[]> {
	const { results } = await db
		.prepare(
			`SELECT
				t.chat_thread_id,
				t.chat_thread_name,
				(SELECT group_concat(player_id) FROM
					(SELECT player_id FROM thread_member WHERE chat_thread_id = t.chat_thread_id
					 ORDER BY player_id)) AS player_ids,
				me.last_read_message_id,
				me.snoozed_until,
				me.is_favorited,
				msg.chat_message_id AS msg_chat_message_id,
				msg.chat_thread_id AS msg_chat_thread_id,
				msg.sender_player_id AS msg_sender_player_id,
				msg.time_sent AS msg_time_sent,
				msg.contents AS msg_contents,
				msg.moderation_state AS msg_moderation_state
			 FROM thread_member me
			 JOIN message_thread t ON t.chat_thread_id = me.chat_thread_id
			 LEFT JOIN message msg ON msg.chat_message_id = t.latest_message_id
			 WHERE me.player_id = ?1
			 ORDER BY t.latest_message_id DESC
			 LIMIT ?2`
		)
		.bind(playerId, limit)
		.all<ThreadRow>()
	return results.map(toThread)
}

/** One thread as it renders for one player, or null if they aren't a member of it. */
export async function getThreadForPlayer(
	db: D1Database,
	chatThreadId: number,
	playerId: number
): Promise<ChatThread | null> {
	const row = await db
		.prepare(
			`SELECT
				t.chat_thread_id,
				t.chat_thread_name,
				(SELECT group_concat(player_id) FROM
					(SELECT player_id FROM thread_member WHERE chat_thread_id = t.chat_thread_id
					 ORDER BY player_id)) AS player_ids,
				me.last_read_message_id,
				me.snoozed_until,
				me.is_favorited,
				msg.chat_message_id AS msg_chat_message_id,
				msg.chat_thread_id AS msg_chat_thread_id,
				msg.sender_player_id AS msg_sender_player_id,
				msg.time_sent AS msg_time_sent,
				msg.contents AS msg_contents,
				msg.moderation_state AS msg_moderation_state
			 FROM thread_member me
			 JOIN message_thread t ON t.chat_thread_id = me.chat_thread_id
			 LEFT JOIN message msg ON msg.chat_message_id = t.latest_message_id
			 WHERE me.chat_thread_id = ?1 AND me.player_id = ?2`
		)
		.bind(chatThreadId, playerId)
		.first<ThreadRow>()
	return row === null ? null : toThread(row)
}

/**
 * Whether a player may read or post to a thread. Every thread-scoped route gates on
 * this before touching messages.
 */
export async function isThreadMember(
	db: D1Database,
	chatThreadId: number,
	playerId: number
): Promise<boolean> {
	const row = await db
		.prepare('SELECT 1 AS ok FROM thread_member WHERE chat_thread_id = ?1 AND player_id = ?2')
		.bind(chatThreadId, playerId)
		.first<{ ok: number }>()
	return row !== null
}

/**
 * The pseudo-player system messages are sent as. Not a real account — the client renders
 * a message from this sender as a notice rather than as someone speaking, which is why
 * `message.sender_player_id` carries no foreign key and permits negative ids.
 */
export const SYSTEM_SENDER_ID = -5

/**
 * The notice a thread opens with: `Player <@U10441985> started a chat`. The `<@U…>` token
 * is a mention the client resolves to a display name, so the id goes in raw.
 */
export function startedChatContents(playerId: number): string {
	return JSON.stringify({
		Type: 0,
		Version: 1,
		Data: `Player <@U${playerId}> started a chat`,
	})
}

/**
 * The notice left behind when someone walks out of a group: `Player <@U14922080> left`.
 * Same `<@U…>` mention token the opening notice uses.
 */
export function leftChatContents(playerId: number): string {
	return JSON.stringify({ Type: 0, Version: 1, Data: `Player <@U${playerId}> left` })
}

/**
 * Rename a thread. An empty name clears it back to unnamed, which renders as the member
 * list rather than a blank title.
 */
export async function setThreadName(
	db: D1Database,
	chatThreadId: number,
	name: string
): Promise<void> {
	await db
		.prepare('UPDATE message_thread SET chat_thread_name = ?2 WHERE chat_thread_id = ?1')
		.bind(chatThreadId, name === '' ? null : name)
		.run()
}

/**
 * Open a thread between a set of players, returning its new id. `name` is null for DMs
 * and unnamed groups. Duplicate player ids collapse, so a caller need not dedupe.
 *
 * Pass `startedBy` to open the thread the way the real server does — with a system
 * "started a chat" notice as its first message. A thread with no messages at all is one
 * the client won't display, so every thread born from a request gets one; the parameter
 * is optional only so tests can build a bare thread directly.
 *
 * Every call opens a *distinct* thread, even for a member set that already has one —
 * threads are not keyed by their membership, and the same pair may hold several.
 */
export async function createThread(
	db: D1Database,
	playerIds: number[],
	name: string | null = null,
	startedBy?: number
): Promise<number> {
	const row = await db
		.prepare(
			`INSERT INTO message_thread (chat_thread_name, created_at) VALUES (?1, ?2)
			 RETURNING chat_thread_id`
		)
		.bind(name, new Date().toISOString())
		.first<{ chat_thread_id: number }>()
	if (row === null) throw new Error('failed to create chat thread')

	const members = [...new Set(playerIds)]
	if (members.length > 0) {
		await db.batch(
			members.map((playerId) =>
				db
					.prepare(
						`INSERT OR IGNORE INTO thread_member (chat_thread_id, player_id)
						 VALUES (?1, ?2)`
					)
					.bind(row.chat_thread_id, playerId)
			)
		)
	}

	if (startedBy !== undefined) {
		await postMessage(db, {
			chatThreadId: row.chat_thread_id,
			senderPlayerId: SYSTEM_SENDER_ID,
			contents: startedChatContents(startedBy),
		})
	}
	return row.chat_thread_id
}

/**
 * The existing thread whose membership is *exactly* this set of players, or null. The
 * oldest match wins, so a set that somehow accumulated duplicates keeps resolving to the
 * conversation with the history in it.
 *
 * This is what makes "open a chat with these people" reuse the conversation you already
 * have with them rather than starting an empty one each time. Matching is on the whole
 * set: a DM and a group that happens to contain those two people are different threads.
 *
 * Only threads that still have a `message_thread` row can match. Membership rows whose
 * thread is gone are ignored rather than resolved to: matching one would hand back an id
 * that nothing else in the worker can render, and — since the oldest match wins — it
 * would keep winning on every subsequent call.
 */
export async function findThreadWithMembers(
	db: D1Database,
	playerIds: number[]
): Promise<number | null> {
	const members = [...new Set(playerIds)]
	if (members.length === 0) return null

	// ?1 is the member count; ?2… are the ids themselves.
	const placeholders = members.map((_, i) => `?${i + 2}`).join(', ')
	const row = await db
		.prepare(
			`SELECT m.chat_thread_id FROM thread_member m
			 JOIN message_thread t ON t.chat_thread_id = m.chat_thread_id
			 GROUP BY m.chat_thread_id
			 HAVING COUNT(*) = ?1
			    AND COUNT(CASE WHEN m.player_id IN (${placeholders}) THEN 1 END) = ?1
			 ORDER BY m.chat_thread_id
			 LIMIT 1`
		)
		.bind(members.length, ...members)
		.first<{ chat_thread_id: number }>()
	return row?.chat_thread_id ?? null
}

/**
 * The thread with exactly these members, opening one if it doesn't exist yet. Two
 * simultaneous first-messages to the same set can still race into two threads; the
 * oldest-match rule in `findThreadWithMembers` means both parties converge on one of
 * them afterwards.
 */
export async function getOrCreateThreadWithMembers(
	db: D1Database,
	playerIds: number[],
	startedBy: number
): Promise<number> {
	return (
		(await findThreadWithMembers(db, playerIds)) ??
		(await createThread(db, playerIds, null, startedBy))
	)
}

/** Everyone in a thread, ordered by id — the fan-out list for a push notification. */
export async function getThreadMemberIds(db: D1Database, chatThreadId: number): Promise<number[]> {
	const { results } = await db
		.prepare('SELECT player_id FROM thread_member WHERE chat_thread_id = ?1 ORDER BY player_id')
		.bind(chatThreadId)
		.all<{ player_id: number }>()
	return results.map((r) => r.player_id)
}

/** Add a player to an existing thread. A no-op if they're already in it. */
export async function addThreadMember(
	db: D1Database,
	chatThreadId: number,
	playerId: number
): Promise<void> {
	await db
		.prepare('INSERT OR IGNORE INTO thread_member (chat_thread_id, player_id) VALUES (?1, ?2)')
		.bind(chatThreadId, playerId)
		.run()
}

/** Remove a player from a thread. The thread and its messages outlive the membership. */
export async function removeThreadMember(
	db: D1Database,
	chatThreadId: number,
	playerId: number
): Promise<void> {
	await db
		.prepare('DELETE FROM thread_member WHERE chat_thread_id = ?1 AND player_id = ?2')
		.bind(chatThreadId, playerId)
		.run()
}

/**
 * Post a message and advance the thread's denormalized `latest_message_id` — the only
 * way messages should be written, so the thread list never goes stale. Two statements
 * rather than a batch, because the update needs the id the insert assigns.
 */
export async function postMessage(db: D1Database, message: NewChatMessage): Promise<ChatMessage> {
	const stored = await insertMessage(db, message)
	await db
		.prepare('UPDATE message_thread SET latest_message_id = ?2 WHERE chat_thread_id = ?1')
		.bind(stored.chatThreadId, stored.chatMessageId)
		.run()
	return stored
}

/**
 * Advance a player's read position, to a specific message or (with no id) to the whole
 * thread. Only ever moves forward: an out-of-order ack from a second client can't walk
 * the thread back to unread.
 *
 * The id is also clamped to the thread's real latest message, so a client acking an id
 * that was never stored can't strand the pointer beyond every future message and leave
 * the thread permanently "read".
 */
export async function markThreadRead(
	db: D1Database,
	chatThreadId: number,
	playerId: number,
	chatMessageId?: number
): Promise<void> {
	await db
		.prepare(
			`UPDATE thread_member
			 SET last_read_message_id = MAX(
			   COALESCE(last_read_message_id, 0),
			   MIN(
			     COALESCE(?3, (SELECT latest_message_id FROM message_thread WHERE chat_thread_id = ?1), 0),
			     COALESCE((SELECT latest_message_id FROM message_thread WHERE chat_thread_id = ?1), 0)
			   )
			 )
			 WHERE chat_thread_id = ?1 AND player_id = ?2`
		)
		.bind(chatThreadId, playerId, chatMessageId ?? null)
		.run()
}

/** Favorite or unfavorite a thread, for one player only. */
export async function setThreadFavorited(
	db: D1Database,
	chatThreadId: number,
	playerId: number,
	isFavorited: boolean
): Promise<void> {
	await db
		.prepare(
			'UPDATE thread_member SET is_favorited = ?3 WHERE chat_thread_id = ?1 AND player_id = ?2'
		)
		.bind(chatThreadId, playerId, isFavorited ? 1 : 0)
		.run()
}

/** Snooze a thread's notifications until an instant, or clear the snooze with null. */
export async function setThreadSnoozed(
	db: D1Database,
	chatThreadId: number,
	playerId: number,
	snoozedUntil: string | null
): Promise<void> {
	await db
		.prepare(
			'UPDATE thread_member SET snoozed_until = ?3 WHERE chat_thread_id = ?1 AND player_id = ?2'
		)
		.bind(chatThreadId, playerId, snoozedUntil)
		.run()
}
