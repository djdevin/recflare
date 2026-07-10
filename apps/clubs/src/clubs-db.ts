/**
 * Club storage on the shared `recflare` D1 database. A club is a single JSON blob
 * in the `data` column (the client-facing Club DTO); queryable fields (ClubId,
 * Name, Category, Visibility, State, CreatorAccountId) are SQLite generated
 * (virtual) columns extracted from that JSON and indexed — the same JSON-blob
 * pattern the rooms/accounts tables use. Mirrors the Go/GORM `Club` model.
 *
 * Membership lives in a separate `club_member` table (one row per club/account);
 * the club's `MemberCount` is a denormalized field kept in sync from those rows.
 *
 * The `clubs` worker owns this schema/migration (migrations/0001_club.sql, applied
 * under its own `migrations_table` so it doesn't clash with the other workers'
 * migrations that share the database). `SCHEMA_DDL` mirrors that migration so tests
 * can build the tables directly.
 */

/** Schema DDL (mirror of migrations/0001_club.sql, sans seed rows). */
export const SCHEMA_DDL: string[] = [
	`CREATE TABLE IF NOT EXISTS club (
		data TEXT NOT NULL,
		club_id INTEGER GENERATED ALWAYS AS (json_extract(data, '$.ClubId')) VIRTUAL,
		name_lower TEXT GENERATED ALWAYS AS (lower(json_extract(data, '$.Name'))) VIRTUAL,
		category TEXT GENERATED ALWAYS AS (json_extract(data, '$.Category')) VIRTUAL,
		visibility INTEGER GENERATED ALWAYS AS (json_extract(data, '$.Visibility')) VIRTUAL,
		state INTEGER GENERATED ALWAYS AS (json_extract(data, '$.State')) VIRTUAL,
		creator_account_id INTEGER GENERATED ALWAYS AS (json_extract(data, '$.CreatorAccountId')) VIRTUAL
	)`,
	`CREATE UNIQUE INDEX IF NOT EXISTS idx_club_club_id ON club (club_id)`,
	`CREATE INDEX IF NOT EXISTS idx_club_name_lower ON club (name_lower)`,
	`CREATE INDEX IF NOT EXISTS idx_club_category ON club (category)`,
	`CREATE INDEX IF NOT EXISTS idx_club_creator ON club (creator_account_id)`,
	// Club membership — one row per (club, account); `membership_type` (see
	// ClubMembershipType) encodes bans, pending requests/invites, and roles in a
	// single field. Surrogate PK mirrors the Go model; the UNIQUE (club_id,
	// account_id) index enforces one membership per pair (and backs the upsert). The
	// club's MemberCount is kept in sync from the rows that count as real members.
	`CREATE TABLE IF NOT EXISTS club_member (
		club_member_id INTEGER PRIMARY KEY AUTOINCREMENT,
		club_id INTEGER NOT NULL,
		account_id INTEGER NOT NULL,
		membership_type INTEGER NOT NULL DEFAULT 0,
		created_at TEXT
	)`,
	`CREATE UNIQUE INDEX IF NOT EXISTS idx_club_member_pair ON club_member (club_id, account_id)`,
	`CREATE INDEX IF NOT EXISTS idx_club_member_account ON club_member (account_id)`,
]

/**
 * A player's membership state in a club (mirror of the Go `ClubMembershipType`).
 * The single field spans bans, the pending request/invite states, and the member
 * role tiers; `Member` (10) is the threshold at/above which someone is an actual
 * member (below it is pending/none/banned).
 */
export enum ClubMembershipType {
	Banned = -1,
	None = 0,
	PendingRequested = 1,
	PendingInvited = 2,
	PendingDenied = 3,
	Member = 10,
	Moderator = 20,
	Coowner = 30,
	Creator = 100,
}

/** A club's visibility (mirror of the Go `ClubVisibility`). */
export enum ClubVisibility {
	Private = 0,
	Public = 1,
}

/** How a player may join a club (mirror of the Go `ClubJoinability`). */
export enum ClubJoinability {
	Open = 0,
	InviteOnly = 1,
	AskToJoin = 2,
}

/** Membership types at/above which a row counts as an actual member (not pending/banned). */
const MEMBER_THRESHOLD = ClubMembershipType.Member

/**
 * Client-facing club shape (PascalCase, mirror of the Go `Club` JSON tags). The
 * Go model's `CreatedAt` is `json:"-"` — stored but never serialized — so it lives
 * in the blob (see StoredClub) but is dropped from this DTO.
 */
