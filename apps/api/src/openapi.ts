import { resolver } from 'hono-openapi'
import { z } from 'zod'

import type { OpenAPIV3_1 } from 'openapi-types'

/**
 * OpenAPI schemas for the api worker.
 *
 * IMPORTANT: these are DESCRIPTIVE ONLY. They are passed to `describeRoute` to
 * generate the spec and are never wired into `hono-openapi`'s `validator()`. Same
 * rationale as the auth/accounts/match/econ workers: a reverse-engineered protocol,
 * lenient handlers, no runtime validation.
 *
 * Do NOT add `.meta({ id })` to these schemas — with this hono-openapi + zod v4 setup a
 * meta'd schema used in a response emits a `$ref` the framework doesn't always hoist
 * into `components.schemas`, leaving a dangling reference. Leaving meta off makes every
 * schema inline, which renders correctly in any tool.
 */

/** Emit a zod schema as an `application/json` response body. */
export function json(schema: z.ZodType, description: string) {
	return { description, content: { 'application/json': { schema: resolver(schema) } } }
}

function toOpenApiSchema(schema: z.ZodType): OpenAPIV3_1.SchemaObject {
	const { $schema: _$schema, additionalProperties: _extra, ...jsonSchema } = z.toJSONSchema(schema)
	return jsonSchema as OpenAPIV3_1.SchemaObject
}

/** A form-urlencoded / multipart request body (the client posts both). */
export function form(schema: z.ZodType, description: string): OpenAPIV3_1.RequestBodyObject {
	const s = toOpenApiSchema(schema)
	return {
		description,
		content: {
			'application/x-www-form-urlencoded': { schema: s },
			'multipart/form-data': { schema: s },
		},
	}
}

/** An `application/json` request body. */
export function jsonBody(schema: z.ZodType, description: string): OpenAPIV3_1.RequestBodyObject {
	return { description, content: { 'application/json': { schema: toOpenApiSchema(schema) } } }
}

/** The empty-body 401 the auth-gated routes return. */
export const UNAUTHORIZED_RESPONSE = { description: 'Missing or invalid bearer token (empty body)' }

/** Bearer-JWT security requirement, for the auth-gated routes. */
export const AUTHED = [{ bearerAuth: [] }]

/** An integer path parameter (ids are constrained to `[0-9]+` by the route pattern). */
export function idParam(name: string, description: string): OpenAPIV3_1.ParameterObject {
	return { name, in: 'path', required: true, description, schema: { type: 'integer' } }
}

/** A string path parameter. */
export function stringParam(name: string, description: string): OpenAPIV3_1.ParameterObject {
	return { name, in: 'path', required: true, description, schema: { type: 'string' } }
}

/** An optional string query parameter. */
export function stringQuery(name: string, description: string): OpenAPIV3_1.ParameterObject {
	return { name, in: 'query', required: false, description, schema: { type: 'string' } }
}

/** An optional integer query parameter (`skip` / `take` / `sort` / `filter`). */
export function intQuery(name: string, description: string): OpenAPIV3_1.ParameterObject {
	return { name, in: 'query', required: false, description, schema: { type: 'integer' } }
}

/** The `skip`/`take` pair every paginated feed accepts. */
export function pageParams(defaultTake: number): OpenAPIV3_1.ParameterObject[] {
	return [
		intQuery('skip', 'How many entries to skip (default 0)'),
		intQuery('take', `How many entries to return (default ${defaultTake})`),
	]
}

// ---- Loose shapes ----------------------------------------------------------
// Several routes serve opaque static config blobs (the game configs, the charades word
// list) or empty-list stubs. Modelling every field adds noise without value, so these
// use deliberately loose schemas.

/** An opaque JSON object (a static config blob, a stub, …). */
export const JsonObject = z.record(z.string(), z.unknown())
/** An opaque JSON array (a static list served verbatim, or an empty-list stub). */
export const JsonArray = z.array(z.unknown())

/** A bare JSON boolean — several routes answer `true`/`false` with no envelope. */
export const BareBoolean = z.boolean()

/** A bare JSON string (`POST /api/sanitize/v1` echoes one back). */
export const BareString = z.string()

