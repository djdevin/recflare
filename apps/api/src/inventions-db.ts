/**
 * Saved-invention storage on the shared `recflare` D1 database. Each invention is
 * a single JSON blob in the `data` column; queryable fields (Id, CreatorPlayerId)
 * are SQLite generated (virtual) columns extracted from that JSON — the same
 * JSON-blob pattern the image/rooms/accounts tables use.
 *
 * The `api` worker owns this schema/migration (migrations/0002_invention.sql,
 * applied under its own `migrations_table`). The invention's data file itself is
 * uploaded separately through the `storage` worker (under the `invention/` prefix)
 * and referenced here by `CurrentVersion.BlobName`; only the metadata lives here.
 *
 * The stored/returned DTO mirrors Rec Room's `RRInvention` (PascalCase), including
 * the nested `CurrentVersion` that carries the blob name and per-version costs —
 * shaped after a real `GET /api/inventions/v1?inventionId=…` response.
 */

/**
 * Schema DDL (mirror of migrations/0002_invention.sql + 0003_invention_featured.sql,
 * sans any seed rows). `is_featured` backs the featured feed's query; json_extract
 * of a JSON `true` is 1, so the column is 1/0.
 */
export const SCHEMA_DDL: string[] = [
	`CREATE TABLE IF NOT EXISTS invention (
		data TEXT NOT NULL,
		id INTEGER GENERATED ALWAYS AS (json_extract(data, '$.InventionId')) VIRTUAL,
		creator_player_id INTEGER GENERATED ALWAYS AS (json_extract(data, '$.CreatorPlayerId')) VIRTUAL,
		is_featured INTEGER GENERATED ALWAYS AS (json_extract(data, '$.IsFeatured')) VIRTUAL
	)`,
	`CREATE UNIQUE INDEX IF NOT EXISTS idx_invention_id ON invention (id)`,
	`CREATE INDEX IF NOT EXISTS idx_invention_creator ON invention (creator_player_id)`,
	`CREATE INDEX IF NOT EXISTS idx_invention_featured ON invention (is_featured)`,
]

/** A single saved version of an invention (Rec Room's `RRInventionVersion`). */
export interface InventionVersion {
	InventionId: number
	ReplicationId: string
	VersionNumber: number
	BlobName: string
	BlobHash: string | null
	InstantiationCost: number
	LightsCost: number
	ChipsCost: number
	CloudVariablesCost: number
	AICost: number
}

/**
 * Where a tag came from. 1 is a third kind the real API emits (the size bucket,
 * e.g. `medium`) that nothing here produces, so it's named but unused.
 */
export const INVENTION_TAG_TYPE = {
	custom: 0, // user submitted
	unknown: 1,
	auto: 2, // derived from the invention itself, e.g. `useonly` / `lowink`
} as const

/**
 * A tag on an invention (Rec Room's `RRInventionTag`). Stored on the record and
 * echoed back through `v1/details`; `v1/settags` answers with the bare tag names.
 */
export interface InventionTag {
	Tag: string
	Type: number
}

/** A stored invention record (Rec Room's `RRInvention`; returned by save / mine). */
export interface SavedInvention {
	InventionId: number
	ReplicationId: string
	CreatorPlayerId: number
	Name: string
	Description: string
	ImageName: string
	CurrentVersionNumber: number
	CurrentVersion: InventionVersion
	Accessibility: number
	IsPublished: boolean
	IsFeatured: boolean
	ModifiedAt: string
	CreatedAt: string
	FirstPublishedAt: string | null
	CreationRoomId: number
	NumPlayersHaveUsedInRoom: number
	NumDownloads: number
	CheerCount: number
	CreatorPermission: number
	GeneralPermission: number
	IsAGInvention: boolean
	IsCertifiedInvention: boolean
	Price: number
	AllowTrial: boolean
	HideFromPlayer: boolean
	ReferencedInventions: number[]
	/**
	 * Tags served by `v1/details` and written by `v1/settags`. Optional and unset on
	 * save: the real `RRInvention` carries no Tags field and the client sends no tags
	 * when saving, so an untagged invention's DTO stays identical to the real one.
	 */
	Tags?: InventionTag[]
}

interface InventionRow {
	data: string
}

/**
 * What the client expects back from `v6/save`: the invention and its version side
 * by side under a status envelope, rather than the single nested `RRInvention` the
 * read endpoints return. `Status` is 0 on success.
 */
export interface InventionSaveResult {
	Status: number
	Invention: SavedInvention
	InventionVersion: InventionVersion
}

