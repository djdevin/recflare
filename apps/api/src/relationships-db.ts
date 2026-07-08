/**
 * Friendship / relationship storage on the shared `recflare` D1 database.
 *
 * Unlike the JSON-blob tables in this database (rooms/accounts/image), a
 * relationship is genuinely columnar, so it gets a normal relational table
 * (mirroring the Go/GORM `Relationship` model). Exactly ONE row exists per
 * unordered pair of players: the player who initiated is the `requester`, the
 * other is the `target`. `relationship_type` is stored from the requester's
 * point of view; when we project the row for the *target* we flip
 * Sent↔Received (Friend/None are symmetric).
 *
 * The `api` worker owns this schema/migration (migrations/0001_relationship.sql,
 * applied under its own `migrations_table` so it doesn't clash with the other
 * workers' migrations that share the database).
 */

/** Relationship state from the perspective of the player asking (mirror of the C# enum). */
export enum RelationshipType {
	None = 0,
	FriendRequestSent = 1,
	FriendRequestReceived = 2,
	Friend = 3,
}

/** Schema DDL (mirror of migrations/0001_relationship.sql, sans seed rows). */
export const SCHEMA_DDL: string[] = [
	`CREATE TABLE IF NOT EXISTS relationship (
		id INTEGER PRIMARY KEY AUTOINCREMENT,
		requester_id INTEGER NOT NULL,
		target_id INTEGER NOT NULL,
		relationship_type INTEGER NOT NULL DEFAULT 0,
		requester_favorited INTEGER NOT NULL DEFAULT 0,
		requester_ignored INTEGER NOT NULL DEFAULT 0,
		requester_muted INTEGER NOT NULL DEFAULT 0,
		target_favorited INTEGER NOT NULL DEFAULT 0,
		target_ignored INTEGER NOT NULL DEFAULT 0,
		target_muted INTEGER NOT NULL DEFAULT 0
	)`,
	`CREATE UNIQUE INDEX IF NOT EXISTS idx_relationship ON relationship (requester_id, target_id)`,
	`CREATE INDEX IF NOT EXISTS idx_relationship_target ON relationship (target_id)`,
]

/** A stored relationship row (snake_case columns, one row per player pair). */
interface RelationshipRow {
	requester_id: number
	target_id: number
	relationship_type: number
	requester_favorited: number
	requester_ignored: number
	requester_muted: number
	target_favorited: number
	target_ignored: number
	target_muted: number
}

/** The per-player relationship projection returned to the client (the C# RelationshipResponse). */
export interface RelationshipResponse {
	Favorited: number
	Ignored: number
	Muted: number
	PlayerID: number
	RelationshipType: RelationshipType
}

/** Flip a pending request to the other side's point of view; Friend/None are symmetric. */
function flipType(type: number): RelationshipType {
	if (type === RelationshipType.FriendRequestSent) return RelationshipType.FriendRequestReceived
	if (type === RelationshipType.FriendRequestReceived) return RelationshipType.FriendRequestSent
	return type as RelationshipType
}

/**
 * Project a stored row into the RelationshipResponse for `playerId` (who must be
 * one of the pair). `PlayerID` is the *other* player; the type and the
 * favorited/ignored/muted flags are taken from `playerId`'s side of the row.
 */
function toResponse(row: RelationshipRow, playerId: number): RelationshipResponse {
	const isRequester = row.requester_id === playerId
	return {
		PlayerID: isRequester ? row.target_id : row.requester_id,
		RelationshipType: isRequester ? (row.relationship_type as RelationshipType) : flipType(row.relationship_type),
		Favorited: isRequester ? row.requester_favorited : row.target_favorited,
		Ignored: isRequester ? row.requester_ignored : row.target_ignored,
		Muted: isRequester ? row.requester_muted : row.target_muted,
	}
}

/** Find the single row for an unordered pair (either direction), or null. */
async function findPair(db: D1Database, a: number, b: number): Promise<RelationshipRow | null> {
	return db
		.prepare(
			`SELECT * FROM relationship
			 WHERE (requester_id = ?1 AND target_id = ?2) OR (requester_id = ?2 AND target_id = ?1)`
		)
		.bind(a, b)
		.first<RelationshipRow>()
}

/**
 * All of a player's relationships, projected from that player's point of view.
 * `None` rows are omitted (a removed friend leaves no relationship to report).
 */
export async function getRelationshipsForPlayer(
	db: D1Database,
	playerId: number
): Promise<RelationshipResponse[]> {
	const { results } = await db
		.prepare(
			`SELECT * FROM relationship
			 WHERE requester_id = ?1 OR target_id = ?1`
		)
		.bind(playerId)
		.all<RelationshipRow>()
	return results
		.filter((row) => row.relationship_type !== RelationshipType.None)
		.map((row) => toResponse(row, playerId))
}

/**
 * Persist `type` for the pair, with `requesterId` recorded as the row's
 * requester. Inserts a new row or, if one already exists for the pair (either
 * direction), rewrites it so the requester is normalized to `requesterId` and
 * the flags are preserved for whichever side each player is on. Returns the
 * relationship from `requesterId`'s point of view.
 */
