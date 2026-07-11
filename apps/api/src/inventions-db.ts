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

/** Schema DDL (mirror of migrations/0002_invention.sql, sans any seed rows). */
export const SCHEMA_DDL: string[] = [
	`CREATE TABLE IF NOT EXISTS invention (
		data TEXT NOT NULL,
		id INTEGER GENERATED ALWAYS AS (json_extract(data, '$.InventionId')) VIRTUAL,
		creator_player_id INTEGER GENERATED ALWAYS AS (json_extract(data, '$.CreatorPlayerId')) VIRTUAL
	)`,
	`CREATE UNIQUE INDEX IF NOT EXISTS idx_invention_id ON invention (id)`,
	`CREATE INDEX IF NOT EXISTS idx_invention_creator ON invention (creator_player_id)`,
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
}

interface InventionRow {
	data: string
}

/** Fields the client supplies on save (camelCase); everything else is defaulted here. */
export interface NewInvention {
	creatorPlayerId: number
	name: string
	description?: string | null
	imageName?: string | null
	instantiationCost?: number
	lightsCost?: number
	chipsCost?: number
	cloudVariablesCost?: number
	aiCost?: number
	creationRoomId?: number | null
	inventionDataFilename?: string | null
	referencedInventions?: number[]
	creatorAccountRole?: number
}

/**
 * Insert a new invention record, returning the stored row. A freshly saved
 * invention is private/unpublished — it shows up only in the creator's own list
 * until they publish it, so Accessibility/IsPublished/FirstPublishedAt reflect that.
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
		Name: input.name,
		Description: input.description ?? '',
		ImageName: input.imageName ?? '',
		CurrentVersionNumber: 1,
		CurrentVersion: {
			InventionId: inventionId,
			ReplicationId: crypto.randomUUID(),
			VersionNumber: 1,
			BlobName: input.inventionDataFilename ?? '',
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
		CreatorPermission: input.creatorAccountRole ?? 0,
		GeneralPermission: 0,
		IsAGInvention: false,
		IsCertifiedInvention: false,
		Price: 0,
		AllowTrial: false,
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