export interface Club {
	ClubId: number
	Name: string
	Description: string
	Category: string
	Visibility: number
	Joinability: number
	AllowJuniors: boolean
	MainImageName: string
	ClubType: number
	ClubhouseRoomId: number | null
	CreatorAccountId: number
	IsRRO: boolean
	MinLevel: number
	State: number
	MemberCount: number
}

/** The stored club — the DTO plus `CreatedAt` (kept in the blob, `json:"-"` in Go). */
interface StoredClub extends Club {
	CreatedAt: string
}

interface ClubRow {
	data: string
}

/** Project a stored club to the client DTO (drops the non-serialized CreatedAt). */
function toDto(s: StoredClub): Club {
	return {
		ClubId: s.ClubId,
		Name: s.Name,
		Description: s.Description,
		Category: s.Category,
		Visibility: s.Visibility,
		Joinability: s.Joinability,
		AllowJuniors: s.AllowJuniors,
		MainImageName: s.MainImageName,
		ClubType: s.ClubType,
		ClubhouseRoomId: s.ClubhouseRoomId,
		CreatorAccountId: s.CreatorAccountId,
		IsRRO: s.IsRRO,
		MinLevel: s.MinLevel,
		State: s.State,
		MemberCount: s.MemberCount,
	}
}

const parseOne = (row: ClubRow | null): Club | null =>
	row ? toDto(JSON.parse(row.data) as StoredClub) : null
const parseAll = (rows: ClubRow[]): Club[] => rows.map((r) => toDto(JSON.parse(r.data) as StoredClub))

/**
 * Recompute a club's `MemberCount` from the `club_member` rows and write it back
 * into the blob (the generated column follows). Returns the fresh count. Keeping
 * the count derived avoids drift from concurrent joins/leaves.
 */
async function syncMemberCount(db: D1Database, clubId: number): Promise<number> {
	const row = await db
		.prepare('SELECT COUNT(*) AS n FROM club_member WHERE club_id = ?1 AND membership_type >= ?2')
		.bind(clubId, MEMBER_THRESHOLD)
		.first<{ n: number }>()
	const count = row?.n ?? 0
	await db
		.prepare("UPDATE club SET data = json_set(data, '$.MemberCount', ?2) WHERE club_id = ?1")
		.bind(clubId, count)
		.run()
	return count
}

/** Read a player's membership type in a club (None when there's no row). */
export async function getMembership(
	db: D1Database,
	clubId: number,
	accountId: number
): Promise<ClubMembershipType> {
	const row = await db
		.prepare('SELECT membership_type AS t FROM club_member WHERE club_id = ?1 AND account_id = ?2')
		.bind(clubId, accountId)
		.first<{ t: number }>()
	return (row?.t ?? ClubMembershipType.None) as ClubMembershipType
}

/**
 * Upsert a player's membership type for a club (one row per pair). `created_at` is
 * stamped on first insert and preserved on later type changes.
 */
async function setMembership(
	db: D1Database,
	clubId: number,
	accountId: number,
	type: ClubMembershipType
): Promise<void> {
	await db
		.prepare(
			`INSERT INTO club_member (club_id, account_id, membership_type, created_at)
			 VALUES (?1, ?2, ?3, ?4)
			 ON CONFLICT(club_id, account_id) DO UPDATE SET membership_type = ?3`
		)
		.bind(clubId, accountId, type, new Date().toISOString())
		.run()
}

/** Fields a caller may supply when creating a club; everything else takes the Go defaults. */
export interface NewClub {
	name: string
	description?: string
	category?: string
	visibility?: number
	joinability?: number
	allowJuniors?: boolean
	mainImageName?: string
	clubType?: number
	clubhouseRoomId?: number | null
	isRRO?: boolean
	minLevel?: number
}

/**
 * Create a club owned by `creatorAccountId`. The id is the next free integer (the
 * Go model uses `autoIncrement:false`, i.e. an app-assigned id). Unset fields fall
 * back to the Go model's column defaults. The creator is added as the club's first
 * member (Owner), so the returned club has MemberCount 1.
 */