/** The `{ error }` body the 400 / 403 branches return. */
export const ErrorResponse = z.object({ error: z.string() })

// ---- Config ----------------------------------------------------------------

/** `GET /api/config/v1/amplitude` — analytics keys (all disabled on this server). */
export const AmplitudeConfig = z.object({
	AmplitudeKey: z.string(),
	StatSigKey: z.string(),
	RudderStackKey: z.string(),
	UseRudderStack: z.boolean(),
})

/** `GET /api/config/v1/azurespeech` — speech-to-text config; `Enabled` is false here. */
export const AzureSpeechConfig = z.object({
	Key: z.string(),
	Region: z.string(),
	Enabled: z.boolean(),
})

/** `GET /api/config/v1/backtrace` — the client's crash-reporter budget and filters. */
export const BacktraceConfig = z.object({
	ReportBudget: z.int(),
	FilterType: z.int(),
	SampleRate: z.int(),
	LogLineCount: z.int(),
	CaptureNativeCrashes: z.int(),
	AMRThresholdMS: z.int(),
	MessageCount: z.int(),
	MessageRegex: z.string(),
	VersionRegex: z.string(),
})

/**
 * `GET /api/config/v2` — the big client config blob (a static asset), with
 * `ShareBaseUrl` derived from the deploy-time base domain.
 */
export const ApiConfigV2 = JsonObject.describe(
	'The static client config, plus a ShareBaseUrl templated from the deploy domain'
)

/** `GET /api/versioncheck/v4` — whether the client's `?v=` build matches GAME_VERSION. */
export const VersionCheck = z.object({
	VersionStatus: z.int().describe('0 = current, 1 = client on a different build'),
	UpdateNotificationStage: z.int(),
	IsVersionIslanded: z.boolean(),
	IsCrossPlayDisabled: z.boolean(),
})

// ---- Social ----------------------------------------------------------------

/**
 * The per-player relationship projection (`RelationshipResponse`). `PlayerID` is the
 * OTHER player; the type and flags are taken from the caller's own side of the row, so
 * the two players in a pair see different projections of it.
 */
export const RelationshipDto = z.object({
	PlayerID: z.int().describe('The other player in the pair'),
	RelationshipType: z
		.int()
		.describe('0 = none, 1 = friend request sent, 2 = friend request received, 3 = friend'),
	Favorited: z.int().describe('0/1 — the caller‘s own flag'),
	Ignored: z.int().describe('0/1 — the caller‘s own flag'),
	Muted: z.int().describe('0/1 — the caller‘s own flag'),
})

/** The `{ Success, Message }` ack the flag toggles answer with. */
export const AckResponse = z.object({ Success: z.boolean(), Message: z.string() })

// ---- Progression -----------------------------------------------------------

/**
 * A player's reputation (cheer counters). Nobody has earned cheers yet, so every
 * counter is 0 and everyone has their full credit. `SelectedCheer` is an int (0 = none),
 * not null, and `IsCheerful` is true — the client reads it to decide whether the player
 * may hand out cheers at all.
 */
export const ReputationDto = z.object({
	AccountId: z.int(),
	IsCheerful: z.boolean(),
	Noteriety: z.int(),
	SelectedCheer: z.int().describe('0 = none selected'),
	CheerCredit: z.int(),
	CheerGeneral: z.int(),
	CheerHelpful: z.int(),
	CheerCreative: z.int(),
	CheerGreatHost: z.int(),
	CheerSportsman: z.int(),
	SubscriberCount: z.int(),
	SubscribedCount: z.int(),
})

/** A player's level/XP (`/api/players/v1/progression/:id`). */
export const ProgressionDto = z.object({
	PlayerId: z.int(),
	Level: z.int(),
	XP: z.int(),
})

/** The `Ids` form body the bulk POST endpoints take. */
export const BulkIdsRequest = z.object({
	Ids: z.string().describe('Comma-separated account ids, e.g. `1,2,3`'),
})

// ---- Inventions ------------------------------------------------------------

/** One version of an invention — carries the blob name the client downloads. */
export const InventionVersionDto = z.object({
	InventionId: z.int(),
	ReplicationId: z.string(),
	VersionNumber: z.int(),
	BlobName: z.string().describe('The `.inv` key in the storage worker‘s bucket'),
	BlobHash: z.string().nullable(),
	InstantiationCost: z.int(),
	LightsCost: z.int(),
	ChipsCost: z.int(),
	CloudVariablesCost: z.int(),
	AICost: z.int(),
})

