import { Hono } from 'hono'
import { describeRoute, openAPIRouteHandler } from 'hono-openapi'
import { useWorkersLogger } from 'workers-tagged-logger'

import {
	Accessibility,
	canManageRoom,
	cloneRoom,
	cloneSubRoom,
	countRoomsByCreator,
	createSubRoom,
	deleteRoom,
	deleteSubRoom,
	findSubRoom,
	getBaseRooms,
	getFavoritedRooms,
	getFeaturedRooms,
	getHotRooms,
	getInteraction,
	getPresence,
	getPublicRoomsByCreator,
	getRecommendedRooms,
	getRoomById,
	getRoomByName,
	getRoomsByCreator,
	getRoomsByIds,
	getSimilarRooms,
	getSubRoomSaves,
	getVisitedRooms,
	modifySubRoom,
	publishSubRoomSave,
	removeCheer,
	removeFavorite,
	saveSubRoomData,
	searchRooms,
	setRoomDescription,
	setRoomImage,
	setRoomName,
	setRoomRole,
	toggleCheer,
	toggleFavorite,
	toggleRoomTag,
	updateRoomFields,
} from '@repo/domain'
import { intVar, logger, withCleanSpec, withNotFound, withOnError } from '@repo/hono-helpers'
import { validateAndGetAccountId } from '@repo/jwt'

import {
	AccessibilityRequest,
	AUTHED,
	CloneRoomRequest,
	CloningRequest,
	CreateSubRoomRequest,
	DescriptionRequest,
	FeaturedRoomGroupDto,
	FORBIDDEN_RESPONSE,
	form,
	ImageRequest,
	InteractionDto,
	json,
	jsonBody,
	LoadScreenRequest,
	MissingLookupParam,
	ModifySubRoomRequest,
	NameRequest,
	PagedRooms,
	pageParams,
	PhotonAccessTokenDto,
	PlayerDataDto,
	PublishSaveRequest,
	RestrictionsRequest,
	RoleRequest,
	RoomDto,
	RoomEnvelope,
	roomIdParam,
	RoomLookup,
	RoomResultEnvelope,
	RoomSaveEnvelope,
	SaveSubRoomDataRequest,
	ServiceStatus,
	stringQuery,
	SubRoomAccessibilityRequest,
	subRoomIdParam,
	SubRoomSavesPage,
	TagRequest,
	UNAUTHORIZED_EMPTY,
	UNAUTHORIZED_ENVELOPE,
	UNAUTHORIZED_RESPONSE,
	WarningRequest,
} from './openapi'

import type { Context } from 'hono'
import type { App } from './context'

/**
 * Room server. Rooms are stored in D1 as JSON blobs with generated columns for
 * querying (see rooms-db.ts); the dorm (RoomId 1) is seeded by the migration.
 * Responses are the stored JSON verbatim (PascalCase, client-facing shape).
 *
 * The `rooms` prefix maps to this worker's subdomain, so method
 * routes are served bare. The 2023 client also hits several of these without the
 * `/roomserver` prefix, so both forms are registered.
 */

/** Parse the first valid integer id from a comma-separated `id` query param. */
function firstId(idParam: string): number | undefined {
	return idParam
		.split(',')
		.map((s) => Number.parseInt(s.trim(), 10))
		.find((n) => !Number.isNaN(n))
}

/** Parse all valid integer ids from a comma-separated `id` query param. */
function allIds(idParam: string): number[] {
	return idParam
		.split(',')
		.map((s) => Number.parseInt(s.trim(), 10))
		.filter((n) => !Number.isNaN(n))
}

/**
 * How many rooms one account may create, when the `MAX_ROOMS_PER_ACCOUNT` var is
 * unset. Cloning is the only way to make a room, so the cap is enforced there; it
 * counts rooms the account created, minus their auto-provisioned dorm. Setting the
 * var to 0 lifts the cap entirely, which a small private server will want. Existing
 * rooms are never touched — lowering the cap just stops new ones.
 */
const DEFAULT_MAX_ROOMS_PER_ACCOUNT = 10

/** Account ids granted the global (Role 0) maker pen — the reference server's
 * hardcoded moderator/dev accounts. */
const MAKER_PEN_ACCOUNT_IDS = new Set([1, 2, 3])

/** The slice of the shared presence row we read — the caller's current room instance. */
interface PresenceView {
	roomInstanceId?: number
}

/**
 * Room permissions + Photon token the client needs to spawn into a room. The
 * global (Role 0) maker pen is added only for the hardcoded dev accounts, and
 * `RoomInstanceId` is the caller's current instance from presence (null when
 * they aren't in one). `PhotonAccessToken` stays empty — the reference server
 * signs it via `ClientSecurity`, whose secret/algorithm we don't have; our
 * Photon setup accepts an empty token.
 */
function photonAccessToken(accountId: number, roomInstanceId: number | null) {
	const perm = (Permission: string, Role: number, Override: boolean) => ({
		Override,
		Permission,
		Role,
		Type: 0,
		Value: 'True',
	})
	const permissions = [
		perm('CAN_USE_ROOM_RESET_BUTTON', 0, true),
		perm('CAN_USE_DELETE_ALL_BUTTON', 0, true),
		perm('CAN_SAVE_INVENTIONS', 0, true),
		perm('CAN_SPAWN_INVENTIONS', 0, true),
		perm('CAN_USE_PLAY_GIZMOS_TOGGLE', 0, true),
		perm('CAN_USE_MAKER_PEN', 30, false),
		perm('CAN_USE_ROOM_RESET_BUTTON', 30, true),
		perm('CAN_USE_DELETE_ALL_BUTTON', 30, true),
		perm('CAN_SAVE_INVENTIONS', 30, true),
		perm('CAN_SPAWN_INVENTIONS', 30, true),
		perm('CAN_USE_PLAY_GIZMOS_TOGGLE', 30, true),
	]
	if (MAKER_PEN_ACCOUNT_IDS.has(accountId)) {
		permissions.unshift(perm('CAN_USE_MAKER_PEN', 0, true))
	}
	return {
		Permissions: permissions,
		PhotonAccessToken: '',
		RoomInstanceId: roomInstanceId,
	}
}

/**
 * Photon access-token handler (served bare and under `/roomserver`). Auth-gated:
 * resolves the caller, reads their current room instance from the shared
 * `presence` table (see @repo/domain), and returns the permissions + token.
 */
async function handlePhotonAccessToken(c: Context<App>) {
	const accountId = await authedAccountId(c)
	if (accountId === null) return unauthorized(c)
	const presence = await getPresence<PresenceView>(c.env.DB, accountId)
	const roomInstanceId = presence?.roomInstance?.roomInstanceId ?? null
	return c.json(photonAccessToken(accountId, roomInstanceId))
}

/** The Bearer token's account id (`sub`), or null when there's no valid token. */
async function authedAccountId(c: Context<App>): Promise<number | null> {
	return validateAndGetAccountId(c.req.raw, await c.env.JWT_SECRET.get())
}

/** 401 for the auth-gated `*by/me` endpoints — no stub-account fallback. */
function unauthorized(c: Context<App>) {
	return c.json({ error: 'Unauthorized' }, 401)
}

/**
 * Parse an `accessibility` form field into a `RoomAccessibility` value. The client
 * sends the enum NAME on the subroom route (`accessibility=Private`), not the number
 * the room-level route takes, so both forms are accepted. Returns undefined when the
 * field is missing or names nothing in the enum.
 */
function parseAccessibility(value: unknown): number | undefined {
	if (typeof value !== 'string') return undefined
	const raw = value.trim()
	if (/^-?\d+$/.test(raw)) return Number.parseInt(raw, 10)
	const named = Object.entries(Accessibility).find(
		([name, ordinal]) => typeof ordinal === 'number' && name.toLowerCase() === raw.toLowerCase()
	)
	return named ? (named[1] as number) : undefined
}

/** The notifications hub is a single global DO instance (see the `notify` worker). */
const HUB_INSTANCE = 'global'

/**
 * The room `Supports*` flags the `/restrictions` endpoint can toggle, keyed by the
 * lowercased form field the client posts. Only fields present in the body are changed.
 */
const RESTRICTION_FIELDS: Record<string, string> = {
	supportsscreens: 'SupportsScreens',
	supportswalkvr: 'SupportsWalkVR',
	supportsteleportvr: 'SupportsTeleportVR',
	supportsvrlow: 'SupportsVRLow',
	supportsquest2: 'SupportsQuest2',
	supportsmobile: 'SupportsMobile',
	supportsjuniors: 'SupportsJuniors',
}

/**
 * Push a RoomUpdate notification to a player after their room changes, mirroring
 * the reference server's `HubSendToPlayer(playerId, NotifFrame("RoomUpdate", room))`.
 * Hub failures are logged and swallowed — the room write has already committed,
 * so a hub hiccup must not fail the request.
 */
async function pushRoomUpdate(
	c: Context<App>,
	playerId: number,
	room: Record<string, unknown>
): Promise<void> {
	try {
		await c.env.RECFLARE_NOTIFICATIONS_HUB.getByName(HUB_INSTANCE).notifyPlayer(
			playerId,
			'RoomUpdate',
			room
		)
	} catch (err) {
		logger.error('failed to push RoomUpdate notification', {
			playerId,
			error: err instanceof Error ? err.message : String(err),
		})
	}
}

/**
 * Room-mutation result envelope: `{ Success, Value, ErrorId, Error }`, always
 * HTTP 200 (the client reads `Success`). `ErrorId`/`Error` are null on success.
 */
function roomResult(
	c: Context<App>,
	fields: { Success: boolean; Value?: unknown; ErrorId?: string; Error?: string }
) {
	return c.json({
		Success: fields.Success,
		Value: fields.Value ?? null,
		ErrorId: fields.ErrorId ?? null,
		Error: fields.Error ?? null,
	})
}

/**
 * The room save's `value.subRoomDataSave` — a camelCase projection with a DIFFERENT
 * field set from the PascalCase `CurrentSave` embedded in a room (no persistence/OM/UGC
 * versions, no moderation state, no asset arrays; but `unityAsset`/`unityAssetHash`
 * that `CurrentSave` never shows). Don't unify the two without checking the client.
 *
 * `unityAsset`/`unityAssetHash` are always null: we resolve no baked Unity assets.
 */
function toSaveResponse(save: Record<string, unknown>) {
	const str = (v: unknown) => (typeof v === 'string' ? v : null)
	const num = (v: unknown) => (typeof v === 'number' ? v : null)
	return {
		subRoomDataSaveId: num(save.SubRoomDataSaveId),
		subRoomId: num(save.SubRoomId),
		unityAssetId: str(save.UnityAssetId),
		unityAsset: null,
		unityAssetHash: null,
		dataBlob: str(save.DataBlob) ?? '',
		dataBlobHash: str(save.DataBlobHash),
		savedByAccountId: num(save.SavedByAccountId),
		savedOnPlatform: num(save.SavedOnPlatform) ?? 0,
		savedOnDeviceClass: num(save.SavedOnDeviceClass) ?? 0,
		description: str(save.Description),
		createdAt: str(save.CreatedAt) ?? '',
	}
}