/** Wrap a stored invention in the save envelope, lifting out its current version. */
export function toSaveResult(invention: SavedInvention): InventionSaveResult {
	return { Status: 0, Invention: invention, InventionVersion: invention.CurrentVersion }
}

/**
 * Invention data blobs are named `<name>.inv`, and the client expects the extension
 * on the `BlobName` it reads back. Uploads through the `storage` worker already land
 * under an `.inv` key, so this is a no-op for them; it's here so a `BlobName` we hand
 * the client can never be missing the extension.
 */
function inventionBlobName(filename: string): string {
	return filename.toLowerCase().endsWith('.inv') ? filename : `${filename}.inv`
}

/**
 * Fields the client supplies on save (camelCase); everything else is defaulted here.
 * `inventionDataFilename` is the one the caller must supply — an invention with no
 * data blob is unusable. An empty `name`/`description` is defaulted, not rejected.
 */
export interface NewInvention {
	creatorPlayerId: number
	inventionDataFilename: string
	name?: string | null
	description?: string | null
	imageName?: string | null
	instantiationCost?: number
	lightsCost?: number
	chipsCost?: number
	cloudVariablesCost?: number
	aiCost?: number
	creationRoomId?: number | null
	referencedInventions?: number[]
}

/**
 * Insert a new invention record, returning the stored row. A freshly saved
 * invention is private/unpublished — it shows up only in the creator's own list
 * until they publish it, so Accessibility/IsPublished/FirstPublishedAt reflect that.
 *
 * It is, however, fully permissioned from the start: the creator gets Unlimited over
 * their own invention, and so does everyone else once it's published — publishing is
 * what narrows `GeneralPermission` down (to UseOnly by default). Trials are allowed.
 * The client's `creatorAccountRole` is ignored: it's the player's role in the room
 * they built it in, not a permission over the invention.
 */
export async function createInvention(
	db: D1Database,
	input: NewInvention
): Promise<SavedInvention> {
	// Sequential id: one past the current max (the table starts empty).
	const row = await db
		.prepare('SELECT COALESCE(MAX(id), 0) + 1 AS next FROM invention')
		.first<{ next: number }>()
	const inventionId = row?.next ?? 1
	const now = new Date().toISOString()
	const invention: SavedInvention = {
		InventionId: inventionId,
		ReplicationId: crypto.randomUUID(),
		CreatorPlayerId: input.creatorPlayerId,
		Name: input.name?.trim() || 'Untitled',
		Description: input.description?.trim() || 'No description yet',
		ImageName: input.imageName ?? '',
		CurrentVersionNumber: 1,
		CurrentVersion: {
			InventionId: inventionId,
			ReplicationId: crypto.randomUUID(),
			VersionNumber: 1,
			BlobName: inventionBlobName(input.inventionDataFilename),
			BlobHash: null,
			InstantiationCost: input.instantiationCost ?? 0,
			LightsCost: input.lightsCost ?? 0,
			ChipsCost: input.chipsCost ?? 0,
			CloudVariablesCost: input.cloudVariablesCost ?? 0,
			AICost: input.aiCost ?? 0,
		},
		Accessibility: 0,
		IsPublished: false,
		IsFeatured: false,
		ModifiedAt: now,
		CreatedAt: now,
		FirstPublishedAt: null,
		CreationRoomId: input.creationRoomId ?? 0,
		NumPlayersHaveUsedInRoom: 0,
		NumDownloads: 0,
		CheerCount: 0,
		CreatorPermission: INVENTION_PERMISSION.unlimited,
		GeneralPermission: INVENTION_PERMISSION.unlimited,
		IsAGInvention: false,
		IsCertifiedInvention: false,
		Price: 0,
		AllowTrial: true,
		HideFromPlayer: false,
		ReferencedInventions: input.referencedInventions ?? [],
	}
	await db.prepare('INSERT INTO invention (data) VALUES (?1)').bind(JSON.stringify(invention)).run()
	return invention
}

/**
 * The inventions a player has created — their "my inventions" list, newest first.
 * Uses the creator_player_id index; the per-player set is small, so ordering is
 * done in memory. Returns a bare array of SavedInvention.
 */
export async function getInventionsByCreator(
	db: D1Database,
	creatorPlayerId: number
): Promise<SavedInvention[]> {
	const { results } = await db
		.prepare('SELECT data FROM invention WHERE creator_player_id = ?1')
		.bind(creatorPlayerId)
		.all<InventionRow>()
	return results
		.map((r) => JSON.parse(r.data) as SavedInvention)
		.sort((a, b) => b.CreatedAt.localeCompare(a.CreatedAt) || b.InventionId - a.InventionId)
}