/** A tag on an invention. `Type` 0 = custom (creator-submitted), 2 = auto-derived. */
export const InventionTagDto = z.object({
	Tag: z.string(),
	Type: z.int().describe('0 = custom, 2 = auto'),
})

/** A stored invention record (the reference's `RRInvention`). */
export const InventionDto = z.object({
	InventionId: z.int(),
	ReplicationId: z.string(),
	CreatorPlayerId: z.int(),
	Name: z.string(),
	Description: z.string(),
	ImageName: z.string(),
	CurrentVersionNumber: z.int(),
	CurrentVersion: InventionVersionDto,
	Accessibility: z.int(),
	IsPublished: z.boolean().describe('Unpublished inventions are visible only to their creator'),
	IsFeatured: z.boolean(),
	ModifiedAt: z.string(),
	CreatedAt: z.string(),
	FirstPublishedAt: z.string().nullable(),
	CreationRoomId: z.int(),
	NumPlayersHaveUsedInRoom: z.int(),
	NumDownloads: z.int(),
	CheerCount: z.int(),
	CreatorPermission: z.int(),
	GeneralPermission: z.int().describe('What other players may do with it once published'),
	IsAGInvention: z.boolean(),
	IsCertifiedInvention: z.boolean(),
	Price: z.int(),
	AllowTrial: z.boolean(),
	HideFromPlayer: z.boolean(),
	ReferencedInventions: z.array(z.int()),
	Tags: z
		.array(InventionTagDto)
		.optional()
		.describe('Unset on save — the real RRInvention carries no Tags field'),
})

/** The `{ Status, Invention, InventionVersion }` envelope every invention write answers. */
export const InventionSaveResult = z.object({
	Status: z.int().describe('0 = success'),
	Invention: InventionDto,
	InventionVersion: InventionVersionDto,
})

/** The tag filter chips on a browse screen, derived from the tags actually in use. */
export const TagFilters = z.object({
	PinnedFilters: z.array(z.string()),
	PopularFilters: z.array(z.string()),
	TrendingFilters: z
		.array(z.string())
		.nullable()
		.describe('Null — needs recent-activity data we don‘t keep'),
})

/** `GET /api/inventions/v1/details` — an invention's detail card is just its tags. */
export const InventionDetails = z.object({ Tags: z.array(InventionTagDto) })

/** `GET /api/inventions/v1/personaldetails/:id` — the caller's own relation to it. */
export const InventionPersonalDetails = z.object({
	IsCheering: z.boolean().describe('Always false — nothing can cheer an invention yet'),
})

/** `POST /api/inventions/v1/settags` JSON body — both lists are replaced wholesale. */
export const SetTagsRequest = z.object({
	InventionId: z.int(),
	AutoTags: z.array(z.string()).optional().describe('Client-derived tags (Type 2)'),
	CustomTags: z.array(z.string()).optional().describe('Creator-submitted tags (Type 0)'),
})

/** `POST /api/inventions/v1/settags` response — `Tags` is the flat list of tag NAMES. */
export const SetTagsResponse = z.object({
	Result: z.int().describe('0 = success'),
	Tags: z.array(z.string()).describe('Auto tags first, then custom'),
})

/** `POST /api/inventions/v1/updateprice` JSON body. */
export const UpdatePriceRequest = z.object({
	InventionId: z.int(),
	Price: z.int().describe('Must be >= 0'),
})

/** `POST /api/inventions/v6/save` JSON body — camelCase, unlike the read shapes. */
export const SaveInventionRequest = z.object({
	inventionDataFilename: z
		.string()
		.describe('The blob uploaded through the storage worker; the one required field'),
	name: z.string().optional().describe('Defaults to “Untitled”'),
	description: z.string().optional(),
	imageName: z.string().optional(),
	instantiationCost: z.int().optional(),
	lightsCost: z.int().optional(),
	chipsCost: z.int().optional(),
	cloudVariablesCost: z.int().optional(),
	aiCost: z.int().optional(),
	creationRoomId: z.int().optional(),
	referencedInventions: z.array(z.int()).optional(),
})