/** Client envelope for room mutations: `{ success, error, value }` (lowercase). */
function roomEnvelope(c: Context<App>, value: unknown, error = '') {
	return c.json({ success: error === '', error, value })
}

/** Rooms created/owned by the authed caller (shared by the createdby routes). */
async function ownedRooms(c: Context<App>) {
	const accountId = await authedAccountId(c)
	if (accountId === null) return unauthorized(c)
	return c.json(await getRoomsByCreator(c.env.DB, accountId))
}

/**
 * The caller's owned rooms, excluding their dorm. The dorm is auto-provisioned,
 * not a room the player made, so it doesn't belong in the "rooms you own" list.
 */
async function ownedRoomsExcludingDorm(c: Context<App>) {
	const accountId = await authedAccountId(c)
	if (accountId === null) return unauthorized(c)
	const rooms = await getRoomsByCreator(c.env.DB, accountId)
	return c.json(rooms.filter((r) => r.IsDorm !== true))
}

const app = new Hono<App>()
	.use(
		'*',
		// middleware
		(c, next) =>
			useWorkersLogger(c.env.NAME, {
				environment: c.env.ENVIRONMENT,
				release: c.env.SENTRY_RELEASE,
			})(c, next)
	)

	.onError(withOnError())
	.notFound(withNotFound())

	.get(
		'/',
		describeRoute({
			tags: ['Service'],
			summary: 'Service liveness',
			description: 'A fixed `{ service, status }` body. No auth — a plain liveness probe.',
			responses: { 200: json(ServiceStatus, 'Always `{ service: "rooms", status: "ok" }`') },
		}),
		(c) => c.json({ service: 'rooms', status: 'ok' })
	)

	// Room lookup by `id` (first match wins) or `name`. 400s when neither is
	// supplied and returns `{}` when nothing matches.
	.get(
		'/rooms',
		describeRoute({
			tags: ['Rooms'],
			summary: 'Look up a room by id or name',
			description: [
				'A single room by `id` or `name`. `id` may be a comma-separated list — the first',
				'valid integer wins. An unknown room is `{}`, not a 404: the client reads an empty',
				'object as “no such room”.',
			].join(' '),
			parameters: [
				stringQuery('id', 'Room id (comma-separated; the first valid one is used)'),
				stringQuery('name', 'Room name (matched case-insensitively). Ignored when `id` is given'),
			],
			responses: {
				200: json(RoomLookup, 'The room, or `{}` when there’s no match'),
				400: json(MissingLookupParam, 'Neither `id` nor `name` was supplied'),
			},
		}),
		async (c) => {
			const idParam = c.req.query('id')
			const nameParam = c.req.query('name')
			if (!idParam && !nameParam) {
				return c.json("Either 'id' or 'name' query parameter is required", 400)
			}
			if (idParam) {
				const id = firstId(idParam)
				const room = id === undefined ? null : await getRoomById(c.env.DB, id)
				return c.json(room ?? {})
			}
			const room = await getRoomByName(c.env.DB, nameParam ?? '')
			return c.json(room ?? {})
		}
	)

	// Room search: `query` is space/`+`-separated terms — `#tag` matches room tags,
	// plain terms match the name. Public, non-dorm rooms only. Paginated via
	// skip/take. Returns `{ Results, TotalResults }`.
	.get(
		'/rooms/search',
		describeRoute({
			tags: ['Discovery'],
			summary: 'Search rooms',
			description: [
				'Full room search. `query` is space- or `+`-separated terms: a `#tag` term matches the',
				'room’s tags, a plain term matches its name. Public, non-dorm rooms only.',
			].join(' '),
			parameters: [
				stringQuery('query', 'Search terms — `#tag` matches tags, plain terms match the name'),
				...pageParams(30),
			],
			responses: { 200: json(PagedRooms, 'The matching rooms') },
		}),
		async (c) => {
			const query = c.req.query('query') ?? ''
			const skip = Number.parseInt(c.req.query('skip') ?? '0', 10) || 0
			const take = Number.parseInt(c.req.query('take') ?? '30', 10) || 30
			return c.json(await searchRooms(c.env.DB, query, skip, take))
		}
	)

	// "Hot" rooms feed — public, non-dorm rooms ordered by engagement, optionally
	// filtered to a single `tag` (e.g. `rro`). Paginated via skip/take (take
	// defaults to 100). Returns `{ Results, TotalResults }` like search.
	.get(
		'/rooms/hot',
		describeRoute({
			tags: ['Discovery'],
			summary: 'The “hot” rooms feed',
			description: [
				'Public, non-dorm rooms ordered by engagement, optionally narrowed to a single `tag`',
				'(the browse screen’s filter chips post one, e.g. `rro`).',
			].join(' '),
			parameters: [stringQuery('tag', 'Restrict to rooms carrying this tag'), ...pageParams(100)],
			responses: { 200: json(PagedRooms, 'The feed page') },
		}),
		async (c) => {
			const tag = c.req.query('tag') ?? ''
			const skip = Number.parseInt(c.req.query('skip') ?? '0', 10) || 0
			const take = Number.parseInt(c.req.query('take') ?? '100', 10) || 100
			return c.json(await getHotRooms(c.env.DB, tag, skip, take))
		}
	)

	// "Base" rooms — template rooms (tagged `base`) the client offers when creating
	// a room. Returned regardless of accessibility. Paginated via skip/take (take
	// defaults to 100). Returns a bare array.
	.get(
		'/rooms/base',
		describeRoute({
			tags: ['Discovery'],
			summary: 'Base (template) rooms',
			description: [
				'The template rooms — those tagged `base` — the client offers when a player creates a',
				'room. Served regardless of accessibility, and as a bare array rather than a page.',
			].join(' '),
			parameters: pageParams(100),
			responses: { 200: json(RoomDto.array(), 'The template rooms') },
		}),
		async (c) => {
			const skip = Number.parseInt(c.req.query('skip') ?? '0', 10) || 0
			const take = Number.parseInt(c.req.query('take') ?? '100', 10) || 100
			return c.json(await getBaseRooms(c.env.DB, skip, take))
		}
	)

	// Recommended rooms feed — public, non-dorm rooms ranked by engagement, returned
	// as a bare array (the client's recommendation room-source expects a plain list).
	// The `splitTestId`/`splitTestValue` A/B params are accepted and ignored.
	// Paginated via skip/take (take defaults to 100).
	.get(
		'/rooms/recommendations',
		describeRoute({
			tags: ['Discovery'],
			summary: 'Recommended rooms',
			description: [
				'Public, non-dorm rooms ranked by engagement. Unlike search and hot this is a BARE',
				'array — the client’s recommendation room-source expects a plain list. The',
				'`splitTestId`/`splitTestValue` A/B params are accepted and ignored.',
			].join(' '),
			parameters: [
				stringQuery('splitTestId', 'A/B test id — accepted and ignored'),
				stringQuery('splitTestValue', 'A/B test bucket — accepted and ignored'),
				...pageParams(100),
			],
			responses: { 200: json(RoomDto.array(), 'The recommended rooms') },
		}),
		async (c) => {
			const skip = Number.parseInt(c.req.query('skip') ?? '0', 10) || 0
			const take = Number.parseInt(c.req.query('take') ?? '100', 10) || 100
			return c.json(await getRecommendedRooms(c.env.DB, skip, take))
		}
	)

	// Featured rooms — a single always-active group whose `Rooms` are a randomly
	// ordered set of public, non-dorm rooms. No real curation yet, so `current`
	// just returns a shuffled list of eligible rooms in the featured-group shape.
	// @todo This is not working. It somehow causes the other room listings to fail
	// completely with NREs. I think it is the featured room load that is somehow
	// corrupting the room cache. I tried sending the normal room shape but that
	// did not seem to work.
	.get(
		'/XXXfeaturedrooms/current',
		describeRoute({
			tags: ['Discovery'],
			summary: 'Featured rooms (parked — the path is deliberately broken)',
			description: [
				'A single always-active group of featured rooms: a random shuffle of eligible public',
				'rooms, since there is no editorial curation yet.',
				'',
				'**Parked.** The path the client calls is `/featuredrooms/current`; this is registered',
				'under an `XXX` prefix so the client never reaches it. Serving it made the OTHER room',
				'listings fail with NREs in the client, apparently by corrupting its room cache —',
				'sending the normal room shape instead did not help. It stays registered so the shape',
				'is documented and the route is one rename away once the cause is found.',
			].join('\n'),
			responses: { 200: json(FeaturedRoomGroupDto, 'The featured-room group') },
		}),
		async (c) => {
			return c.json(await getFeaturedRooms(c.env.DB))
		}
	)

	// Bulk room lookup by `id` or `name` — returns an array of matched rooms (the
	// client calls this bare on the rooms host). Rooms not in D1 are simply absent
	// from the result; the client treats an empty result as NoSuchRoom.
	.get(
		'/rooms/bulk',
		describeRoute({
			tags: ['Rooms'],
			summary: 'Look up several rooms at once',
			description: [
				'Rooms by a comma-separated `id` list, or a single `name`. Ids that aren’t in D1 are',
				'simply absent from the result rather than an error — the client reads an empty result',
				'as NoSuchRoom.',
			].join(' '),
			parameters: [
				stringQuery('id', 'Comma-separated room ids'),
				stringQuery('name', 'A single room name. Ignored when `id` is given'),
			],
			responses: {
				200: json(RoomDto.array(), 'The rooms that matched (missing ids are omitted)'),
				400: json(MissingLookupParam, 'Neither `id` nor `name` was supplied'),
			},
		}),
		async (c) => {
			const idParam = c.req.query('id')
			const nameParam = c.req.query('name')
			if (!idParam && !nameParam) {
				return c.json("Either 'id' or 'name' query parameter is required", 400)
			}
			if (idParam) {
				return c.json(await getRoomsByIds(c.env.DB, allIds(idParam)))
			}
			const room = await getRoomByName(c.env.DB, nameParam ?? '')
			return c.json(room ? [room] : [])
		}
	)

	// Rooms created/owned by the caller. Auth-gated — no token is a 401, never
	// account 1. `ownedby/me` drops the dorm (it's not a room the player made);
	// the `createdby` variants return everything the account created.
	.get(
		'/roomserver/rooms/createdby/me',
		describeRoute({
			tags: ['My rooms'],
			summary: 'Rooms the caller created (legacy path)',
			description: [
				'Every room the caller created, dorm included. Identical to',
				'`GET /rooms/createdby/me` — the 2023 client calls this one under the `/roomserver`',
				'prefix, so both forms are registered.',
			].join(' '),
			security: AUTHED,
			responses: { 200: json(RoomDto.array(), 'The caller’s rooms'), 401: UNAUTHORIZED_RESPONSE },
		}),
		ownedRooms
	)
	.get(
		'/rooms/ownedby/me',
		describeRoute({
			tags: ['My rooms'],
			summary: 'Rooms the caller owns (excluding their dorm)',
			description: [
				'The caller’s own rooms with the dorm filtered out: a dorm is auto-provisioned, not a',
				'room the player made, so it doesn’t belong in the “rooms you own” list. Use',
				'`createdby/me` for everything the account created.',
			].join(' '),
			security: AUTHED,
			responses: {
				200: json(RoomDto.array(), 'The caller’s rooms, dorm excluded'),
				401: UNAUTHORIZED_RESPONSE,
			},
		}),
		ownedRoomsExcludingDorm
	)
	.get(
		'/rooms/createdby/me',
		describeRoute({
			tags: ['My rooms'],
			summary: 'Rooms the caller created',
			description: 'Every room the caller created, dorm included.',
			security: AUTHED,
			responses: { 200: json(RoomDto.array(), 'The caller’s rooms'), 401: UNAUTHORIZED_RESPONSE },
		}),
		ownedRooms
	)

	// Public: the rooms a given account owns that are publicly viewable. No auth —
	// returns a bare array (empty when the account owns no public rooms).
	.get(
		'/rooms/ownedby/:accountId{[0-9]+}',
		describeRoute({
			tags: ['Rooms'],
			summary: 'Another player’s public rooms',
			description: [
				'The rooms an account owns that are publicly viewable — what the client shows on a',
				'player’s profile. No auth; empty when the account owns no public rooms.',
			].join(' '),
			parameters: [
				{
					name: 'accountId',
					in: 'path',
					required: true,
					description: 'The account whose rooms to list',
					schema: { type: 'string', pattern: '^[0-9]+$' },
				},
			],
			responses: { 200: json(RoomDto.array(), 'That account’s public rooms') },
		}),
		async (c) =>
			c.json(await getPublicRoomsByCreator(c.env.DB, Number.parseInt(c.req.param('accountId'), 10)))
	)

	// Rooms the caller has favorited (from the interaction table). Auth-gated.
	// Paginated via skip/take (take defaults to 100). Returns a bare array, like the
	// other room-source `*by/me` lists the client loads.
	.get(
		'/rooms/favoritedby/me',
		describeRoute({
			tags: ['My rooms'],
			summary: 'Rooms the caller favorited',
			description:
				'The rooms the caller has favorited (from the interaction table), as a bare array.',
			security: AUTHED,
			parameters: pageParams(100),
			responses: {
				200: json(RoomDto.array(), 'The favorited rooms'),
				401: UNAUTHORIZED_RESPONSE,
			},
		}),
		async (c) => {
			const accountId = await authedAccountId(c)
			if (accountId === null) return unauthorized(c)
			const skip = Number.parseInt(c.req.query('skip') ?? '0', 10) || 0
			const take = Number.parseInt(c.req.query('take') ?? '100', 10) || 100
			return c.json(await getFavoritedRooms(c.env.DB, accountId, skip, take))
		}
	)

	// Rooms the caller has visited (interaction rows with a last-visited time).
	// Auth-gated. Paginated via skip/take (take defaults to 100). Returns a bare array.
	.get(
		'/rooms/visitedby/me',
		describeRoute({
			tags: ['My rooms'],
			summary: 'Rooms the caller visited',
			description: [
				'The rooms the caller has visited — interaction rows carrying a last-visited time —',
				'as a bare array.',
			].join(' '),
			security: AUTHED,
			parameters: pageParams(100),
			responses: { 200: json(RoomDto.array(), 'The visited rooms'), 401: UNAUTHORIZED_RESPONSE },
		}),
		async (c) => {
			const accountId = await authedAccountId(c)
			if (accountId === null) return unauthorized(c)
			const skip = Number.parseInt(c.req.query('skip') ?? '0', 10) || 0
			const take = Number.parseInt(c.req.query('take') ?? '100', 10) || 100
			return c.json(await getVisitedRooms(c.env.DB, accountId, skip, take))
		}
	)

	// The current player's interaction state with a room (cheered/favorited/last
	// visited), read from the `interaction` table. Auth-gated.
	.get(
		'/rooms/:roomId{[0-9]+}/interactionby/me',
		describeRoute({
			tags: ['Interaction'],
			summary: 'The caller’s state on a room',
			description: [
				'Whether the caller has cheered/favorited the room. An unknown room (or one the caller',
				'has never touched) reads as all-false rather than 404. `LastVisitedAt` is stamped',
				'with “now” on every read, not served from storage.',
			].join(' '),
			security: AUTHED,
			parameters: [roomIdParam],
			responses: { 200: json(InteractionDto, 'The interaction'), 401: UNAUTHORIZED_RESPONSE },
		}),
		async (c) => {
			const accountId = await authedAccountId(c)
			if (accountId === null) return unauthorized(c)
			const interaction = await getInteraction(
				c.env.DB,
				accountId,
				Number.parseInt(c.req.param('roomId'), 10)
			)
			return c.json({ ...interaction, LastVisitedAt: new Date().toISOString() })
		}
	)

	// Toggle the player's cheer/favorite on a room. Both are auth-gated PUTs that
	// flip the stored flag and return the updated interaction.
	.put(
		'/rooms/:roomId{[0-9]+}/interactionby/me/cheer',
		describeRoute({
			tags: ['Interaction'],
			summary: 'Toggle the caller’s cheer on a room',
			description: 'Flips the stored cheer flag and answers the updated interaction.',
			security: AUTHED,
			parameters: [roomIdParam],
			responses: {
				200: json(InteractionDto, 'The interaction after the toggle'),
				401: UNAUTHORIZED_RESPONSE,
			},
		}),
		async (c) => {
			const accountId = await authedAccountId(c)
			if (accountId === null) return unauthorized(c)
			const interaction = await toggleCheer(
				c.env.DB,
				accountId,
				Number.parseInt(c.req.param('roomId'), 10)
			)
			return c.json({ ...interaction, LastVisitedAt: new Date().toISOString() })
		}
	)
	// Explicitly un-cheer a room (DELETE clears the cheer, vs the PUT toggle).
	// Auth-gated; idempotent — un-cheering when there's no cheer is a no-op.
	.delete(
		'/rooms/:roomId{[0-9]+}/interactionby/me/cheer',
		describeRoute({
			tags: ['Interaction'],
			summary: 'Un-cheer a room',
			description: [
				'Clears the cheer outright, where the PUT toggles it. Idempotent — un-cheering a room',
				'that isn’t cheered is a no-op.',
			].join(' '),
			security: AUTHED,
			parameters: [roomIdParam],
			responses: { 200: json(InteractionDto, 'The interaction'), 401: UNAUTHORIZED_RESPONSE },
		}),
		async (c) => {
			const accountId = await authedAccountId(c)
			if (accountId === null) return unauthorized(c)
			const interaction = await removeCheer(
				c.env.DB,
				accountId,
				Number.parseInt(c.req.param('roomId'), 10)
			)
			return c.json({ ...interaction, LastVisitedAt: new Date().toISOString() })
		}
	)
	.put(
		'/rooms/:roomId{[0-9]+}/interactionby/me/favorite',
		describeRoute({
			tags: ['Interaction'],
			summary: 'Toggle the caller’s favorite on a room',
			description: 'Flips the stored favorite flag and answers the updated interaction.',
			security: AUTHED,
			parameters: [roomIdParam],
			responses: {
				200: json(InteractionDto, 'The interaction after the toggle'),
				401: UNAUTHORIZED_RESPONSE,
			},
		}),
		async (c) => {
			const accountId = await authedAccountId(c)
			if (accountId === null) return unauthorized(c)
			const interaction = await toggleFavorite(
				c.env.DB,
				accountId,
				Number.parseInt(c.req.param('roomId'), 10)
			)
			return c.json({ ...interaction, LastVisitedAt: new Date().toISOString() })
		}
	)
	// Explicitly un-favorite a room (DELETE clears the favorite, vs the PUT toggle).
	// Auth-gated; idempotent — un-favoriting when there's no favorite is a no-op.
	.delete(
		'/rooms/:roomId{[0-9]+}/interactionby/me/favorite',
		describeRoute({
			tags: ['Interaction'],
			summary: 'Un-favorite a room',
			description: [
				'Clears the favorite outright, where the PUT toggles it. Idempotent — un-favoriting a',
				'room that isn’t favorited is a no-op.',
			].join(' '),
			security: AUTHED,
			parameters: [roomIdParam],
			responses: { 200: json(InteractionDto, 'The interaction'), 401: UNAUTHORIZED_RESPONSE },
		}),
		async (c) => {
			const accountId = await authedAccountId(c)
			if (accountId === null) return unauthorized(c)
			const interaction = await removeFavorite(
				c.env.DB,
				accountId,
				Number.parseInt(c.req.param('roomId'), 10)
			)
			return c.json({ ...interaction, LastVisitedAt: new Date().toISOString() })
		}
	)

	// Clone a room into a new one owned by the caller, using the `name` form field
	// (also accepted as a query param). Auth is required — no valid token is a 401,
	// with no stub-account fallback. Returns the `{ success, error, value }` envelope
	// the client expects; business failures are 200 with success:false.
	.post(
		'/rooms/:roomId{[0-9]+}/clone',
		describeRoute({
			tags: ['Room settings'],
			summary: 'Clone a room',
			description: [
				'Copies a room’s content (scene, subrooms, settings) into a new room owned by the',
				'caller. Cloning is the only way to make a room, so the per-account room cap is',
				'enforced here — it counts the rooms the account created, minus their auto-provisioned',
				'dorm (`MAX_ROOMS_PER_ACCOUNT`; 0 lifts the cap). The clone starts with no tags and',
				'`IsRRO` cleared.',
				'',
				'Rejections — a blank or taken name, the cap, a source that disallows cloning — are',
				'HTTP 200 with `success: false` and the message the client shows.',
			].join('\n'),
			security: AUTHED,
			parameters: [roomIdParam],
			requestBody: form(CloneRoomRequest, 'The new room’s name (also read from `?name=`)'),
			responses: {
				200: json(RoomEnvelope, 'The new room, or a rejection with `success: false`'),
				401: UNAUTHORIZED_ENVELOPE,
			},
		}),
		async (c) => {
			const accountId = await authedAccountId(c)
			if (accountId === null) {
				return c.json({ success: false, error: 'Unauthorized', value: null }, 401)
			}

			const body = (await c.req.parseBody().catch(() => ({}))) as Record<string, unknown>
			const raw = body.name ?? c.req.query('name') ?? ''
			const name = typeof raw === 'string' ? raw.trim() : ''

			if (name === '') return roomEnvelope(c, null, 'You must enter a name for your room.')
			if (await getRoomByName(c.env.DB, name)) {
				return roomEnvelope(c, null, 'A room with that name already exists!')
			}
			// Cloning is how a player makes a room, so the per-account cap belongs here.
			// Checked after the cheap validations so a rejected name costs no extra D1 read.
			const maxRooms = intVar(c.env.MAX_ROOMS_PER_ACCOUNT, DEFAULT_MAX_ROOMS_PER_ACCOUNT)
			if (maxRooms > 0 && (await countRoomsByCreator(c.env.DB, accountId)) >= maxRooms) {
				logger.info('room create rejected: per-account room limit', { accountId })
				return roomEnvelope(c, null, `You can only have ${maxRooms} rooms.`)
			}
			const room = await cloneRoom(
				c.env.DB,
				Number.parseInt(c.req.param('roomId'), 10),
				name,
				accountId
			)
			if (!room) return roomEnvelope(c, null, "You can't clone this room!")
			return roomEnvelope(c, room)
		}
	)

	// Update a room's description. Auth-gated (401) and owner-only. Business results
	// use the `{ Success, Value, ErrorId, Error }` envelope at HTTP 200.
	.put(
		'/rooms/:roomId{[0-9]+}/description',
		describeRoute({
			tags: ['Room settings'],
			summary: 'Set a room’s description',
			description: [
				'Owner-only (the room’s `CreatorAccountId` — co-owners cannot). An unknown room or a',
				'non-owner is HTTP 200 with `Success: false` and an `ErrorId`; only a missing token is',
				'a real 401. An absent `description` field clears the description.',
			].join(' '),
			security: AUTHED,
			parameters: [roomIdParam],
			requestBody: form(DescriptionRequest, 'The new description'),
			responses: {
				200: json(RoomResultEnvelope, 'Success, or a rejection carrying an `ErrorId`'),
				401: UNAUTHORIZED_RESPONSE,
			},
		}),
		async (c) => {
			const accountId = await authedAccountId(c)
			if (accountId === null) return unauthorized(c)

			const roomId = Number.parseInt(c.req.param('roomId'), 10)
			const room = await getRoomById(c.env.DB, roomId)
			if (!room) {
				return roomResult(c, {
					Success: false,
					ErrorId: 'Rooms.DoesntExist',
					Error: 'This room does not exist!',
				})
			}
			if (room.CreatorAccountId !== accountId) {
				return roomResult(c, {
					Success: false,
					ErrorId: 'Rooms.NotOwner',
					Error: 'You are not the owner of this room!',
				})
			}

			const body = (await c.req.parseBody().catch(() => ({}))) as Record<string, unknown>
			const description = typeof body.description === 'string' ? body.description : ''
			await setRoomDescription(c.env.DB, roomId, description)
			return roomResult(c, { Success: true })
		}
	)

	// Rename a room. Auth-gated (401) and owner-only; the new name must be non-empty
	// and not already taken by another room. Business results use the
	// `{ Success, Value, ErrorId, Error }` envelope at HTTP 200.
	// NOTE: the ErrorId strings (besides Rooms.DoesntExist) are best guesses.
	.put(
		'/rooms/:roomId{[0-9]+}/name',
		describeRoute({
			tags: ['Room settings'],
			summary: 'Rename a room',
			description: [
				'Owner-only. The new name must be non-empty and not already taken by another room',
				'(names are compared case-insensitively). Rejections are HTTP 200 with',
				'`Success: false`.',
				'',
				'NOTE: the `ErrorId` strings other than `Rooms.DoesntExist` are best guesses — the',
				'client only renders `Error`, so they have never been confirmed against the real one.',
			].join('\n'),
			security: AUTHED,
			parameters: [roomIdParam],
			requestBody: form(NameRequest, 'The new name'),
			responses: {
				200: json(RoomResultEnvelope, 'Success, or a rejection carrying an `ErrorId`'),
				401: UNAUTHORIZED_RESPONSE,
			},
		}),
		async (c) => {
			const accountId = await authedAccountId(c)
			if (accountId === null) return unauthorized(c)

			const roomId = Number.parseInt(c.req.param('roomId'), 10)
			const room = await getRoomById(c.env.DB, roomId)
			if (!room) {
				return roomResult(c, {
					Success: false,
					ErrorId: 'Rooms.DoesntExist',
					Error: 'This room does not exist!',
				})
			}
			if (room.CreatorAccountId !== accountId) {
				return roomResult(c, {
					Success: false,
					ErrorId: 'Rooms.NotOwner',
					Error: 'You are not the owner of this room!',
				})
			}

			const body = (await c.req.parseBody().catch(() => ({}))) as Record<string, unknown>
			const name = typeof body.name === 'string' ? body.name.trim() : ''
			if (name === '') {
				return roomResult(c, {
					Success: false,
					ErrorId: 'Rooms.InvalidName',
					Error: 'You must enter a name for your room!',
				})
			}

			// Reject if a different room already uses this name (case-insensitive).
			const existing = await getRoomByName(c.env.DB, name)
			if (existing && existing.RoomId !== roomId) {
				return roomResult(c, {
					Success: false,
					ErrorId: 'Rooms.AlreadyExists',
					Error: 'A room with that name already exists!',
				})
			}

			await setRoomName(c.env.DB, roomId, name)
			return roomResult(c, { Success: true })
		}
	)

	// Toggle a tag on a room. Auth-gated (401) and owner-only. Body is the `tag`
	// form field. There's no delete/patch endpoint, so this call toggles: it adds
	// the tag (Type 0) if absent and removes it if present. The "main" tags
	// (#pvp/#quest/#game/#hangout/#art) are radio buttons — setting one clears the
	// others. Returns the `{ success, error, value }` envelope with the updated
	// room as `value`; business failures are 200 with success:false.
	.put(
		'/rooms/:roomId{[0-9]+}/tags',
		describeRoute({
			tags: ['Room settings'],
			summary: 'Toggle a tag on a room',
			description: [
				'Owner-only. There is no delete/patch counterpart, so this call TOGGLES: it adds the',
				'tag (Type 0) when absent and removes it when present. The “main” tags',
				'(`pvp`/`quest`/`game`/`hangout`/`art`) behave as radio buttons — setting one clears',
				'the others. Answers the lowercase envelope with the updated room, which the client',
				're-renders from.',
			].join(' '),
			security: AUTHED,
			parameters: [roomIdParam],
			requestBody: form(TagRequest, 'The tag to toggle'),
			responses: {
				200: json(RoomEnvelope, 'The updated room, or a rejection with `success: false`'),
				401: UNAUTHORIZED_RESPONSE,
			},
		}),
		async (c) => {
			const accountId = await authedAccountId(c)
			if (accountId === null) return unauthorized(c)

			const roomId = Number.parseInt(c.req.param('roomId'), 10)
			const room = await getRoomById(c.env.DB, roomId)
			if (!room) return roomEnvelope(c, null, 'This room does not exist!')
			if (room.CreatorAccountId !== accountId) {
				return roomEnvelope(c, null, 'You are not the owner of this room!')
			}

			const body = (await c.req.parseBody().catch(() => ({}))) as Record<string, unknown>
			const tag = typeof body.tag === 'string' ? body.tag.trim() : ''
			if (tag === '') return roomEnvelope(c, null, 'You must provide a tag!')

			const updated = await toggleRoomTag(c.env.DB, roomId, room, tag)
			return roomEnvelope(c, updated)
		}
	)

	// Set a room's image. Auth-gated (401) and owner-only. Body is the `imageName`
	// form field (a key from the storage/image upload). Business results use the
	// `{ Success, Value, ErrorId, Error }` envelope at HTTP 200.
	.put(
		'/rooms/:roomId{[0-9]+}/image',
		describeRoute({
			tags: ['Room settings'],
			summary: 'Set a room’s image',
			description: [
				'Owner-only. `imageName` is a key from the storage upload, stored un-prefixed (the',
				'`cdn` worker serves it back under `room/`). Pushes a `RoomUpdate` to the owner so',
				'their client re-renders with the new image.',
			].join(' '),
			security: AUTHED,
			parameters: [roomIdParam],
			requestBody: form(ImageRequest, 'The uploaded image key'),
			responses: {
				200: json(RoomResultEnvelope, 'Success, or a rejection carrying an `ErrorId`'),
				401: UNAUTHORIZED_RESPONSE,
			},
		}),
		async (c) => {
			const accountId = await authedAccountId(c)
			if (accountId === null) return unauthorized(c)

			const roomId = Number.parseInt(c.req.param('roomId'), 10)
			const room = await getRoomById(c.env.DB, roomId)
			if (!room) {
				return roomResult(c, {
					Success: false,
					ErrorId: 'Rooms.DoesntExist',
					Error: 'This room does not exist!',
				})
			}
			if (room.CreatorAccountId !== accountId) {
				return roomResult(c, {
					Success: false,
					ErrorId: 'Rooms.NotOwner',
					Error: 'You are not the owner of this room!',
				})
			}

			const body = (await c.req.parseBody().catch(() => ({}))) as Record<string, unknown>
			const imageName = typeof body.imageName === 'string' ? body.imageName.trim() : ''
			if (imageName === '') {
				return roomResult(c, {
					Success: false,
					ErrorId: 'Rooms.InvalidImage',
					Error: 'You must provide an image!',
				})
			}
			await setRoomImage(c.env.DB, roomId, imageName)
			// Notify the owner so their client refreshes the room (RoomUpdate carries the
			// updated room). The reference sends the post-update room, so merge the change.
			await pushRoomUpdate(c, accountId, { ...room, ImageName: imageName })
			return roomResult(c, { Success: true })
		}
	)

	// Delete a room. Auth-gated (401) and owner-only (the room's CreatorAccountId).
	// Removes the room record (and per-player interactions with it) and the room's
	// image object from the shared CDN bucket. Images players *took* in the room are
	// left alone — they live in the api/img world and outlast the room.
	.delete(
		'/rooms/:roomId{[0-9]+}',
		describeRoute({
			tags: ['Room settings'],
			summary: 'Delete a room',
			description: [
				'Owner-only. Removes the room record, the per-player interactions with it, and the',
				'room’s image object from the shared CDN bucket. Photos players TOOK in the room are',
				'left alone — those live in the api/img world and outlive the room.',
			].join(' '),
			security: AUTHED,
			parameters: [roomIdParam],
			responses: {
				200: json(RoomResultEnvelope, 'Success, or a rejection carrying an `ErrorId`'),
				401: UNAUTHORIZED_RESPONSE,
			},
		}),
		async (c) => {
			const accountId = await authedAccountId(c)
			if (accountId === null) return unauthorized(c)

			const roomId = Number.parseInt(c.req.param('roomId'), 10)
			const room = await getRoomById(c.env.DB, roomId)
			if (!room) {
				return roomResult(c, {
					Success: false,
					ErrorId: 'Rooms.DoesntExist',
					Error: 'This room does not exist!',
				})
			}
			if (room.CreatorAccountId !== accountId) {
				return roomResult(c, {
					Success: false,
					ErrorId: 'Rooms.NotOwner',
					Error: 'You are not the owner of this room!',
				})
			}

			await deleteRoom(c.env.DB, roomId)

			// Remove the room image from the CDN bucket. The stored ImageName is the
			// un-prefixed key the `cdn` worker serves back under `room/` (see storage
			// upload + the `GET /room/:dataBlob` route), so the object key is `room/<name>`.
			// R2 deletes are idempotent, so a canonical/static or already-gone image is fine.
			const imageName = typeof room.ImageName === 'string' ? room.ImageName : ''
			if (imageName !== '') {
				await c.env.CDN_ASSETS.delete(`room/${imageName}`)
			}

			return roomResult(c, { Success: true })
		}
	)

	// Set a member's role in a room (`Roles[].Role`). Auth-gated (401) and gated to
	// the room creator or a co-owner (403 otherwise) — the same owner/co-owner check
	// the other room-admin actions use. Body is the `role` form field (an integer role
	// tier). Updates the target account's existing role entry or adds one, notifies the
	// affected member so their client refreshes permissions, and returns the updated
	// room in the lowercase `{ success, error, value }` envelope.
	.put(
		'/rooms/:roomId{[0-9]+}/roles/:accountId{[0-9]+}',
		describeRoute({
			tags: ['Room settings'],
			summary: 'Set a member’s role in a room',
			description: [
				'Updates the target account’s entry in the room’s `Roles` (or adds one). Gated to the',
				'room’s creator or a co-owner — a valid token from anyone else is a 403. The affected',
				'MEMBER gets the `RoomUpdate` push, not the caller, so their client refreshes the',
				'permissions it just gained or lost.',
			].join(' '),
			security: AUTHED,
			parameters: [
				roomIdParam,
				{
					name: 'accountId',
					in: 'path',
					required: true,
					description: 'The member whose role changes',
					schema: { type: 'string', pattern: '^[0-9]+$' },
				},
			],
			requestBody: form(RoleRequest, 'The role tier to grant'),
			responses: {
				200: json(RoomEnvelope, 'The updated room, or a rejection with `success: false`'),
				401: UNAUTHORIZED_RESPONSE,
				403: FORBIDDEN_RESPONSE,
			},
		}),
		async (c) => {
			const accountId = await authedAccountId(c)
			if (accountId === null) return unauthorized(c)

			const roomId = Number.parseInt(c.req.param('roomId'), 10)
			const targetAccountId = Number.parseInt(c.req.param('accountId'), 10)
			const room = await getRoomById(c.env.DB, roomId)
			if (!room) return roomEnvelope(c, null, 'This room does not exist!')
			// A valid token but not the room's owner/co-owner → 403 (the auth gate above
			// already returned 401 for a missing/invalid token).
			if (!canManageRoom(room, accountId)) return c.body(null, 403)

			const body = (await c.req.parseBody().catch(() => ({}))) as Record<string, unknown>
			const role = typeof body.role === 'string' ? Number.parseInt(body.role, 10) : Number.NaN
			if (Number.isNaN(role)) return roomEnvelope(c, null, 'You must provide a valid role!')

			const updated = await setRoomRole(c.env.DB, roomId, targetAccountId, role, accountId, room)
			// Notify the member whose role changed so their client refreshes the room
			// (and the permissions it grants them).
			await pushRoomUpdate(c, targetAccountId, updated)
			return roomEnvelope(c, updated)
		}
	)

	// Set a room's content warning: the `WarningMask` bit flags plus an optional
	// free-text `CustomWarning`. Auth-gated (401) and owner/co-owner-only (403). Body is
	// the `warningMask` form field (an integer) and an optional `customWarning` string
	// (set when present — an empty value clears it). Returns the updated room in the
	// `{ success, error, value }` envelope.
	.put(
		'/rooms/:roomId{[0-9]+}/warning',
		describeRoute({
			tags: ['Room settings'],
			summary: 'Set a room’s content warning',
			description: [
				'The `WarningMask` bit flags plus an optional free-text `CustomWarning`. Owner or',
				'co-owner only (403 otherwise). `CustomWarning` is only touched when the field is',
				'present — sending it empty clears it, omitting it leaves it alone.',
			].join(' '),
			security: AUTHED,
			parameters: [roomIdParam],
			requestBody: form(WarningRequest, 'The warning flags and optional custom text'),
			responses: {
				200: json(RoomEnvelope, 'The updated room, or a rejection with `success: false`'),
				401: UNAUTHORIZED_RESPONSE,
				403: FORBIDDEN_RESPONSE,
			},
		}),
		async (c) => {
			const accountId = await authedAccountId(c)
			if (accountId === null) return unauthorized(c)

			const roomId = Number.parseInt(c.req.param('roomId'), 10)
			const room = await getRoomById(c.env.DB, roomId)
			if (!room) return roomEnvelope(c, null, 'This room does not exist!')
			// A valid token but not the room's owner/co-owner → 403 (the auth gate above
			// already returned 401 for a missing/invalid token).
			if (!canManageRoom(room, accountId)) return c.body(null, 403)

			const body = (await c.req.parseBody().catch(() => ({}))) as Record<string, unknown>
			const warningMask =
				typeof body.warningMask === 'string' ? Number.parseInt(body.warningMask, 10) : Number.NaN
			if (Number.isNaN(warningMask))
				return roomEnvelope(c, null, 'You must provide a valid warning mask!')

			const patch: Record<string, unknown> = { WarningMask: warningMask }
			// Only touch CustomWarning when the field is present (an empty string clears it).
			if (typeof body.customWarning === 'string') patch.CustomWarning = body.customWarning

			const updated = await updateRoomFields(c.env.DB, roomId, room, patch)
			// Notify the owner so their client refreshes the room with the updated warning.
			await pushRoomUpdate(c, accountId, updated)
			return roomEnvelope(c, updated)
		}
	)

	// Toggle whether a room may be cloned (`CloningAllowed`). Auth-gated (401) and
	// owner/co-owner-only (403). Body is the `cloningAllowed` form field (`True`/`False`).
	// Returns the updated room in the `{ success, error, value }` envelope.
	.put(
		'/rooms/:roomId{[0-9]+}/cloning',
		describeRoute({
			tags: ['Room settings'],
			summary: 'Allow or block cloning of a room',
			description: [
				'Sets `CloningAllowed` — false makes `POST /rooms/{roomId}/clone` refuse. Owner or',
				'co-owner only (403 otherwise).',
			].join(' '),
			security: AUTHED,
			parameters: [roomIdParam],
			requestBody: form(CloningRequest, 'Whether cloning is allowed'),
			responses: {
				200: json(RoomEnvelope, 'The updated room, or a rejection with `success: false`'),
				401: UNAUTHORIZED_RESPONSE,
				403: FORBIDDEN_RESPONSE,
			},
		}),
		async (c) => {
			const accountId = await authedAccountId(c)
			if (accountId === null) return unauthorized(c)

			const roomId = Number.parseInt(c.req.param('roomId'), 10)
			const room = await getRoomById(c.env.DB, roomId)
			if (!room) return roomEnvelope(c, null, 'This room does not exist!')
			// A valid token but not the room's owner/co-owner → 403 (the auth gate above
			// already returned 401 for a missing/invalid token).
			if (!canManageRoom(room, accountId)) return c.body(null, 403)

			const body = (await c.req.parseBody().catch(() => ({}))) as Record<string, unknown>
			if (typeof body.cloningAllowed !== 'string') {
				return roomEnvelope(c, null, 'You must provide cloningAllowed.')
			}
			const cloningAllowed = body.cloningAllowed.toLowerCase() === 'true'

			const updated = await updateRoomFields(c.env.DB, roomId, room, {
				CloningAllowed: cloningAllowed,
			})
			await pushRoomUpdate(c, accountId, updated)
			return roomEnvelope(c, updated)
		}
	)

	// Set a room's platform/movement support flags (its `Supports*` restrictions).
	// Auth-gated (401) and owner/co-owner-only (403). Body is a form of
	// `supports*=True|False` fields (see RESTRICTION_FIELDS); only the fields present
	// are changed. Returns the updated room in the `{ success, error, value }` envelope.
	.put(
		'/rooms/:roomId{[0-9]+}/restrictions',
		describeRoute({
			tags: ['Room settings'],
			summary: 'Set a room’s platform/movement support flags',
			description: [
				'The room’s `Supports*` restrictions — which platforms and movement modes may enter.',
				'Owner or co-owner only (403 otherwise). Only the fields actually posted are changed,',
				'and field names are matched case-insensitively.',
			].join(' '),
			security: AUTHED,
			parameters: [roomIdParam],
			requestBody: form(RestrictionsRequest, 'The flags to change'),
			responses: {
				200: json(RoomEnvelope, 'The updated room, or a rejection with `success: false`'),
				401: UNAUTHORIZED_RESPONSE,
				403: FORBIDDEN_RESPONSE,
			},
		}),
		async (c) => {
			const accountId = await authedAccountId(c)
			if (accountId === null) return unauthorized(c)

			const roomId = Number.parseInt(c.req.param('roomId'), 10)
			const room = await getRoomById(c.env.DB, roomId)
			if (!room) return roomEnvelope(c, null, 'This room does not exist!')
			// A valid token but not the room's owner/co-owner → 403 (the auth gate above
			// already returned 401 for a missing/invalid token).
			if (!canManageRoom(room, accountId)) return c.body(null, 403)

			const body = (await c.req.parseBody().catch(() => ({}))) as Record<string, unknown>
			const patch: Record<string, boolean> = {}
			for (const [key, value] of Object.entries(body)) {
				const field = RESTRICTION_FIELDS[key.toLowerCase()]
				if (field !== undefined && typeof value === 'string') {
					patch[field] = value.toLowerCase() === 'true'
				}
			}

			const updated = await updateRoomFields(c.env.DB, roomId, room, patch)
			await pushRoomUpdate(c, accountId, updated)
			return roomEnvelope(c, updated)
		}
	)

	// Add a load screen to a room (`LoadScreens[]` — the images shown while the room
	// loads). Auth-gated (401) and owner/co-owner-only (403). Body is the `imageName`
	// form field plus optional `title`/`subtitle`. Appends one
	// `{ ImageName, Title, Subtitle }` to the existing list and returns the updated
	// room in the `{ success, error, value }` envelope.
	.put(
		'/rooms/:roomId{[0-9]+}/loadscreen',
		describeRoute({
			tags: ['Room settings'],
			summary: 'Add a load screen to a room',
			description: [
				'APPENDS one `{ ImageName, Title, Subtitle }` to the room’s `LoadScreens` — the images',
				'shown while the room loads. There is no remove or replace counterpart. Owner or',
				'co-owner only (403 otherwise).',
			].join(' '),
			security: AUTHED,
			parameters: [roomIdParam],
			requestBody: form(LoadScreenRequest, 'The load screen to append'),
			responses: {
				200: json(RoomEnvelope, 'The updated room, or a rejection with `success: false`'),
				401: UNAUTHORIZED_RESPONSE,
				403: FORBIDDEN_RESPONSE,
			},
		}),
		async (c) => {
			const accountId = await authedAccountId(c)
			if (accountId === null) return unauthorized(c)

			const roomId = Number.parseInt(c.req.param('roomId'), 10)
			const room = await getRoomById(c.env.DB, roomId)
			if (!room) return roomEnvelope(c, null, 'This room does not exist!')
			// A valid token but not the room's owner/co-owner → 403 (the auth gate above
			// already returned 401 for a missing/invalid token).
			if (!canManageRoom(room, accountId)) return c.body(null, 403)

			const body = (await c.req.parseBody().catch(() => ({}))) as Record<string, unknown>
			const imageName = typeof body.imageName === 'string' ? body.imageName.trim() : ''
			if (imageName === '') return roomEnvelope(c, null, 'You must provide an image!')
			const title = typeof body.title === 'string' ? body.title : ''
			const subtitle = typeof body.subtitle === 'string' ? body.subtitle : ''

			const existing = Array.isArray(room.LoadScreens) ? (room.LoadScreens as unknown[]) : []
			const loadScreens = [...existing, { ImageName: imageName, Title: title, Subtitle: subtitle }]
			const updated = await updateRoomFields(c.env.DB, roomId, room, { LoadScreens: loadScreens })
			await pushRoomUpdate(c, accountId, updated)
			return roomEnvelope(c, updated)
		}
	)

	// Set a room's top-level `Accessibility` (the visibility the public-room/search
	// filters key on — see the RoomAccessibility enum). Auth-gated (401) and
	// owner/co-owner-only (403). Body is the `accessibility` form field (an integer).
	// Returns the updated room in the `{ success, error, value }` envelope.
	.put(
		'/rooms/:roomId{[0-9]+}/accessibility',
		describeRoute({
			tags: ['Room settings'],
			summary: 'Set a room’s accessibility',
			description: [
				'The room’s top-level visibility — the field the public-room and search filters key',
				'on (0 Private, 1 Public, 2 Unlisted). Owner or co-owner only (403 otherwise).',
				'Subrooms carry their own `Accessibility`, set through the subroom `modify` call.',
			].join(' '),
			security: AUTHED,
			parameters: [roomIdParam],
			requestBody: form(AccessibilityRequest, 'The new accessibility'),
			responses: {
				200: json(RoomEnvelope, 'The updated room, or a rejection with `success: false`'),
				401: UNAUTHORIZED_RESPONSE,
				403: FORBIDDEN_RESPONSE,
			},
		}),
		async (c) => {
			const accountId = await authedAccountId(c)
			if (accountId === null) return unauthorized(c)

			const roomId = Number.parseInt(c.req.param('roomId'), 10)
			const room = await getRoomById(c.env.DB, roomId)
			if (!room) return roomEnvelope(c, null, 'This room does not exist!')
			// A valid token but not the room's owner/co-owner → 403 (the auth gate above
			// already returned 401 for a missing/invalid token).
			if (!canManageRoom(room, accountId)) return c.body(null, 403)

			const body = (await c.req.parseBody().catch(() => ({}))) as Record<string, unknown>
			const accessibility =
				typeof body.accessibility === 'string'
					? Number.parseInt(body.accessibility, 10)
					: Number.NaN
			if (Number.isNaN(accessibility)) {
				return roomEnvelope(c, null, 'You must provide a valid accessibility!')
			}

			const updated = await updateRoomFields(c.env.DB, roomId, room, {
				Accessibility: accessibility,
			})
			await pushRoomUpdate(c, accountId, updated)
			return roomEnvelope(c, updated)
		}
	)

	// A subroom's saved-data versions — the room-history / "restore a save" list. Every
	// save is its own `subroom_save` row (nothing is overwritten), so this is real
	// history, newest first, paged by skip/take. Auth-gated (401) and creator-only (403):
	// the list exposes unpublished saves, which only the owner is entitled to see.
	.get(
		'/rooms/:roomId{[0-9]+}/subrooms/:subRoomId{[0-9]+}/saves',
		describeRoute({
			tags: ['Subrooms'],
			summary: 'A subroom’s saved-data versions',
			description: [
				'The room-history / “restore a save” list, newest first. Every room save appends a',
				'row rather than overwriting, so this is the subroom’s full history; it is empty',
				'only when the subroom has never been saved.',
				'`unityAssetTarget`/`unityAssetVersion` are accepted and ignored.',
				'',
				'Owner-only (403 otherwise) — the list includes STAGED saves that were never',
				'published, so it is not public. It is what the client reads to offer the owner',
				'“load the latest or the published version?” when they enter a private instance.',
				'',
				'`TotalResults` and `TotalCount` carry the same number: the client’s paged DTO and',
				'the reference disagree on the name, so both are emitted.',
			].join(' '),
			security: AUTHED,
			parameters: [
				roomIdParam,
				subRoomIdParam,
				stringQuery('unityAssetTarget', 'Accepted and ignored'),
				stringQuery('unityAssetVersion', 'Accepted and ignored'),
				stringQuery('skip', 'How many saves to skip (default 0)'),
				stringQuery('take', 'How many saves to return (default all)'),
			],
			responses: {
				200: json(SubRoomSavesPage, 'The subroom’s saves, newest first'),
				401: UNAUTHORIZED_RESPONSE,
				403: FORBIDDEN_RESPONSE,
			},
		}),
		async (c) => {
			const accountId = await authedAccountId(c)
			if (accountId === null) return unauthorized(c)

			const roomId = Number.parseInt(c.req.param('roomId'), 10)
			const subRoomId = Number.parseInt(c.req.param('subRoomId'), 10)
			// Scoped through the room so a subroom id from another room can't read its saves.
			const room = await getRoomById(c.env.DB, roomId)
			if (!room || !findSubRoom(room, subRoomId)) {
				return c.json({ Results: [], TotalResults: 0, TotalCount: 0 })
			}
			if (room.CreatorAccountId !== accountId) return c.body(null, 403)
			const saves = await getSubRoomSaves(c.env.DB, subRoomId)

			const skip = Number.parseInt(c.req.query('skip') ?? '', 10)
			const take = Number.parseInt(c.req.query('take') ?? '', 10)
			const from = Number.isNaN(skip) || skip < 0 ? 0 : skip
			const page = saves.slice(from, Number.isNaN(take) || take < 0 ? undefined : from + take)

			return c.json({ Results: page, TotalResults: saves.length, TotalCount: saves.length })
		}
	)

	// Save a subroom's data (room save). Auth-gated (401 with empty body). Editable
	// by the room creator or a Creator/CoOwner role holder. Points the subroom at
	// the uploaded data blobs and records the room-level save fields, notifies the
	// owner, and returns the updated ROOM in the lowercase `{ success, error, value }`
	// envelope the reference's SetRoomData uses.
	.post(
		'/rooms/:roomId{[0-9]+}/subrooms/:subRoomId{[0-9]+}/data',
		describeRoute({
			tags: ['Subrooms'],
			summary: 'Save a subroom’s data (room save)',
			description: [
				'Records a save against the subroom from the blobs the client has already uploaded',
				'through the `storage` worker; the room-level fields it carries (`Description`,',
				'`PersistenceVersion`, `InventionUsage`) are written to the room. Editable by the',
				'room’s creator or a co-owner (403 otherwise); a missing token is an EMPTY-body 401,',
				'unlike the other room writes.',
				'',
				'`AutoPublish: true` makes the save live immediately. Otherwise it is STAGED: it',
				'lands on `StagedSubRoomDataSaveId` with the live `CurrentSave` untouched, so',
				'players keep loading the last published version until the owner calls',
				'`POST …/subrooms/{subRoomId}/publish_save`. DORMS always publish — they have no',
				'publish step in the client, so staging one would hide the player’s own edits.',
				'',
				'`value` carries BOTH the updated `room` and the `subRoomDataSave` just created,',
				'and `error` is NULL here rather than the empty string the other room envelopes',
				'use. The save is projected in camelCase with a different field set from the',
				'PascalCase `CurrentSave` embedded in the room — the two are not the same shape.',
				'A subroom with no `CreatorAccountId` yet (the seeded rooms start null) gets the',
				'saver’s id here, because the client NREs on a null one.',
			].join('\n'),
			security: AUTHED,
			parameters: [roomIdParam, subRoomIdParam],
			requestBody: jsonBody(SaveSubRoomDataRequest, 'The uploaded blob keys and save fields'),
			responses: {
				200: json(RoomSaveEnvelope, 'The updated room + the new save, or a rejection'),
				401: UNAUTHORIZED_EMPTY,
				403: FORBIDDEN_RESPONSE,
			},
		}),
		async (c) => {
			const accountId = await authedAccountId(c)
			if (accountId === null) return c.body(null, 401)

			const roomId = Number.parseInt(c.req.param('roomId'), 10)
			const subRoomId = Number.parseInt(c.req.param('subRoomId'), 10)

			const room = await getRoomById(c.env.DB, roomId)
			if (!room) {
				return c.json({ success: false, error: 'This room does not exist!', value: null })
			}
			// A valid token but not the room's owner/co-owner → 403 (the auth gate above
			// already returned 401 for a missing/invalid token).
			if (!canManageRoom(room, accountId)) return c.body(null, 403)

			// The client uploads BOTH blobs to `storage` first and sends their keys here:
			// `SubRoomData` is the scene blob (what the loader downloads), `RoomData` the
			// metadata blob. `OwnershipProof` is accepted and ignored.
			const body = (await c.req.json().catch(() => ({}))) as {
				RoomData?: { Filename?: string }
				SubRoomData?: { Filename?: string; Hash?: string | null }
				UnityAssetId?: string | null
				Description?: string
				PersistenceVersion?: number
				InventionUsage?: string
				AutoPublish?: boolean
			}

			const result = await saveSubRoomData(c.env.DB, roomId, subRoomId, accountId, {
				subRoomDataFilename: body.SubRoomData?.Filename,
				subRoomDataHash:
					typeof body.SubRoomData?.Hash === 'string' ? body.SubRoomData.Hash : undefined,
				roomDataFilename: body.RoomData?.Filename,
				unityAssetId: typeof body.UnityAssetId === 'string' ? body.UnityAssetId : undefined,
				autoPublish: body.AutoPublish === true,
				description: typeof body.Description === 'string' ? body.Description : undefined,
				persistenceVersion:
					typeof body.PersistenceVersion === 'number' ? body.PersistenceVersion : undefined,
				inventionUsage: typeof body.InventionUsage === 'string' ? body.InventionUsage : undefined,
			})
			if (!result) {
				return c.json({ success: false, error: 'This subroom does not exist!', value: null })
			}

			// `value` carries BOTH the updated room and the save just created — and `error`
			// is null here, not the empty string the other room envelopes use.
			await pushRoomUpdate(c, accountId, result.room)
			return c.json({
				success: true,
				error: null,
				value: { room: result.room, subRoomDataSave: toSaveResponse(result.save) },
			})
		}
	)

	// Modify a subroom's settings (Name/Accessibility/MaxPlayers) from the form body.
	// Auth-gated (401) and owner-only — only the room creator may change its subrooms.
	// Notifies the owner (RoomUpdate) and returns the `{ Success, Value, ErrorId, Error }`
	// envelope at HTTP 200, matching the other owner-gated room mutations.
	.put(
		'/rooms/:roomId{[0-9]+}/subrooms/:subRoomId{[0-9]+}/modify',
		describeRoute({
			tags: ['Subrooms'],
			summary: 'Modify a subroom’s settings',
			description: [
				'Sets a subroom’s `Name`, `Accessibility` and `MaxPlayers`. Owner-only — only the',
				'room’s creator may change its subrooms, not co-owners. `name` is required;',
				'`accessibility` and `maxPlayers` are applied only when supplied, and a non-positive',
				'`maxPlayers` is ignored rather than rejected.',
			].join(' '),
			security: AUTHED,
			parameters: [roomIdParam, subRoomIdParam],
			requestBody: form(ModifySubRoomRequest, 'The settings to change'),
			responses: {
				200: json(RoomResultEnvelope, 'Success, or a rejection carrying an `ErrorId`'),
				401: UNAUTHORIZED_RESPONSE,
			},
		}),
		async (c) => {
			const accountId = await authedAccountId(c)
			if (accountId === null) return unauthorized(c)

			const roomId = Number.parseInt(c.req.param('roomId'), 10)
			const subRoomId = Number.parseInt(c.req.param('subRoomId'), 10)

			const room = await getRoomById(c.env.DB, roomId)
			if (!room) {
				return roomResult(c, {
					Success: false,
					ErrorId: 'Rooms.DoesntExist',
					Error: 'This room does not exist!',
				})
			}
			if (room.CreatorAccountId !== accountId) {
				return roomResult(c, {
					Success: false,
					ErrorId: 'Rooms.NotOwner',
					Error: 'You are not the owner of this room!',
				})
			}
			if (!findSubRoom(room, subRoomId)) {
				return roomResult(c, {
					Success: false,
					ErrorId: 'Rooms.DoesntExist',
					Error: 'This subroom does not exist!',
				})
			}

			const body = (await c.req.parseBody().catch(() => ({}))) as Record<string, unknown>
			const name = typeof body.name === 'string' ? body.name.trim() : ''
			if (name === '') {
				return roomResult(c, {
					Success: false,
					ErrorId: 'Rooms.InvalidName',
					Error: 'You must enter a name for your room!',
				})
			}
			const maxPlayers =
				typeof body.maxPlayers === 'string' ? Number.parseInt(body.maxPlayers, 10) : Number.NaN

			const updated = await modifySubRoom(c.env.DB, roomId, subRoomId, {
				name,
				// Accepts the enum name as well as the ordinal — the dedicated
				// `/accessibility` route below is sent names, so this may be too.
				accessibility: parseAccessibility(body.accessibility),
				maxPlayers: Number.isNaN(maxPlayers) || maxPlayers <= 0 ? undefined : maxPlayers,
			})
			if (!updated) {
				return roomResult(c, {
					Success: false,
					ErrorId: 'Rooms.DoesntExist',
					Error: 'This subroom does not exist!',
				})
			}

			await pushRoomUpdate(c, accountId, updated)
			return roomResult(c, { Success: true })
		}
	)

	// Publish a subroom's staged save — promote it to the live one players load. Every
	// non-dorm room save only STAGES (see the save route), so this is the manual step that
	// makes edits visible. Auth-gated (401) and creator-only: co-owners may save, but
	// only the room's owner decides what goes live. Answers the updated ROOM in the
	// `{ success, error, value }` envelope, like the other subroom mutations.
	.post(
		'/rooms/:roomId{[0-9]+}/subrooms/:subRoomId{[0-9]+}/publish_save',
		describeRoute({
			tags: ['Subrooms'],
			summary: 'Publish one of a subroom’s saves',
			description: [
				'Makes the save named by the `subRoomDataSaveId` form field the one players load —',
				'it becomes the subroom’s `CurrentSave`. A room save only STAGES (dorms excepted),',
				'so nothing a creator saves reaches players until this is called.',
				'',
				'The id may be any save in the subroom’s history, so this doubles as restore-a-save.',
				'`StagedSubRoomDataSaveId` is cleared only when the published save IS the staged',
				'one — restoring an older version keeps newer unpublished work staged.',
				'',
				'Owner-only: co-owners may save but not decide what goes live. A save id belonging',
				'to another subroom is rejected.',
			].join(' '),
			security: AUTHED,
			parameters: [roomIdParam, subRoomIdParam],
			requestBody: form(PublishSaveRequest, 'The save to publish'),
			responses: {
				200: json(RoomEnvelope, 'The updated room, or a rejection with `success: false`'),
				401: UNAUTHORIZED_ENVELOPE,
			},
		}),
		async (c) => {
			const accountId = await authedAccountId(c)
			if (accountId === null) {
				return c.json({ success: false, error: 'Unauthorized', value: null }, 401)
			}

			const roomId = Number.parseInt(c.req.param('roomId'), 10)
			const subRoomId = Number.parseInt(c.req.param('subRoomId'), 10)

			const room = await getRoomById(c.env.DB, roomId)
			if (!room) return roomEnvelope(c, null, 'This room does not exist!')
			if (room.CreatorAccountId !== accountId) {
				return roomEnvelope(c, null, 'You are not the owner of this room!')
			}

			const body = (await c.req.parseBody().catch(() => ({}))) as Record<string, unknown>
			const saveId =
				typeof body.subRoomDataSaveId === 'string'
					? Number.parseInt(body.subRoomDataSaveId, 10)
					: Number.NaN
			if (Number.isNaN(saveId)) {
				return roomEnvelope(c, null, 'You must provide a valid save!')
			}

			const result = await publishSubRoomSave(c.env.DB, roomId, subRoomId, saveId)
			if (!result.ok) {
				return roomEnvelope(
					c,
					null,
					result.reason === 'unknown_save'
						? 'That save does not exist!'
						: 'This subroom does not exist!'
				)
			}

			await pushRoomUpdate(c, accountId, result.room)
			return roomEnvelope(c, result.room)
		}
	)

	// Set a single subroom's `Accessibility`. Same effect as the `accessibility` field of
	// the subroom `modify` call, but this is what the client actually calls when the
	// player flips one subroom's visibility, and the body carries the enum NAME
	// (`accessibility=Private`), not the number the room-level `/accessibility` takes.
	// Auth-gated (401) and owner-only, like the other subroom mutations. Answers the
	// updated ROOM in the `{ success, error, value }` envelope — the client re-renders
	// the room's subroom list from `value`, the same as subroom create/delete.
	.put(
		'/rooms/:roomId{[0-9]+}/subrooms/:subRoomId{[0-9]+}/accessibility',
		describeRoute({
			tags: ['Subrooms'],
			summary: 'Set a subroom’s accessibility',
			description: [
				'A subroom’s own visibility, independent of the room’s top-level `Accessibility`.',
				'The client sends the `RoomAccessibility` NAME here (`accessibility=Private`) rather',
				'than the ordinal the room-level route takes, so both forms are accepted; an',
				'unrecognised value is rejected. Owner-only — only the room’s creator may change',
				'its subrooms, not co-owners.',
				'',
				'Answers the updated ROOM, not the bare subroom, so the client can re-render the',
				'room’s subroom list from `value`.',
			].join(' '),
			security: AUTHED,
			parameters: [roomIdParam, subRoomIdParam],
			requestBody: form(SubRoomAccessibilityRequest, 'The new accessibility'),
			responses: {
				200: json(RoomEnvelope, 'The updated room, or a rejection with `success: false`'),
				401: UNAUTHORIZED_ENVELOPE,
			},
		}),
		async (c) => {
			const accountId = await authedAccountId(c)
			if (accountId === null) {
				return c.json({ success: false, error: 'Unauthorized', value: null }, 401)
			}

			const roomId = Number.parseInt(c.req.param('roomId'), 10)
			const subRoomId = Number.parseInt(c.req.param('subRoomId'), 10)

			const room = await getRoomById(c.env.DB, roomId)
			if (!room) return roomEnvelope(c, null, 'This room does not exist!')
			if (room.CreatorAccountId !== accountId) {
				return roomEnvelope(c, null, 'You are not the owner of this room!')
			}
			if (!findSubRoom(room, subRoomId)) {
				return roomEnvelope(c, null, 'This subroom does not exist!')
			}

			const body = (await c.req.parseBody().catch(() => ({}))) as Record<string, unknown>
			const accessibility = parseAccessibility(body.accessibility)
			if (accessibility === undefined) {
				return roomEnvelope(c, null, 'You must provide a valid accessibility!')
			}

			const updated = await modifySubRoom(c.env.DB, roomId, subRoomId, { accessibility })
			if (!updated) return roomEnvelope(c, null, 'This subroom does not exist!')

			await pushRoomUpdate(c, accountId, updated)
			return roomEnvelope(c, updated)
		}
	)

	// Clone a subroom into a new subroom of the same room (fresh SubRoomId, same
	// scene/settings/data). Auth-gated (401) and owner-only. Notifies the owner and
	// returns the updated ROOM in the `{ success, error, value }` envelope — NOT the new
	// subroom, even though the new subroom is what the call produces. The client
	// re-renders the room's subroom list from `value`, the same as subroom
	// create/delete/accessibility.
	.post(
		'/rooms/:roomId{[0-9]+}/subrooms/:subRoomId{[0-9]+}/clone',
		describeRoute({
			tags: ['Subrooms'],
			summary: 'Clone a subroom',
			description: [
				'Copies a subroom into a new subroom of the SAME room — same scene, settings and saved',
				'data blobs, so it loads identical content — with a fresh globally-unique `SubRoomId`.',
				'Owner-only.',
				'',
				'Answers the updated ROOM, not the new subroom — the client re-renders the room’s',
				'subroom list from `value`. Unlike the room-level `/clone`, whose `value` IS the new',
				'room, the thing this call creates is not what comes back.',
			].join('\n'),
			security: AUTHED,
			parameters: [roomIdParam, subRoomIdParam],
			responses: {
				200: json(RoomEnvelope, 'The updated room, or a rejection with `success: false`'),
				401: UNAUTHORIZED_ENVELOPE,
			},
		}),
		async (c) => {
			const accountId = await authedAccountId(c)
			if (accountId === null) {
				return c.json({ success: false, error: 'Unauthorized', value: null }, 401)
			}

			const roomId = Number.parseInt(c.req.param('roomId'), 10)
			const subRoomId = Number.parseInt(c.req.param('subRoomId'), 10)

			const room = await getRoomById(c.env.DB, roomId)
			if (!room) return roomEnvelope(c, null, 'This room does not exist!')
			if (room.CreatorAccountId !== accountId) {
				return roomEnvelope(c, null, 'You are not the owner of this room!')
			}

			const result = await cloneSubRoom(c.env.DB, roomId, subRoomId, accountId)
			if (!result) return roomEnvelope(c, null, 'This subroom does not exist!')

			await pushRoomUpdate(c, accountId, result.room)
			return roomEnvelope(c, result.room)
		}
	)

	// Create a new (empty) subroom in a room (form body `name`). Auth-gated (401) and
	// owner-only. Mints a fresh globally-unique SubRoomId, bases the scene/capacity on the
	// room's first subroom, notifies the owner (RoomUpdate), and returns the updated ROOM
	// in the `{ success, error, value }` envelope (the client re-renders the room's subroom
	// list from `value`, so it's the whole room, not the bare subroom).
	.post(
		'/rooms/:roomId{[0-9]+}/subrooms',
		describeRoute({
			tags: ['Subrooms'],
			summary: 'Create a subroom',
			description: [
				'Adds an empty subroom to a room. Owner-only. It mints a fresh globally-unique',
				'`SubRoomId` (the game numbers subrooms from one sequence, not per room) and inherits',
				'the scene and capacity of the room’s first existing subroom.',
				'',
				'Answers the updated ROOM, not the bare subroom — the client re-renders the room’s',
				'subroom list from `value`. Delete answers the same shape.',
			].join('\n'),
			security: AUTHED,
			parameters: [roomIdParam],
			requestBody: form(CreateSubRoomRequest, 'The new subroom’s name'),
			responses: {
				200: json(RoomEnvelope, 'The updated room, or a rejection with `success: false`'),
				401: UNAUTHORIZED_ENVELOPE,
			},
		}),
		async (c) => {
			const accountId = await authedAccountId(c)
			if (accountId === null) {
				return c.json({ success: false, error: 'Unauthorized', value: null }, 401)
			}

			const roomId = Number.parseInt(c.req.param('roomId'), 10)
			const room = await getRoomById(c.env.DB, roomId)
			if (!room) return roomEnvelope(c, null, 'This room does not exist!')
			if (room.CreatorAccountId !== accountId) {
				return roomEnvelope(c, null, 'You are not the owner of this room!')
			}

			const body = (await c.req.parseBody().catch(() => ({}))) as Record<string, unknown>
			const name = typeof body.name === 'string' ? body.name.trim() : ''
			if (name === '') return roomEnvelope(c, null, 'You must enter a name for your subroom!')

			const result = await createSubRoom(c.env.DB, roomId, accountId, name)
			if (!result) return roomEnvelope(c, null, 'This room does not exist!')

			await pushRoomUpdate(c, accountId, result.room)
			return roomEnvelope(c, result.room)
		}
	)

	// Delete a subroom from a room. Auth-gated (401) and owner-only. Refuses to remove a
	// room's only subroom. Notifies the owner (RoomUpdate) and returns the updated ROOM in
	// the `{ success, error, value }` envelope (same shape as create, so the client
	// re-renders the subroom list from `value`).
	.delete(
		'/rooms/:roomId{[0-9]+}/subrooms/:subRoomId{[0-9]+}',
		describeRoute({
			tags: ['Subrooms'],
			summary: 'Delete a subroom',
			description: [
				'Removes a subroom from a room. Owner-only, and it refuses to remove a room’s only',
				'subroom — that would leave the room with no scene to load. Any saved-data blob the',
				'subroom pointed at is left in R2, the same way deleting a room leaves the photos',
				'taken in it. Answers the updated ROOM, like create.',
			].join(' '),
			security: AUTHED,
			parameters: [roomIdParam, subRoomIdParam],
			responses: {
				200: json(RoomEnvelope, 'The updated room, or a rejection with `success: false`'),
				401: UNAUTHORIZED_ENVELOPE,
			},
		}),
		async (c) => {
			const accountId = await authedAccountId(c)
			if (accountId === null) {
				return c.json({ success: false, error: 'Unauthorized', value: null }, 401)
			}

			const roomId = Number.parseInt(c.req.param('roomId'), 10)
			const subRoomId = Number.parseInt(c.req.param('subRoomId'), 10)

			const room = await getRoomById(c.env.DB, roomId)
			if (!room) return roomEnvelope(c, null, 'This room does not exist!')
			if (room.CreatorAccountId !== accountId) {
				return roomEnvelope(c, null, 'You are not the owner of this room!')
			}

			const result = await deleteSubRoom(c.env.DB, roomId, subRoomId)
			if (!result.ok) {
				return roomEnvelope(
					c,
					null,
					result.reason === 'last_subroom'
						? "You can't delete a room's only subroom!"
						: 'This subroom does not exist!'
				)
			}

			await pushRoomUpdate(c, accountId, result.room)
			return roomEnvelope(c, result.room)
		}
	)

	// Rooms similar to the given room (sharing tags). Paginated via skip/take (take
	// defaults to 100). Returns `{ Results, TotalResults }`; empty when the room is
	// unknown/untagged.
	.get(
		'/rooms/:roomId{[0-9]+}/similar',
		describeRoute({
			tags: ['Discovery'],
			summary: 'Rooms similar to a room',
			description: [
				'Rooms sharing tags with the given one — the “more like this” rail. Empty when the',
				'room is unknown or carries no tags.',
			].join(' '),
			parameters: [roomIdParam, ...pageParams(100)],
			responses: { 200: json(PagedRooms, 'The similar rooms') },
		}),
		async (c) => {
			const skip = Number.parseInt(c.req.query('skip') ?? '0', 10) || 0
			const take = Number.parseInt(c.req.query('take') ?? '100', 10) || 100
			return c.json(
				await getSimilarRooms(c.env.DB, Number.parseInt(c.req.param('roomId'), 10), skip, take)
			)
		}
	)

	// The caller's per-room player data. Stub → empty blob (client reads `Data`).
	.get(
		'/rooms/:roomId{[0-9]+}/playerdata/me',
		describeRoute({
			tags: ['Rooms'],
			summary: 'The caller’s per-room player data',
			description: [
				'Per-room save data for the calling player. Nothing stores any yet, so this is a stub',
				'serving an empty blob — which the client reads as “no saved data”. No auth: there’s',
				'no caller-specific state to protect until something writes here.',
			].join(' '),
			parameters: [roomIdParam],
			responses: { 200: json(PlayerDataDto, 'An empty data blob') },
		}),
		(c) => c.json({ Data: '' })
	)

	// Single room by id. 404 when the room isn't in D1. Ignores the
	// include/unityAsset* query params.
	.get(
		'/rooms/:roomId{[0-9]+}',
		describeRoute({
			tags: ['Rooms'],
			summary: 'A room by id',
			description: [
				'The room as stored, with its `SubRooms` re-attached. Unlike `GET /rooms?id=`, an',
				'unknown room here is a 404, not `{}`. The `include`/`unityAsset*` query params the',
				'client sends are accepted and ignored.',
			].join(' '),
			parameters: [
				roomIdParam,
				stringQuery('include', 'Accepted and ignored'),
				stringQuery('unityAssetTarget', 'Accepted and ignored'),
				stringQuery('unityAssetVersion', 'Accepted and ignored'),
			],
			responses: { 200: json(RoomDto, 'The room'), 404: { description: 'No such room' } },
		}),
		async (c) => {
			const room = await getRoomById(c.env.DB, Number.parseInt(c.req.param('roomId'), 10))
			return room ? c.json(room) : c.notFound()
		}
	)

	// Photon access token + room permissions the client needs to spawn into a
	// room. The client calls it on the rooms host both bare and under `/roomserver`.
	.get(
		'/photon_access_token',
		describeRoute({
			tags: ['Session'],
			summary: 'Photon token + room permissions',
			description: [
				'The permission table and Photon credentials the client needs to spawn into a room.',
				'`RoomInstanceId` is the caller’s current instance, read from the shared `presence`',
				'table (null when they’re in none).',
				'',
				'`PhotonAccessToken` is always empty: the reference server signs it with a',
				'secret/algorithm we don’t have, and our Photon setup accepts an empty token. The',
				'global (Role 0) maker pen is granted only to the hardcoded dev accounts.',
			].join('\n'),
			security: AUTHED,
			responses: {
				200: json(PhotonAccessTokenDto, 'The permissions and (empty) token'),
				401: UNAUTHORIZED_RESPONSE,
			},
		}),
		handlePhotonAccessToken
	)
	.get(
		'/roomserver/photon_access_token',
		describeRoute({
			tags: ['Session'],
			summary: 'Photon token + room permissions (legacy path)',
			description: [
				'Identical to `GET /photon_access_token` — the client calls it both bare and under the',
				'`/roomserver` prefix, so both forms are registered.',
			].join(' '),
			security: AUTHED,
			responses: {
				200: json(PhotonAccessTokenDto, 'The permissions and (empty) token'),
				401: UNAUTHORIZED_RESPONSE,
			},
		}),
		handlePhotonAccessToken
	)

