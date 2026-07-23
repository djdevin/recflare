import { resolver } from 'hono-openapi'
import { z } from 'zod'

import type { OpenAPIV3_1 } from 'openapi-types'

/**
 * OpenAPI schemas for the match worker.
 *
 * IMPORTANT: these are DESCRIPTIVE ONLY. They are passed to `describeRoute` to
 * generate the spec and are never wired into `hono-openapi`'s `validator()`.
 *
 * As with the auth/accounts workers, this is deliberate: the Rec Room client is the
 * only real consumer, the handlers are lenient (bodies are parsed defensively and
 * missing fields fall through to sensible defaults), and the exact request/response
 * shapes are reverse-engineered. These schemas record observed behaviour; to enforce
 * one, do it per-route and land a test with it.
 */

/** Emit a zod schema as an `application/json` response body. */
export function json(schema: z.ZodType, description: string) {
	return { description, content: { 'application/json': { schema: resolver(schema) } } }
}

/**
 * Convert a zod schema to a plain OpenAPI schema for a request body. `describeRoute`'s
 * `requestBody` takes an OpenAPI schema (not a `resolver()`). zod's `$schema` key and
 * `additionalProperties: false` are dropped — the handlers read the fields they know
 * and ignore the rest, so a closed object would misreport them as stricter than they
 * are.
 */
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

/** An `application/json` request body (the heartbeat posts one). */
export function jsonBody(schema: z.ZodType, description: string): OpenAPIV3_1.RequestBodyObject {
	return { description, content: { 'application/json': { schema: toOpenApiSchema(schema) } } }
}

/** An empty-body `200 OK` ack — the response many match routes return. */
export const EMPTY_OK = { description: 'Acknowledged (empty body)' }

/** The empty-body 401 the auth-gated routes return. */
export const UNAUTHORIZED_RESPONSE = { description: 'Missing or invalid bearer token (empty body)' }

/** Bearer-JWT security requirement, for the auth-gated routes. */
export const AUTHED = [{ bearerAuth: [] }]

/**
 * RoomInstanceType enum, by value. `Dormroom` instances are private; `Public` are the
 * shared, joinable ones matchmaking reuses.
 */
export const RoomInstanceType = z
	.int()
	.describe('RoomInstanceType: 0 Public, 1 Dormroom, … (see @repo/domain)')

/**
 * A room instance — the session the client connects to (scene + Photon coordinates).
 * Joiners of the same public instance share `roomInstanceId` and `photonRoomId`. Names
 * are `^`-prefixed so the client resolves the scene (personal dorms use `@owner's Dorm`
 * instead). `location` is the SubRoom's Unity scene id; an empty one makes the client
 * reject the session.
 */
export const RoomInstanceDto = z.object({
	roomInstanceId: z.int(),
	roomId: z.int(),
	subRoomId: z.int().describe('Which subroom (scene) of the room this instance is'),
	roomInstanceType: RoomInstanceType,
	location: z.string().describe('SubRoom Unity scene id; empty is rejected by the client'),
	dataBlob: z.string(),
	eventId: z.int(),
	clubId: z.int(),
	roomCode: z.string(),
	photonRegion: z.string(),
	photonRegionId: z.string(),
	photonRoomId: z.string().describe('Shared by joiners of the same instance'),
	name: z.string().describe('`^`-prefixed (or `@owner’s Dorm` for personal dorms)'),
	maxCapacity: z.int(),
	isFull: z.boolean(),
	isPrivate: z.boolean(),
	isInProgress: z.boolean().describe('Set by the owner via PUT /roominstance/:id/inprogress'),
	EncryptVoiceChat: z.boolean(),
})

/**
 * A player's presence as the client reads it (`GET /player`, `POST /player/heartbeat`).
 * `isOnline` means "has a live (unexpired) presence row", NOT "is in a room" — a player
 * can be online in the lobby with `roomInstance` null. The `photon*`/`voice*`
 * connection fields are only populated in a matchmaking response, never here, but the
 * client needs the keys present, so they're always null.
 */
export const PlayerDto = z.object({
	playerId: z.int(),
	isOnline: z.boolean().describe('Has a live presence row (presence expires on a TTL)'),
	errorCode: z.int().describe('0 = no error; non-zero only on a failed matchmake'),
	roomInstance: RoomInstanceDto.nullable().describe('null when not in a room'),
	appVersion: z.string(),
	deviceClass: z.int(),
	statusVisibility: z.int(),
	vrMovementMode: z.int(),
	platform: z.int(),
	photonAuthToken: z.null(),
	photonRealtimeAppId: z.null(),
	photonVoiceAppId: z.null(),
	photonChatAppId: z.null(),
	photonRegion: z.null(),
	photonRoomId: z.null(),
	voiceConnectionInfo: z.null(),
	voiceServerId: z.null(),
	experiments: z.null(),
})

/**
 * The matchmake/goto result envelope. `errorCode` 0 with a `roomInstance` is success;
 * a non-zero code (e.g. 20 NoSuchRoom) comes with `roomInstance: null`.
 */
export const MatchmakeResponse = z.object({
	errorCode: z.int().describe('0 = success; 20 = NoSuchRoom'),
	roomInstance: RoomInstanceDto.nullable(),
})

/** `POST /player/exclusivelogin` — a bare error code. */
export const ExclusiveLoginResponse = z.object({ errorCode: z.int().describe('Always 0') })

/**
 * `POST /player/heartbeat` JSON body. All fields optional — the client also posts a
 * non-JSON (LoginLock form) body here, in which case none of these are read and stored
 * presence is echoed back unchanged.
 */
export const HeartbeatRequest = z.object({
	playerId: z.int().optional(),
	statusVisibility: z.int().optional(),
	deviceClass: z.int().optional(),
	vrMovementMode: z.int().optional(),
	appVersion: z.string().nullable().optional(),
	platform: z.int().optional(),
})

/** `PUT /roominstance/:id/inprogress` form body. */
export const InProgressRequest = z.object({
	inProgress: z.string().describe('"True" | "False" (case-insensitive)'),
})

/** `PUT /player/statusvisibility` form body. */
export const StatusVisibilityRequest = z.object({
	statusVisibility: z.string().describe('Integer string; non-numeric is ignored'),
})

/**
 * The `JoinMode` form field the matchmake/goto routes read (`2` = a private instance;
 * anything else = public). Posted as a urlencoded/multipart body.
 */
export const JoinModeRequest = z.object({
	JoinMode: z.string().optional().describe('"2" requests a private instance'),
})

/**
 * The room-matchmake form body (`/matchmake/room/:roomId[/:subRoomId]`). Beyond
 * `JoinMode` the 2023 client posts `AdditionalPlayerIds` — the caller's party — so each
 * of them is invited (a game invite) into the instance the leader lands in. May repeat
 * and/or be comma-separated. Other fields the client sends (`LoginLock`,
 * `MaxPersistenceVersion`, `BypassMovementModeRestriction`) are accepted and ignored.
 */
export const MatchmakeRoomRequest = z.object({
	JoinMode: z.string().optional().describe('"2" requests a private instance'),
	AdditionalPlayerIds: z
		.string()
		.optional()
		.describe('Party members to invite into the room; repeatable and/or comma-separated'),
})

/** `POST /invite` form body — invite a player into the caller's room instance. */
export const InviteRequest = z.object({
	playerId: z.string().describe('The account to invite; a non-zero integer (else 400)'),
	roomInstanceId: z
		.string()
		.optional()
		.describe('The caller’s room instance to invite them into; resolves the invite’s RoomId'),
})