// ---- Avatar / custom avatar items ------------------------------------------

/** `POST /api/avatar/v2/gifts/generate` — a generated gift box (always a token gift). */
export const GeneratedGift = z.object({
	Id: z.int().describe('Always 0 — gifts generated here are not persisted'),
	FromPlayerId: z.int(),
	ConsumableItemDesc: z.string(),
	AvatarItemDesc: z.string(),
	FriendlyName: z.string(),
	AvatarItemType: z.int(),
	EquipmentPrefabName: z.string(),
	EquipmentModificationGuid: z.string(),
	CurrencyType: z.int(),
	Currency: z.int().describe('A random token amount'),
	Xp: z.int(),
	Level: z.int(),
	Platform: z.int(),
	PlatformsToSpawnOn: z.int(),
	BalanceType: z.int(),
	GiftContext: z.int(),
	GiftRarity: z.int(),
	Message: z.string(),
})

/** `POST /api/avatar/v2/gifts/generate` form body. */
export const GenerateGiftRequest = z.object({
	GiftContext: z.string().optional().describe('Where the gift was earned'),
	Message: z.string().optional(),
	Xp: z.string().optional(),
})

/** A paginated custom-avatar-item page (no storage yet, so always empty). */
export const CustomAvatarItemsPage = z.object({
	Results: JsonArray,
	TotalResults: z.int(),
})

/** The `{ success, value }` envelope `isCreationAllowedForAccount` wraps its answer in. */
export const SuccessValueEnvelope = z.object({ success: z.boolean(), value: z.null() })

// ---- Gameplay --------------------------------------------------------------

/** `POST /api/sanitize/v1` JSON body — the text to clean. */
export const SanitizeRequest = z.object({ Value: z.string() })

/** `POST /api/sanitize/v1/isPure` — whether the text is clean (always true here). */
export const IsPureResponse = z.object({ IsPure: z.boolean() })

/** `GET /api/keepsakes/globalconfig` — the keepsake feature switches. */
export const KeepsakeConfig = z.object({
	KeepsakeFeatureEnabled: z.boolean(),
	KeepsakeRoomLimit: z.int(),
	SocialXpBoostEnabled: z.boolean(),
})

/** `GET /api/playerevents/v1/all` — the caller's created events and RSVPs. */
export const PlayerEventsAll = z.object({
	Created: JsonArray,
	Responses: JsonArray,
})

/** `GET /api/playerevents/v1/club/:clubId` — the paged single-club event feed. */
export const PlayerEventsPage = z.object({
	ContinuationToken: z.string().describe('Empty = no next page'),
	Events: JsonArray,
})

/** `POST /api/CampusCard/v1/UpdateAndGetSubscription` — both null (no subs yet). */
export const SubscriptionResponse = z.object({
	subscription: z.null(),
	platformAccountSubscribedPlayerId: z.null(),
})

// ---- Moderation ------------------------------------------------------------

/**
 * `GET /api/PlayerReporting/v1/moderationBlockDetails` — always the "not blocked"
 * answer (no ban storage yet). `ReportCategory` is -1 (no category) rather than 0,
 * which is a real category; `Message` is null, not an empty string — the client
 * distinguishes "no message" from a blank one.
 */
export const ModerationBlockDetails = z.object({
	ReportCategory: z.int().describe('-1 = no category (0 is a real one)'),
	Duration: z.int(),
	GameSessionId: z.int(),
	IsBan: z.boolean(),
	IsHostKick: z.boolean(),
	IsVoiceModAutoban: z.boolean(),
	Message: z.string().nullable(),
	PlayerIdReporter: z.int().nullable(),
	TimeoutStartedAt: z.string().nullable(),
})

/** `POST /api/PlayerReporting/v1/deviceId` form body — the id rotation the client reports. */
export const DeviceIdRequest = z.object({
	oldDeviceId: z.string().optional().describe('The id the client thinks we hold'),
	newDeviceId: z.string().optional(),
	platform: z.string().optional(),
})

// ---- Rooms -----------------------------------------------------------------