export async function createClub(
	db: D1Database,
	creatorAccountId: number,
	input: NewClub
): Promise<Club> {
	const idRow = await db
		.prepare('SELECT COALESCE(MAX(club_id), 0) + 1 AS next FROM club')
		.first<{ next: number }>()
	const clubId = idRow?.next ?? 1
	const now = new Date().toISOString()

	const stored: StoredClub = {
		ClubId: clubId,
		Name: input.name,
		Description: input.description ?? '',
		Category: input.category ?? '',
		Visibility: input.visibility ?? ClubVisibility.Public,
		Joinability: input.joinability ?? ClubJoinability.Open,
		AllowJuniors: input.allowJuniors ?? true,
		MainImageName: input.mainImageName ?? 'DefaultImgPurple',
		ClubType: input.clubType ?? 0,
		ClubhouseRoomId: input.clubhouseRoomId ?? null,
		CreatorAccountId: creatorAccountId,
		IsRRO: input.isRRO ?? false,
		MinLevel: input.minLevel ?? 0,
		State: 0,
		MemberCount: 0,
		CreatedAt: now,
	}
	await db.prepare('INSERT INTO club (data) VALUES (?1)').bind(JSON.stringify(stored)).run()

	// The creator is the club's first member, joining as its Creator.
	await setMembership(db, clubId, creatorAccountId, ClubMembershipType.Creator)
	const count = await syncMemberCount(db, clubId)
	return { ...toDto(stored), MemberCount: count }
}

/** Look up a single club by its ClubId. */
export async function getClub(db: D1Database, clubId: number): Promise<Club | null> {
	return parseOne(
		await db.prepare('SELECT data FROM club WHERE club_id = ?1').bind(clubId).first<ClubRow>()
	)
}

/** All clubs created by an account (GetMyCreatedClubs). */
export async function getClubsByCreator(db: D1Database, accountId: number): Promise<Club[]> {
	const { results } = await db
		.prepare('SELECT data FROM club WHERE creator_account_id = ?1')
		.bind(accountId)
		.all<ClubRow>()
	return parseAll(results)
}

/**
 * All clubs an account is an actual member of (GetMyMembershipClubs), most recently
 * joined first. Only memberships at/above `Member` count — pending requests, denied
 * requests, and bans are excluded. Joins `club_member` to `club`, so a membership
 * whose club is gone is simply absent.
 */
export async function getClubsByMember(db: D1Database, accountId: number): Promise<Club[]> {
	const { results } = await db
		.prepare(
			`SELECT c.data AS data
			 FROM club_member m
			 JOIN club c ON c.club_id = m.club_id
			 WHERE m.account_id = ?1 AND m.membership_type >= ?2
			 ORDER BY m.created_at DESC`
		)
		.bind(accountId, MEMBER_THRESHOLD)
		.all<ClubRow>()
	return parseAll(results)
}

/** Whether an account is an actual member of a club (Member tier or above). */
export async function isClubMember(
	db: D1Database,
	clubId: number,
	accountId: number
): Promise<boolean> {
	return (await getMembership(db, clubId, accountId)) >= MEMBER_THRESHOLD
}

/**
 * Have `accountId` join a club. On an Open club they become a `Member` immediately;
 * on an InviteOnly/AskToJoin club the join is recorded as `PendingRequested` (an
 * approval flow, not yet a member). Idempotent for anyone already a member, and a
 * no-op for a banned account. Returns the club with its refreshed MemberCount, or
 * null when the club doesn't exist.
 */
export async function joinClub(
	db: D1Database,
	clubId: number,
	accountId: number
): Promise<Club | null> {
	const club = await getClub(db, clubId)
	if (!club) return null

	const current = await getMembership(db, clubId, accountId)
	// A ban can't be shed by re-joining, and an existing member/pending stays as-is.
	if (current === ClubMembershipType.Banned || current >= MEMBER_THRESHOLD) {
		return club
	}
	const next =
		club.Joinability === ClubJoinability.Open
			? ClubMembershipType.Member
			: ClubMembershipType.PendingRequested
	await setMembership(db, clubId, accountId, next)

	const count = await syncMemberCount(db, clubId)
	return { ...club, MemberCount: count }
}

/**
 * Remove `accountId`'s membership of a club (idempotent). A ban is preserved — you
 * can't clear it by leaving — but any member/pending row is dropped. Returns the
 * club with its refreshed MemberCount, or null when the club doesn't exist. The
 * club itself is left in place even when the last member leaves.
 */
export async function leaveClub(
	db: D1Database,
	clubId: number,
	accountId: number
): Promise<Club | null> {
	const club = await getClub(db, clubId)
	if (!club) return null
	await db
		.prepare(
			'DELETE FROM club_member WHERE club_id = ?1 AND account_id = ?2 AND membership_type <> ?3'
		)
		.bind(clubId, accountId, ClubMembershipType.Banned)
		.run()
	const count = await syncMemberCount(db, clubId)
	return { ...club, MemberCount: count }
}