/**
 * Invention search — the browse/search list the client shows when picking an
 * invention to spawn. Only published, non-hidden inventions are visible here (a
 * player's own unpublished ones come from `getInventionsByCreator`). `value` is
 * matched case-insensitively against the name and description, term by term; an
 * empty `value` browses everything published. Paginated via skip/take, newest
 * first. Returns a bare array — the shape the client expects from v2/search.
 */
export async function searchInventions(
	db: D1Database,
	value: string,
	skip: number,
	take: number
): Promise<SavedInvention[]> {
	let inventions = await publicInventions(db)

	const terms = value
		.trim()
		.toLowerCase()
		.split(/[\s+]+/)
		.filter(Boolean)
	for (const term of terms) {
		inventions = inventions.filter(
			(i) => i.Name.toLowerCase().includes(term) || i.Description.toLowerCase().includes(term)
		)
	}

	return inventions
		.sort((a, b) => b.CreatedAt.localeCompare(a.CreatedAt) || b.InventionId - a.InventionId)
		.slice(skip, skip + take)
}

/**
 * Every invention any player may see: published and not hidden. The feeds and
 * search all draw from this set; a player's own unpublished inventions reach them
 * only through `getInventionsByCreator`. `featuredOnly` narrows to the curated
 * ones via the indexed `is_featured` column.
 */
async function publicInventions(db: D1Database, featuredOnly = false): Promise<SavedInvention[]> {
	// json_extract of a JSON `true` is 1, so these filters stay in SQL.
	const { results } = await db
		.prepare(
			`SELECT data FROM invention
			 WHERE json_extract(data, '$.IsPublished') = 1
			   AND json_extract(data, '$.HideFromPlayer') = 0
			   ${featuredOnly ? 'AND is_featured = 1' : ''}`
		)
		.all<InventionRow>()
	return results.map((r) => JSON.parse(r.data) as SavedInvention)
}

/** Engagement score used to rank the top feed (downloads weigh most, then cheers). */
function topScore(invention: SavedInvention): number {
	const n = (v: unknown): number => (typeof v === 'number' ? v : 0)
	return (
		n(invention.NumDownloads) * 3 +
		n(invention.CheerCount) * 2 +
		n(invention.NumPlayersHaveUsedInRoom)
	)
}

/**
 * The "top today" feed — published inventions ranked by engagement. The real feed
 * ranks by *today's* activity; we don't track per-day counters, so this ranks by
 * lifetime engagement instead. Ties fall back to invention id so paging is stable.
 * Paginated via skip/take; returns a bare array, like the other invention feeds.
 */
export async function getTopInventions(
	db: D1Database,
	skip: number,
	take: number
): Promise<SavedInvention[]> {
	const inventions = await publicInventions(db)
	return inventions
		.sort((a, b) => topScore(b) - topScore(a) || b.InventionId - a.InventionId)
		.slice(skip, skip + take)
}

/**
 * The featured feed — published inventions flagged `IsFeatured`, newest first.
 * Selected on the indexed `is_featured` column rather than by parsing every public
 * invention. Nothing sets that flag yet, so this falls back to the top feed rather
 * than handing the client an empty shelf; once inventions are curated it serves them.
 */
export async function getFeaturedInventions(
	db: D1Database,
	skip: number,
	take: number
): Promise<SavedInvention[]> {
	const featured = await publicInventions(db, true)
	if (featured.length === 0) return getTopInventions(db, skip, take)
	return featured
		.sort((a, b) => b.CreatedAt.localeCompare(a.CreatedAt) || b.InventionId - a.InventionId)
		.slice(skip, skip + take)
}

/**
 * Replace an invention's tags (the `v1/settags` write). Auto tags are the ones the
 * client derives from the invention itself (Type 2); custom tags are the creator's
 * own (Type 0). Both lists are replaced wholesale — auto first, then custom, the
 * order the tags come back in — and are lowercased/trimmed and de-duplicated so
 * `details` doesn't echo back near-duplicates. Returns the stored tag list, or null
 * when there's no such invention.
 */
export async function setInventionTags(
	db: D1Database,
	inventionId: number,
	autoTags: string[],
	customTags: string[]
): Promise<InventionTag[] | null> {
	const invention = await getInventionById(db, inventionId)
	if (invention === null) return null

	const tags: InventionTag[] = []
	const seen = new Set<string>()
	for (const [list, type] of [
		[autoTags, INVENTION_TAG_TYPE.auto],
		[customTags, INVENTION_TAG_TYPE.custom],
	] as const) {
		for (const raw of list) {
			const tag = raw.trim().toLowerCase()
			if (tag === '' || seen.has(tag)) continue
			seen.add(tag)
			tags.push({ Tag: tag, Type: type })
		}
	}

	await writeInvention(db, { ...invention, Tags: tags })
	return tags
}