/** `GET /api/quickPlay/v1/getandclear` — a pending quick-play action; all null = none. */
export const QuickPlayResponse = z.object({
	RoomName: z.string().nullable(),
	ActionCode: z.string().nullable(),
	TargetPlayerId: z.int().nullable(),
})

/** `POST /api/rooms/v1/verifyRole` form body. */
export const VerifyRoleRequest = z.object({
	roomId: z.string(),
	role: z.string().describe('The minimum role level required'),
	context: z.string().optional().describe('e.g. MakerPen — accepted and ignored'),
})

// ---- Images ----------------------------------------------------------------

/**
 * A stored image record. Note the room photo feed (`/api/images/v4/room/:roomId`)
 * serves this shape raw, while the player lists serve the `ImagesPlayer` projection
 * below — deliberately different, see the client-contract notes in CLAUDE.md.
 */
export const SavedImageDto = z.object({
	Id: z.int(),
	Type: z.int().describe('SavedImageType: 1 = share camera, 3 = room, 4 = profile, …'),
	Accessibility: z.int(),
	AccessibilityLocked: z.boolean(),
	ImageName: z.string().describe('The bucket key the img worker serves it back by'),
	Description: z.string().nullable(),
	PlayerId: z.int(),
	TaggedPlayerIds: z.array(z.int()),
	RoomId: z.int().nullable(),
	PlayerEventId: z.int().nullable(),
	CreatedAt: z.string(),
	CheerCount: z.int(),
	CommentCount: z.int(),
})

/**
 * The client's `ImagesPlayer` projection — the same record with `Id` → `SavedImageId`,
 * `Type` → `SavedImageType` and no `TaggedPlayerIds`. The player photo lists and feed
 * MUST serve this: the raw SavedImage renders blank thumbnails.
 */
export const ImagesPlayerDto = z.object({
	SavedImageId: z.int(),
	SavedImageType: z.int(),
	Accessibility: z.int(),
	AccessibilityLocked: z.boolean(),
	CheerCount: z.int(),
	CommentCount: z.int(),
	CreatedAt: z.string(),
	Description: z.string().nullable(),
	ImageName: z.string(),
	PlayerEventId: z.int().nullable(),
	PlayerId: z.int(),
	RoomId: z.int().nullable(),
})

/** One entry in the anonymous slideshow feed, joined to its creator and room. */
export const SlideshowImageDto = z.object({
	SavedImageId: z.int(),
	ImageName: z.string(),
	Username: z.string(),
	RoomName: z.string().nullable(),
	RoomId: z.int().nullable(),
	SavedImageType: z.int(),
	PlayerEventId: z.int().nullable(),
	Accessibility: z.int(),
	PlayerIds: z.array(z.int()),
})

/** `GET /api/images/v1/slideshow` — the feed plus a short cache hint. */
export const SlideshowResponse = z.object({
	Images: z.array(SlideshowImageDto),
	ValidTill: z.string().describe('ISO timestamp ~2 minutes out; the client refreshes against it'),
})

/** `POST /api/images/v4/uploadsaved` multipart body. */
export const UploadImageRequest = z.object({
	image: z.string().describe('The image file (`file` is accepted too)'),
	imgMeta: z
		.string()
		.optional()
		.describe(
			'A JSON `SavedImageMetaDTO`: { playerIds, savedImageType, roomId, playerEventId, accessibility, description }'
		),
})

/** `POST /api/images/v4/uploadsaved` — the stored bucket key. */
export const UploadImageResponse = z.object({
	ImageName: z.string().describe('The bucket key; the img worker serves the object by it'),
})

/** `DELETE /api/images/v1/deletesaved` JSON body. */
export const DeleteImageRequest = z.object({ ImageName: z.string() })

/** `POST /api/images/v1/cheer` JSON body. */
export const CheerImageRequest = z.object({
	SavedImageId: z.int(),
	Cheer: z.boolean().describe('True to cheer, false to un-cheer'),
})

/** The bare `{ success: true }` ack the image writes answer with. */
export const SuccessResponse = z.object({ success: z.boolean() })

/** One entry of `GET /api/images/v5/cheered/bulk`, one per requested id, in order. */
export const CheeredEntry = z.object({
	SavedImageId: z.int(),
	IsCheered: z.boolean(),
})
