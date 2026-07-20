import { resolver } from 'hono-openapi'
import { z } from 'zod'

import type { OpenAPIV3_1 } from 'openapi-types'

/**
 * OpenAPI schemas for the accounts worker.
 *
 * IMPORTANT: these are DESCRIPTIVE ONLY. They are passed to `describeRoute` to
 * generate the spec and are never wired into `hono-openapi`'s `validator()`.
 *
 * As with the auth worker, this is deliberate. The Rec Room client is the only real
 * consumer and the handlers are intentionally lenient — form fields are read as
 * `typeof value === 'string' ? value : ''` and missing/malformed input falls through
 * to a graceful path (or a synthesized default account) rather than a hard error.
 * These schemas record what the client is observed to send and what we send back; to
 * enforce one, do it per-route and land a test with it.
 */

/** Emit a zod schema as an `application/json` response body. */
export function json(schema: z.ZodType, description: string) {
	return { description, content: { 'application/json': { schema: resolver(schema) } } }
}

/**
 * Emit a zod schema as a form request body. `describeRoute`'s `requestBody` takes a
 * plain OpenAPI schema (not a `resolver()`), so convert here. zod's `$schema` key and
 * `additionalProperties: false` are dropped — these handlers read the fields they know
 * and ignore the rest, so claiming a closed object would misreport them as stricter
 * than they are. The client posts both urlencoded and multipart, hence the wildcard.
 */
export function form(schema: z.ZodType, description: string): OpenAPIV3_1.RequestBodyObject {
	const { $schema: _$schema, additionalProperties: _extra, ...jsonSchema } = z.toJSONSchema(schema)
	return {
		description,
		content: {
			// zod's JSONSchema type is far wider than OpenAPI's SchemaObject; cast at the
			// boundary (the emitted value is valid OpenAPI 3.1).
			'application/x-www-form-urlencoded': { schema: jsonSchema as OpenAPIV3_1.SchemaObject },
			'multipart/form-data': { schema: jsonSchema as OpenAPIV3_1.SchemaObject },
		},
	}
}

/**
 * The public account DTO (`toAccountDto`) — the camelCase shape returned for any
 * account, with private fields (email, birthday) excluded. Fields the client parses
 * as enums are numbers here.
 */
export const AccountDto = z
	.object({
		accountId: z.int(),
		username: z.string(),
		displayName: z.string(),
		profileImage: z.string().describe('Avatar object key'),
		isJunior: z.boolean(),
		platforms: z.int().describe('PlatformType bitmask of linked platforms'),
		personalPronouns: z.int().describe('Pronoun flags bitmask'),
		identityFlags: z.int().describe('Identity flags bitmask'),
		createdAt: z.iso.datetime(),
	})
	.meta({ id: 'AccountDto' })

/**
 * The private self DTO (`toSelfAccountDto`, the `/account/me` shape) — the public DTO
 * plus owner-only fields. `juniorState`/`parentAccountId` are omitted entirely when
 * unset (emitting `null` makes the client's enum parser throw); `email`/`birthday` are
 * kept as nullable since they aren't enums.
 */
export const SelfAccountDto = AccountDto.extend({
	email: z.string().nullable(),
	birthday: z.null().describe('Always null — birthday is not stored'),
	availableUsernameChanges: z.int().describe('Remaining username changes'),
}).meta({ id: 'SelfAccountDto' })

/** Player bio, from `GET /account/:id/bio`. */
export const BioResponse = z
	.object({ accountId: z.int(), bio: z.string().describe('"" when unset') })
	.meta({ id: 'BioResponse' })

/** A bare `{ success: true }` ack, returned by most profile mutations. */
export const SuccessResponse = z
	.object({ success: z.literal(true) })
	.meta({ id: 'SuccessResponse' })

/** The RecNet result envelope `{ success, value }` used by create + username change. */
export function envelope(value: z.ZodType, id: string) {
	return z
		.object({
			success: z.boolean(),
			value,
			error: z.string().optional().describe('Present (with success:false) on failure'),
		})
		.meta({ id })
}

/**
 * The username-change envelope. Always HTTP 200 even on failure: `success:false` with
 * a message in `error` and `value` an empty string; on success `value` is the updated
 * public account.
 */
export const UsernameResult = envelope(
	z.union([AccountDto, z.literal('')]),
	'UsernameResult'
).describe('value is the updated account on success, "" on failure')

/** `POST /account/create` response. */
export const CreateAccountResult = envelope(AccountDto, 'CreateAccountResult')

/** `GET /parentalcontrol/me` response. */
export const ParentalControl = z
	.object({ accountId: z.int(), disallowInAppPurchases: z.boolean() })
	.meta({ id: 'ParentalControl' })

/**
 * `GET /accountprivacysettings/:id` response. A bare `{}` fails the client's
 * deserializer, so the id is echoed back and recent history reported visible; nothing
 * stores per-player privacy yet.
 */
export const PrivacySettings = z
	.object({ accountId: z.int(), isRecentHistoryVisible: z.boolean() })
	.meta({ id: 'PrivacySettings' })

/** Root health check. */
export const HealthResponse = z
	.object({ service: z.literal('accounts'), status: z.literal('ok') })
	.meta({ id: 'HealthResponse' })

// ---- Request bodies --------------------------------------------------------

/** `POST /account/create` form body. Both fields are parsed but not yet persisted. */
export const CreateAccountRequest = z
	.object({
		platform: z.string().optional().describe('PlatformType integer string; defaults to 0'),
		platformId: z.string().optional().describe('Parsed for fidelity; currently unused'),
	})
	.meta({ id: 'CreateAccountRequest' })

/** Single-string form bodies, one per profile mutation. */
export const DisplayNameRequest = z
	.object({ displayName: z.string().describe('Trimmed; empty is rejected (400)') })
	.meta({ id: 'DisplayNameRequest' })

export const UsernameRequest = z
	.object({ username: z.string().describe('Trimmed; must be unique and changes must remain') })
	.meta({ id: 'UsernameRequest' })

export const EmailRequest = z
	.object({ email: z.string().describe('Must contain "@"; otherwise 400') })
	.meta({ id: 'EmailRequest' })

export const PhoneRequest = z
	.object({ phone: z.string().describe('Trimmed; empty is rejected (400)') })
	.meta({ id: 'PhoneRequest' })

export const IdentityFlagsRequest = z
	.object({ identityFlags: z.string().describe('Integer string bitmask; non-numeric is 400') })
	.meta({ id: 'IdentityFlagsRequest' })

export const PronounsRequest = z
	.object({ pronounFlags: z.string().describe('Integer string bitmask; non-numeric is 400') })
	.meta({ id: 'PronounsRequest' })

export const BioRequest = z
	.object({ bio: z.string().describe('Free text; empty is allowed') })
	.meta({ id: 'BioRequest' })

export const ProfileImageRequest = z
	.object({ imageName: z.string().describe('Avatar object key; empty is rejected (400)') })
	.meta({ id: 'ProfileImageRequest' })