/**
 * What other players may do with a published invention — the `GeneralPermission`
 * ladder, each level implying the ones below it. `v1/update` takes these by name or
 * number (`permission=useonly` / `permission=20`), and `v3/publish` defaults to
 * UseOnly.
 */
export const INVENTION_PERMISSION = {
	unassigned: 0,
	limitedoneuseonly: 10,
	useonly: 20,
	editandsave: 40,
	publish: 60,
	charge: 80,
	unlimited: 100,
} as const

/**
 * Parse a permission level the way the client sends it: a name (`useonly`,
 * `edit_and_save`) or the raw number. Undefined when it's neither.
 */
export function parsePermissionLevel(value: string): number | undefined {
	const key = value.trim().toLowerCase().replace(/_/g, '')
	if (key in INVENTION_PERMISSION) {
		return INVENTION_PERMISSION[key as keyof typeof INVENTION_PERMISSION]
	}
	const numeric = Number.parseInt(value.trim(), 10)
	return Number.isNaN(numeric) ? undefined : numeric
}

/** Fields `v1/update` can change. Anything left undefined keeps its stored value. */
export interface InventionPatch {
	name?: string
	description?: string
	imageName?: string
	allowTrial?: boolean
	generalPermission?: number
}

/**
 * Apply an edit to an invention's metadata (the `v1/update` write). Only the keys
 * present on the patch change; everything else — versions, counters, published
 * state — is left alone. Publishing and pricing are deliberately *not* here: they
 * go through `publishInvention` / `setInventionPrice`, as they do in the real API.
 * Returns the updated invention, or null when there's no such row.
 */
export async function updateInvention(
	db: D1Database,
	inventionId: number,
	patch: InventionPatch
): Promise<SavedInvention | null> {
	const invention = await getInventionById(db, inventionId)
	if (invention === null) return null

	const updated: SavedInvention = {
		...invention,
		Name: patch.name ?? invention.Name,
		Description: patch.description ?? invention.Description,
		ImageName: patch.imageName ?? invention.ImageName,
		AllowTrial: patch.allowTrial ?? invention.AllowTrial,
		GeneralPermission: patch.generalPermission ?? invention.GeneralPermission,
	}
	await writeInvention(db, updated)
	return updated
}

/**
 * Publish an invention (`v3/publish`) — what puts it into search and the feeds.
 * Publishing sets the permission other players get (UseOnly unless the creator asks
 * for another level) and its price, and the first publish stamps `FirstPublishedAt`.
 * Returns the published invention, or null when there's no such row.
 */
export async function publishInvention(
	db: D1Database,
	inventionId: number,
	permissionLevel: number | undefined,
	price: number | undefined
): Promise<SavedInvention | null> {
	const invention = await getInventionById(db, inventionId)
	if (invention === null) return null

	const updated: SavedInvention = {
		...invention,
		IsPublished: true,
		GeneralPermission: permissionLevel ?? INVENTION_PERMISSION.useonly,
		Price: price ?? 0,
		FirstPublishedAt: invention.FirstPublishedAt ?? new Date().toISOString(),
	}
	await writeInvention(db, updated)
	return updated
}

/**
 * Set an invention's price (`v1/updateprice`). Returns the updated invention, or
 * null when there's no such row; the caller rejects negative prices.
 */
export async function setInventionPrice(
	db: D1Database,
	inventionId: number,
	price: number
): Promise<SavedInvention | null> {
	const invention = await getInventionById(db, inventionId)
	if (invention === null) return null
	const updated: SavedInvention = { ...invention, Price: price }
	await writeInvention(db, updated)
	return updated
}

/** The tag filter chips the client offers when browsing inventions. */
export interface InventionTagFilters {
	PinnedFilters: string[]
	PopularFilters: string[]
	TrendingFilters: string[] | null
}

/**
 * The tag filters shown on the invention browse screen (`v1/tagfilters`), derived
 * from the tags actually in use: the most common tags across published inventions,
 * most popular first, with the top few pinned. `TrendingFilters` is null — that
 * needs recent-activity tracking we don't keep, and the client treats it as absent.
 *
 * With no published, tagged inventions this is empty, which just means no chips.
 */