async function upsertPair(
	db: D1Database,
	requesterId: number,
	targetId: number,
	type: RelationshipType
): Promise<RelationshipResponse> {
	const existing = await findPair(db, requesterId, targetId)
	if (!existing) {
		await db
			.prepare(
				`INSERT INTO relationship (requester_id, target_id, relationship_type)
				 VALUES (?1, ?2, ?3)`
			)
			.bind(requesterId, targetId, type)
			.run()
		return { PlayerID: targetId, RelationshipType: type, Favorited: 0, Ignored: 0, Muted: 0 }
	}

	// Keep each player's flags with that player as the row is normalized to
	// requester = requesterId.
	const reqIsRequester = existing.requester_id === requesterId
	const reqFlags = {
		favorited: reqIsRequester ? existing.requester_favorited : existing.target_favorited,
		ignored: reqIsRequester ? existing.requester_ignored : existing.target_ignored,
		muted: reqIsRequester ? existing.requester_muted : existing.target_muted,
	}
	const tgtFlags = {
		favorited: reqIsRequester ? existing.target_favorited : existing.requester_favorited,
		ignored: reqIsRequester ? existing.target_ignored : existing.requester_ignored,
		muted: reqIsRequester ? existing.target_muted : existing.requester_muted,
	}
	await db
		.prepare(
			`UPDATE relationship
			 SET requester_id = ?1, target_id = ?2, relationship_type = ?3,
			     requester_favorited = ?4, requester_ignored = ?5, requester_muted = ?6,
			     target_favorited = ?7, target_ignored = ?8, target_muted = ?9
			 WHERE (requester_id = ?1 AND target_id = ?2) OR (requester_id = ?2 AND target_id = ?1)`
		)
		.bind(
			requesterId,
			targetId,
			type,
			reqFlags.favorited,
			reqFlags.ignored,
			reqFlags.muted,
			tgtFlags.favorited,
			tgtFlags.ignored,
			tgtFlags.muted
		)
		.run()
	return {
		PlayerID: targetId,
		RelationshipType: type,
		Favorited: reqFlags.favorited,
		Ignored: reqFlags.ignored,
		Muted: reqFlags.muted,
	}
}

/**
 * Send a friend request from `requesterId` to `targetId`. If the target already
 * has a pending request out to the requester, the two become friends instead
 * (the request crosses an existing one). Already-friends is left unchanged.
 * Returns the relationship from the requester's point of view.
 */
export async function sendFriendRequest(
	db: D1Database,
	requesterId: number,
	targetId: number
): Promise<RelationshipResponse> {
	const existing = await findPair(db, requesterId, targetId)
	if (existing) {
		if (existing.relationship_type === RelationshipType.Friend) {
			return toResponse(existing, requesterId)
		}
		// The target already requested us → crossing requests become a friendship.
		if (
			existing.requester_id === targetId &&
			existing.relationship_type === RelationshipType.FriendRequestSent
		) {
			return upsertPair(db, requesterId, targetId, RelationshipType.Friend)
		}
	}
	return upsertPair(db, requesterId, targetId, RelationshipType.FriendRequestSent)
}

/**
 * `accepterId` accepts a pending friend request from `otherId`. Only upgrades to
 * Friend when a request from `otherId` is actually pending; otherwise the
 * current state is returned unchanged. Returns the relationship from the
 * accepter's point of view.
 */
export async function acceptFriendRequest(
	db: D1Database,
	accepterId: number,
	otherId: number
): Promise<RelationshipResponse> {
	const existing = await findPair(db, accepterId, otherId)
	if (
		existing &&
		existing.requester_id === otherId &&
		existing.relationship_type === RelationshipType.FriendRequestSent
	) {
		// upsertPair projects for the requester (otherId); the accepter is the target,
		// so re-project the written row from the accepter's point of view.
		await upsertPair(db, otherId, accepterId, RelationshipType.Friend)
		const updated = await findPair(db, accepterId, otherId)
		if (updated) return toResponse(updated, accepterId)
	}
	return existing
		? toResponse(existing, accepterId)
		: { PlayerID: otherId, RelationshipType: RelationshipType.None, Favorited: 0, Ignored: 0, Muted: 0 }
}

/**
 * Directly make `requesterId` and `targetId` friends (no pending request step).
 * Returns the relationship from the requester's point of view.
 */
export async function addFriend(
	db: D1Database,
	requesterId: number,
	targetId: number
): Promise<RelationshipResponse> {
	return upsertPair(db, requesterId, targetId, RelationshipType.Friend)
}

/**
 * Remove any relationship between the two players (unfriend / cancel request /
 * decline). Deletes the row entirely so neither side reports a relationship.
 */
export async function removeFriend(db: D1Database, a: number, b: number): Promise<void> {
	await db
		.prepare(
			`DELETE FROM relationship
			 WHERE (requester_id = ?1 AND target_id = ?2) OR (requester_id = ?2 AND target_id = ?1)`
		)
		.bind(a, b)
		.run()
}
