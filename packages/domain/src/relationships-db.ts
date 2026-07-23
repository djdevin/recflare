/**
 * Read-only access to the friendship graph on the shared `recflare` D1 database.
 *
 * The `relationship` table's schema and every mutation are owned by the `api` worker
 * (apps/api/src/relationships-db.ts, migrations/0001_relationship.sql). This module is
 * the shared *reader* other workers need: the `match` worker looks up a player's friends
 * to push a presence update to them when the player changes rooms. It only SELECTs the
 * three columns that identify a friendship (requester/target/type), so it stays
 * decoupled from the favorited/ignored/muted flag columns api layers on top.
 */

/**
 * `relationship_type` for a mutual friendship — mirror of api's `RelationshipType.Friend`.
 * Pending requests (1 sent / 2 received) and bare ignore/mute rows (0) are not friends.
 */
const FRIEND_RELATIONSHIP_TYPE = 3

/**
 * The account ids of a player's mutual friends. Exactly one relationship row exists per
 * unordered pair, with the player on either side, so this reads both directions and
 * returns whichever id isn't the player. Non-friend rows are excluded; the order is
 * unspecified.
 */
export async function getFriendIds(db: D1Database, playerId: number): Promise<number[]> {
	const { results } = await db
		.prepare(
			`SELECT requester_id, target_id FROM relationship
			 WHERE relationship_type = ?2 AND (requester_id = ?1 OR target_id = ?1)`
		)
		.bind(playerId, FRIEND_RELATIONSHIP_TYPE)
		.all<{ requester_id: number; target_id: number }>()
	return results.map((r) => (r.requester_id === playerId ? r.target_id : r.requester_id))
}

/**
 * Whether two players are mutual friends. The single relationship row for the pair sits
 * in either direction, so both are checked. A targeted single-row read — cheaper than
 * {@link getFriendIds} when all you need is "are these two friends?" (e.g. gating a
 * follow-a-friend matchmake).
 */
export async function areFriends(
	db: D1Database,
	playerId: number,
	otherId: number
): Promise<boolean> {
	const row = await db
		.prepare(
			`SELECT 1 AS ok FROM relationship
			 WHERE relationship_type = ?3
			   AND ((requester_id = ?1 AND target_id = ?2) OR (requester_id = ?2 AND target_id = ?1))
			 LIMIT 1`
		)
		.bind(playerId, otherId, FRIEND_RELATIONSHIP_TYPE)
		.first<{ ok: number }>()
	return row !== null
}