export async function getInventionTagFilters(db: D1Database): Promise<InventionTagFilters> {
	const counts = new Map<string, number>()
	for (const invention of await publicInventions(db)) {
		for (const tag of invention.Tags ?? []) {
			counts.set(tag.Tag, (counts.get(tag.Tag) ?? 0) + 1)
		}
	}

	const popular = [...counts.entries()]
		.sort(([tagA, countA], [tagB, countB]) => countB - countA || tagA.localeCompare(tagB))
		.slice(0, 20)
		.map(([tag]) => tag)

	return {
		PinnedFilters: popular.slice(0, 5),
		PopularFilters: popular,
		TrendingFilters: null,
	}
}

/**
 * Look up a batch of inventions by id (`v2/batch?id=1&id=2`). Returns whatever
 * exists, in the order the ids were asked for; unknown ids are simply absent. The
 * caller decides who may see what — an unpublished invention is visible only to its
 * creator — so this returns the rows unfiltered.
 */
export async function getInventionsByIds(
	db: D1Database,
	inventionIds: number[]
): Promise<SavedInvention[]> {
	if (inventionIds.length === 0) return []
	const placeholders = inventionIds.map((_, i) => `?${i + 1}`).join(', ')
	const { results } = await db
		.prepare(`SELECT data FROM invention WHERE id IN (${placeholders})`)
		.bind(...inventionIds)
		.all<InventionRow>()

	const byId = new Map<number, SavedInvention>()
	for (const row of results) {
		const invention = JSON.parse(row.data) as SavedInvention
		byId.set(invention.InventionId, invention)
	}
	return inventionIds.map((id) => byId.get(id)).filter((i): i is SavedInvention => i !== undefined)
}

/**
 * The inventions belonging to a room (`v1/room?id=…`) — the ones created there,
 * matched on `CreationRoomId`. Published, non-hidden only, so this can't expose a
 * creator's drafts to everyone else in the room. Newest first, paginated via
 * skip/take; bare array, like the other invention lists.
 */
export async function getInventionsByRoom(
	db: D1Database,
	roomId: number,
	skip: number,
	take: number
): Promise<SavedInvention[]> {
	const { results } = await db
		.prepare(
			`SELECT data FROM invention
			 WHERE json_extract(data, '$.CreationRoomId') = ?1
			   AND json_extract(data, '$.IsPublished') = 1
			   AND json_extract(data, '$.HideFromPlayer') = 0`
		)
		.bind(roomId)
		.all<InventionRow>()
	return results
		.map((r) => JSON.parse(r.data) as SavedInvention)
		.sort((a, b) => b.CreatedAt.localeCompare(a.CreatedAt) || b.InventionId - a.InventionId)
		.slice(skip, skip + take)
}

/**
 * A single version of an invention (`v1/version?inventionId=…&version=…`), which
 * is how the client resolves the blob to download for a given version number.
 *
 * We keep only the current version on the record — nothing writes version history
 * (there's no `v4/addversion` yet), and a fresh save is always version 1. So this
 * answers for the current version number and reports null for any other, rather
 * than inventing a version whose blob doesn't exist.
 */
export async function getInventionVersion(
	db: D1Database,
	inventionId: number,
	versionNumber: number
): Promise<InventionVersion | null> {
	const invention = await getInventionById(db, inventionId)
	if (invention === null) return null
	return invention.CurrentVersionNumber === versionNumber ? invention.CurrentVersion : null
}

/** Persist an edited invention record, bumping ModifiedAt. */
async function writeInvention(db: D1Database, invention: SavedInvention): Promise<void> {
	const updated: SavedInvention = { ...invention, ModifiedAt: new Date().toISOString() }
	await db
		.prepare('UPDATE invention SET data = ?1 WHERE id = ?2')
		.bind(JSON.stringify(updated), invention.InventionId)
		.run()
}

/**
 * The tags shown on an invention's detail card (`v1/details`). Returns null when
 * there's no such invention, so the route can 404 rather than pretend the id is a
 * real, untagged invention. Untagged inventions come back as an empty list — which
 * is every invention today, since nothing writes tags yet.
 */
export async function getInventionTags(
	db: D1Database,
	inventionId: number
): Promise<InventionTag[] | null> {
	const invention = await getInventionById(db, inventionId)
	return invention === null ? null : (invention.Tags ?? [])
}

/** Look up a single invention by its numeric id, or null when there's no such row. */
export async function getInventionById(
	db: D1Database,
	inventionId: number
): Promise<SavedInvention | null> {
	const row = await db
		.prepare('SELECT data FROM invention WHERE id = ?1')
		.bind(inventionId)
		.first<InventionRow>()
	return row ? (JSON.parse(row.data) as SavedInvention) : null
}
