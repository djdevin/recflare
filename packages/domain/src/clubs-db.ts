/**
 * Cross-worker *reads* of the club tables. The `clubs` worker owns the schema and
 * every write (see apps/clubs/src/clubs-db.ts); this is the narrow view other
 * workers need — right now `match`, which has to know a club's clubhouse room and
 * whether the player asking for it is actually a member.
 *
 * Deliberately read-only, and deliberately small: clubs are a JSON blob in
 * `club.data`, so anything that needs the whole DTO should go through the clubs
 * worker's API rather than growing this file into a second copy of its model.
 */

/**
 * A player's membership state in a club (mirror of the clubs worker's
 * `ClubMembershipType`). Only the values other workers reason about are named here;
 * the tiers between are just higher numbers.
 */
export const CLUB_MEMBERSHIP_BANNED = -1
export const CLUB_MEMBERSHIP_NONE = 0
/** At/above this, a row is an actual member rather than pending/banned. */
export const CLUB_MEMBERSHIP_MEMBER = 10

/** The club fields other workers read. */
export interface ClubSummary {
	clubId: number
	name: string
	/** The room players spawn into for this club; null when it has no clubhouse. */
	clubhouseRoomId: number | null
}

/** Look up a club's name and clubhouse room. Null when there's no such club. */
export async function getClubSummary(db: D1Database, clubId: number): Promise<ClubSummary | null> {
	const row = await db
		.prepare(
			`SELECT json_extract(data, '$.Name') AS name,
			        json_extract(data, '$.ClubhouseRoomId') AS clubhouseRoomId
			 FROM club WHERE club_id = ?1`
		)
		.bind(clubId)
		.first<{ name: string | null; clubhouseRoomId: number | null }>()
	if (row === null) return null
	return { clubId, name: row.name ?? '', clubhouseRoomId: row.clubhouseRoomId }
}

/** A player's membership type in a club (0 = no row, i.e. not a member). */
export async function getClubMembership(
	db: D1Database,
	clubId: number,
	accountId: number
): Promise<number> {
	const row = await db
		.prepare('SELECT membership_type AS t FROM club_member WHERE club_id = ?1 AND account_id = ?2')
		.bind(clubId, accountId)
		.first<{ t: number }>()
	return row?.t ?? CLUB_MEMBERSHIP_NONE
}

/** Whether an account is an actual member of a club (Member tier or above). */
export async function isClubMember(
	db: D1Database,
	clubId: number,
	accountId: number
): Promise<boolean> {
	return (await getClubMembership(db, clubId, accountId)) >= CLUB_MEMBERSHIP_MEMBER
}