// The generated spec. Documentation only — no request is validated against it (see
// openapi.ts). `hide: true` keeps this route out of its own output.
app.get(
	'/openapi.json',
	describeRoute({ hide: true }),
	withCleanSpec(
		openAPIRouteHandler(app, {
			documentation: {
				info: {
					title: 'recflare rooms',
					version: '1.0.0',
					description: [
						'The room server for recflare, a private-server reimplementation of the Rec Room',
						'backend: room storage, the browse/search feeds, per-player cheers and favorites,',
						'the owner’s room settings, and subrooms.',
						'',
						'A room is a single JSON blob in the shared `recflare` D1, with generated columns',
						'for the queryable fields; reads serve that blob verbatim, which is why the shapes',
						'here are the client’s PascalCase ones. Subrooms live in their own table (their ids',
						'come from one global sequence, not per room) and are re-attached to each room on',
						'read. The seed rooms — including the dorm — come from `static/ImportRooms.json`.',
						'',
						'Two response envelopes appear side by side: a PascalCase',
						'`{ Success, Value, ErrorId, Error }` and a lowercase `{ success, error, value }`.',
						'Which one a route uses is dictated by the client’s deserializer for that call, so',
						'the inconsistency is deliberate. Both answer HTTP 200 even for a rejection — the',
						'client reads the flag, not the status.',
					].join('\n'),
				},
				servers: [{ url: 'https://rooms.recflare.net', description: 'Production' }],
				components: {
					securitySchemes: {
						bearerAuth: {
							type: 'http',
							scheme: 'bearer',
							bearerFormat: 'JWT',
							description: 'An `access_token` from the auth worker’s `POST /connect/token`.',
						},
					},
				},
			},
		})
	)
)

export default app
