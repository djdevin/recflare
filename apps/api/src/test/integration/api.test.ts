import { adminSecretsStore, env } from 'cloudflare:test'
import { exports } from 'cloudflare:workers'
import { beforeAll, describe, expect, test } from 'vitest'

import '../../api.app'

import { createImage, getImageByName, SCHEMA_DDL as IMAGES_SCHEMA_DDL } from '../../images-db'
import { SCHEMA_DDL as INVENTIONS_SCHEMA_DDL } from '../../inventions-db'
import { SCHEMA_DDL as RELATIONSHIPS_SCHEMA_DDL } from '../../relationships-db'

import type { Env } from '../../context'
import type { SavedImage } from '../../images-db'
import type { InventionSaveResult, SavedInvention } from '../../inventions-db'

declare module 'cloudflare:test' {
	interface ProvidedEnv extends Env {}
}

const ORIGIN = 'https://example.com'

// `/api/rooms/v1/verifyRole` reads room roles from the shared recflare D1. Set
// up the schema (matching the rooms worker's migration) + a couple of rooms.
const TEST_ROOMS = [
	{
		RoomId: 2,
		Name: 'RecCenter',
		IsDorm: false,
		CreatorAccountId: 1,
		SubRooms: [{ SubRoomId: 2 }],
	},
	{
		// Owned by account 1; account 42 holds Role 30 (a co-owner) for verifyRole tests.
		RoomId: 3,
		Name: 'RoleRoom',
		IsDorm: false,
		CreatorAccountId: 1,
		SubRooms: [{ SubRoomId: 3 }],
		Roles: [{ AccountId: 42, Role: 30, LastChangedByAccountId: null, InvitedRole: 0 }],
	},
]

beforeAll(async () => {
	// Seed the shared JWT signing key into the local Secrets Store so .get() resolves.
	await adminSecretsStore(env.JWT_SECRET).create('test-signing-key')
	await env.DB.prepare(
		`CREATE TABLE IF NOT EXISTS room (
			data TEXT NOT NULL,
			room_id INTEGER GENERATED ALWAYS AS (json_extract(data, '$.RoomId')) VIRTUAL,
			name_lower TEXT GENERATED ALWAYS AS (lower(json_extract(data, '$.Name'))) VIRTUAL,
			creator_account_id INTEGER GENERATED ALWAYS AS (json_extract(data, '$.CreatorAccountId')) VIRTUAL
		)`
	).run()
	const insert = env.DB.prepare('INSERT OR IGNORE INTO room (data) VALUES (?1)')
	await env.DB.batch(TEST_ROOMS.map((r) => insert.bind(JSON.stringify(r))))

	// Accounts table (matching the auth worker's migration) — uploadsaved records
	// profile thumbnails on the account row. Seed the account the test token (sub
	// 42) authenticates as.
	await env.DB.prepare(
		`CREATE TABLE IF NOT EXISTS account (
			data TEXT NOT NULL,
			account_id INTEGER GENERATED ALWAYS AS (json_extract(data, '$.accountId')) VIRTUAL,
			username_lower TEXT GENERATED ALWAYS AS (lower(json_extract(data, '$.username'))) VIRTUAL
		)`
	).run()
	await env.DB.prepare('INSERT OR IGNORE INTO account (data) VALUES (?1)')
		.bind(
			JSON.stringify({ accountId: 42, username: 'Tester', profileImage: 'DefaultProfileImage.jpg' })
		)
		.run()

	// Images table (owned by the img worker) — uploadsaved records a row here.
	for (const stmt of IMAGES_SCHEMA_DDL) await env.DB.prepare(stmt).run()

	// Relationships table (owned by the api worker) — friendship endpoints use it.
	for (const stmt of RELATIONSHIPS_SCHEMA_DDL) await env.DB.prepare(stmt).run()

	// Inventions table (owned by the api worker) — invention save/mine use it.
	for (const stmt of INVENTIONS_SCHEMA_DDL) await env.DB.prepare(stmt).run()
})

// Mint a token the way the `auth` worker does, signing with the shared test key seeded into the JWT_SECRET store, so the
// api worker's validation accepts it. Kept inline to avoid a cross-package import.
const TEST_SECRET = 'test-signing-key'

function b64url(input: ArrayBuffer | string): string {
	const bytes = typeof input === 'string' ? new TextEncoder().encode(input) : new Uint8Array(input)
	let binary = ''
	for (const byte of bytes) binary += String.fromCharCode(byte)
	return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

async function bearer(sub = '42'): Promise<Record<string, string>> {
	const now = Math.floor(Date.now() / 1000)
	const signingInput = `${b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }))}.${b64url(
		JSON.stringify({ sub, exp: now + 3600 })
	)}`
	const key = await crypto.subtle.importKey(
		'raw',
		new TextEncoder().encode(TEST_SECRET),
		{ name: 'HMAC', hash: 'SHA-256' },
		false,
		['sign']
	)
	const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(signingInput))
	return { Authorization: `Bearer ${signingInput}.${b64url(sig)}` }
}

describe('public endpoints', () => {
	test('GET /api/config/v1/amplitude', async () => {
		const res = await exports.default.fetch(`${ORIGIN}/api/config/v1/amplitude`)
		expect(res.status).toBe(200)
		expect(await res.json()).toEqual({
			AmplitudeKey: 'a',
			StatSigKey: 'a',
			RudderStackKey: 'a',
			UseRudderStack: false,
		})
	})

	test('GET /api/config/v1/azurespeech', async () => {
		const res = await exports.default.fetch(`${ORIGIN}/api/config/v1/azurespeech`)
		expect(res.status).toBe(200)
		expect(await res.json()).toEqual({
			Key: 'dce8de5b297747d9b5bddcc7f19e8c5b',
			Region: 'eastus',
			Enabled: false,
		})
	})

	test('GET /api/config/v1/backtrace', async () => {
		const res = await exports.default.fetch(`${ORIGIN}/api/config/v1/backtrace`)
		expect(res.status).toBe(200)
		const body = (await res.json()) as { ReportBudget: number; VersionRegex: string }
		expect(body).toMatchObject({ ReportBudget: 125, VersionRegex: '.*' })
	})

	test('GET /api/versioncheck/v4', async () => {
		const res = await exports.default.fetch(`${ORIGIN}/api/versioncheck/v4`)
		expect(await res.json()).toMatchObject({ VersionStatus: 0 })
	})

	test('GET /api/relationships/v2/get returns empty array for a player with none', async () => {
		const res = await exports.default.fetch(`${ORIGIN}/api/relationships/v2/get`, {
			headers: await bearer('99999'),
		})
		expect(res.status).toBe(200)
		expect(await res.json()).toEqual([])
	})

	test('GET /api/playerReputation/v1/:id echoes the id', async () => {
		const res = await exports.default.fetch(`${ORIGIN}/api/playerReputation/v1/99`)
		expect(await res.json()).toMatchObject({ AccountId: 99, CheerCredit: 20 })
	})

	test('GET /api/playerReputation/v2/bulk?id= returns a reputation per id', async () => {
		const res = await exports.default.fetch(`${ORIGIN}/api/playerReputation/v2/bulk?id=1380`)
		expect(res.status).toBe(200)
		// The full reputation shape the client expects, field for field.
		expect(await res.json()).toEqual([
			{
				AccountId: 1380,
				IsCheerful: true,
				Noteriety: 0,
				SelectedCheer: 0,
				CheerCredit: 20,
				CheerGeneral: 0,
				CheerHelpful: 0,
				CheerCreative: 0,
				CheerGreatHost: 0,
				CheerSportsman: 0,
				SubscriberCount: 0,
				SubscribedCount: 0,
			},
		])

		const many = await exports.default.fetch(`${ORIGIN}/api/playerReputation/v2/bulk?id=1&id=2`)
		const reps = (await many.json()) as Array<{ AccountId: number }>
		expect(reps.map((r) => r.AccountId)).toEqual([1, 2])
	})

	test('GET /api/playerevents/v1/tagfilters returns empty filter chips', async () => {
		// No player-event storage → no tags in use → no chips. Trending is null.
		const res = await exports.default.fetch(`${ORIGIN}/api/playerevents/v1/tagfilters`)
		expect(res.status).toBe(200)
		expect(await res.json()).toEqual({
			PinnedFilters: [],
			PopularFilters: [],
			TrendingFilters: null,
		})
	})

	test('GET /api/activities/charades/v1/words/Charades returns the word bank', async () => {
		const res = await exports.default.fetch(`${ORIGIN}/api/activities/charades/v1/words/Charades`)
		expect(res.status).toBe(200)
		const words = (await res.json()) as Array<{ Id: number; Difficulty: number; EN_US: string }>
		expect(Array.isArray(words)).toBe(true)
		expect(words.length).toBeGreaterThan(0)
		expect(words[0]).toEqual({ Id: 1, Difficulty: 0, EN_US: 'David Bowie' })
	})

	test('GET /api/playerevents/v1/clubs returns an empty event list', async () => {
		// The client deserializes this as a bare array — an envelope here fails with
		// "expected:'[', actual:'{'". No player-event storage yet → empty.
		const res = await exports.default.fetch(`${ORIGIN}/api/playerevents/v1/clubs?id=1&id=2`)
		expect(res.status).toBe(200)
		expect(await res.json()).toEqual([])

		// The single-club form does wrap its events with a paging cursor.
		const one = await exports.default.fetch(`${ORIGIN}/api/playerevents/v1/club/1`)
		expect(one.status).toBe(200)
		expect(await one.json()).toEqual({ ContinuationToken: '', Events: [] })
	})

	test('GET /api/PlayerReporting/v1/moderationBlockDetails reports "not blocked"', async () => {
		const res = await exports.default.fetch(
			`${ORIGIN}/api/PlayerReporting/v1/moderationBlockDetails`
		)
		expect(res.status).toBe(200)
		// ReportCategory -1 = no category (0 is a real one), and Message is null.
		expect(await res.json()).toEqual({
			ReportCategory: -1,
			Duration: 0,
			GameSessionId: 0,
			IsBan: false,
			IsHostKick: false,
			IsVoiceModAutoban: false,
			Message: null,
			PlayerIdReporter: null,
			TimeoutStartedAt: null,
		})
	})

	// Unauthenticated by design — the client posts this before it has an account, so
	// there's no bearer token to check and nothing to attribute the id to.
	test('POST /api/PlayerReporting/v1/deviceId accepts an unauthenticated report', async () => {
		const res = await exports.default.fetch(`${ORIGIN}/api/PlayerReporting/v1/deviceId`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
			body: new URLSearchParams({
				oldDeviceId: '491e8b9',
				newDeviceId: '491e8b9566cb1b593367c72860e978b3d5765326',
				platform: '0',
			}),
		})
		expect(res.status).toBe(200)
		expect(await res.json()).toEqual({ success: true, error: '' })
	})

	test('POST /api/playerReputation/v2/bulk returns a reputation per id', async () => {
		const res = await exports.default.fetch(`${ORIGIN}/api/playerReputation/v2/bulk`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
			body: new URLSearchParams({ Ids: '1,2,3' }),
		})
		expect(res.status).toBe(200)
		const reps = (await res.json()) as Array<{ AccountId: number; CheerCredit: number }>
		expect(reps.map((r) => r.AccountId)).toEqual([1, 2, 3])
		expect(reps.every((r) => r.CheerCredit === 20)).toBe(true)
	})

	test('POST /api/playerReputation/v2/bulk returns [] without ids', async () => {
		const res = await exports.default.fetch(`${ORIGIN}/api/playerReputation/v2/bulk`, {
			method: 'POST',
		})
		expect(await res.json()).toEqual([])
	})

	test('GET /api/players/v2/progression/bulk?id= returns progression per id', async () => {
		const res = await exports.default.fetch(`${ORIGIN}/api/players/v2/progression/bulk?id=1&id=2`)
		expect(res.status).toBe(200)
		const body = (await res.json()) as Array<{ PlayerId: number; Level: number }>
		expect(body.map((p) => p.PlayerId)).toEqual([1, 2])
		expect(body[0]).toMatchObject({ Level: 1, XP: 0 })
	})

	test('POST /api/players/v2/progression/bulk returns an array', async () => {
		const res = await exports.default.fetch(`${ORIGIN}/api/players/v2/progression/bulk`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
			body: new URLSearchParams({ Ids: '1,2,3' }),
		})
		expect(res.status).toBe(200)
		expect(await res.json()).toEqual([])
	})

	test('GET /api/customAvatarItems/v1/isCreationAllowedForAccount returns a success envelope', async () => {
		const res = await exports.default.fetch(
			`${ORIGIN}/api/customAvatarItems/v1/isCreationAllowedForAccount`
		)
		expect(res.status).toBe(200)
		expect(await res.json()).toEqual({ success: true, value: null })
	})

	test('GET /api/customAvatarItems/v1/isCreationEnabled returns true', async () => {
		const res = await exports.default.fetch(`${ORIGIN}/api/customAvatarItems/v1/isCreationEnabled`)
		expect(res.status).toBe(200)
		expect(await res.json()).toBe(true)
	})

	test('GET /api/customAvatarItems/v1/isRenderingEnabled returns true', async () => {
		const res = await exports.default.fetch(`${ORIGIN}/api/customAvatarItems/v1/isRenderingEnabled`)
		expect(res.status).toBe(200)
		expect(await res.json()).toBe(true)
	})

	test('GET /api/customAvatarItems/v1/featured returns []', async () => {
		const res = await exports.default.fetch(`${ORIGIN}/api/customAvatarItems/v1/featured`)
		expect(res.status).toBe(200)
		expect(await res.json()).toEqual([])
	})

	test('GET /api/customAvatarItems/v1/hot returns []', async () => {
		const res = await exports.default.fetch(`${ORIGIN}/api/customAvatarItems/v1/hot`)
		expect(res.status).toBe(200)
		expect(await res.json()).toEqual([])
	})

	test('GET /api/customAvatarItems/v2/fromCreator/:id returns an empty paginated result', async () => {
		const res = await exports.default.fetch(`${ORIGIN}/api/customAvatarItems/v2/fromCreator/2`)
		expect(res.status).toBe(200)
		expect(await res.json()).toEqual({ Results: [], TotalResults: 0 })
	})

	test('GET /api/rooms/v1/filters returns an object with filter arrays', async () => {
		const res = await exports.default.fetch(`${ORIGIN}/api/rooms/v1/filters`)
		expect(res.status).toBe(200)
		const body = (await res.json()) as { PinnedFilters: string[]; PopularFilters: string[] }
		expect(Array.isArray(body.PinnedFilters)).toBe(true)
		expect(Array.isArray(body.PopularFilters)).toBe(true)
	})

	test('GET /api/keepsakes/globalconfig returns the keepsake config', async () => {
		const res = await exports.default.fetch(`${ORIGIN}/api/keepsakes/globalconfig`)
		expect(res.status).toBe(200)
		expect(await res.json()).toMatchObject({ KeepsakeFeatureEnabled: true })
	})

	test('GET /api/keepsakes/rooms/:id returns 204; categories returns []', async () => {
		const room = await exports.default.fetch(`${ORIGIN}/api/keepsakes/rooms/1`)
		expect(room.status).toBe(204)
		const cats = await exports.default.fetch(`${ORIGIN}/api/keepsakes/categories`)
		expect(cats.status).toBe(200)
		expect(await cats.json()).toEqual([])
	})

	test('GET /voice/config returns an object', async () => {
		const res = await exports.default.fetch(`${ORIGIN}/voice/config`)
		expect(res.status).toBe(200)
		expect(await res.json()).toEqual({})
	})

	test('GET /api/inventions/v2/mine 401s without a bearer token', async () => {
		const res = await exports.default.fetch(`${ORIGIN}/api/inventions/v2/mine`)
		expect(res.status).toBe(401)
	})

	test('GET /api/inventions/v2/mine returns [] for a player with none', async () => {
		const res = await exports.default.fetch(`${ORIGIN}/api/inventions/v2/mine`, {
			headers: await bearer('7777'),
		})
		expect(res.status).toBe(200)
		expect(await res.json()).toEqual([])
	})

	test('POST /api/inventions/v6/save persists the invention and lists it in mine', async () => {
		const body = {
			name: '071126 13:10:50',
			description: 'No description yet',
			imageName: '2026-07-11/0ff3d5f9-e544-422d-84a0-dec46195a82b.jpg',
			instantiationCost: 103,
			lightsCost: 0,
			chipsCost: 0,
			cloudVariablesCost: 0,
			aiCost: 0,
			creationRoomId: 73,
			inventionDataFilename: '2026-07-11/cc15a7fa-2e81-4da0-b8f1-2a4dcd8ae1a3',
			referencedInventions: [],
			creatorAccountRole: 255,
		}
		const res = await exports.default.fetch(`${ORIGIN}/api/inventions/v6/save`, {
			method: 'POST',
			headers: { ...(await bearer('5150')), 'Content-Type': 'application/json' },
			body: JSON.stringify(body),
		})
		expect(res.status).toBe(200)
		// Save answers with the `{ Status, Invention, InventionVersion }` envelope —
		// the version sits alongside the invention, not only nested inside it.
		const result = (await res.json()) as InventionSaveResult
		expect(result.Status).toBe(0)
		const saved = result.Invention
		expect(saved.InventionId).toBeGreaterThan(0)
		expect(saved.CreatorPlayerId).toBe(5150)
		expect(saved.Name).toBe(body.name)
		expect(saved.Description).toBe(body.description)
		expect(saved.ImageName).toBe(body.imageName)
		// Costs + the data blob live on the version. The blob name always carries the
		// `.inv` extension the client expects, whether or not the client sent it.
		expect(result.InventionVersion).toMatchObject({
			InventionId: saved.InventionId,
			VersionNumber: 1,
			InstantiationCost: 103,
			LightsCost: 0,
			BlobName: `${body.inventionDataFilename}.inv`,
		})
		expect(saved.CurrentVersion.BlobName).toBe(`${body.inventionDataFilename}.inv`)

		// An extension the client already supplied isn't doubled up.
		const withExt = await exports.default.fetch(`${ORIGIN}/api/inventions/v6/save`, {
			method: 'POST',
			headers: { ...(await bearer('5150')), 'Content-Type': 'application/json' },
			body: JSON.stringify({ name: 'Already .inv', inventionDataFilename: '2026-07-12/x.inv' }),
		})
		expect(((await withExt.json()) as InventionSaveResult).InventionVersion.BlobName).toBe(
			'2026-07-12/x.inv'
		)
		expect(saved.CreationRoomId).toBe(73)
		// Fully permissioned from the start (the client's creatorAccountRole is a room
		// role, not an invention permission, so it's ignored); publishing is what
		// narrows GeneralPermission down.
		expect(saved.CreatorPermission).toBe(100)
		expect(saved.GeneralPermission).toBe(100)
		expect(saved.AllowTrial).toBe(true)
		// Freshly saved → private/unpublished until the player publishes it.
		expect(saved.IsPublished).toBe(false)
		expect(saved.FirstPublishedAt).toBeNull()
		expect(typeof saved.CreatedAt).toBe('string')

		const mine = await exports.default.fetch(`${ORIGIN}/api/inventions/v2/mine`, {
			headers: await bearer('5150'),
		})
		expect(mine.status).toBe(200)
		const list = (await mine.json()) as SavedInvention[]
		expect(list.map((i) => i.InventionId)).toContain(saved.InventionId)

		// The saved invention is fetchable by id via the v1 lookup.
		const one = await exports.default.fetch(
			`${ORIGIN}/api/inventions/v1?inventionId=${saved.InventionId}`
		)
		expect(one.status).toBe(200)
		expect((await one.json()) as SavedInvention).toMatchObject({ InventionId: saved.InventionId })
	})

	test('POST /api/inventions/v6/save 401s without a bearer token', async () => {
		const res = await exports.default.fetch(`${ORIGIN}/api/inventions/v6/save`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ name: 'x', inventionDataFilename: 'a.inv' }),
		})
		expect(res.status).toBe(401)
	})

	test('POST /api/inventions/v6/save 400s without the invention data blob', async () => {
		const res = await exports.default.fetch(`${ORIGIN}/api/inventions/v6/save`, {
			method: 'POST',
			headers: { ...(await bearer()), 'Content-Type': 'application/json' },
			body: JSON.stringify({ name: 'no blob' }),
		})
		expect(res.status).toBe(400)
	})

	test('POST /api/inventions/v6/save defaults a missing name and description', async () => {
		const res = await exports.default.fetch(`${ORIGIN}/api/inventions/v6/save`, {
			method: 'POST',
			headers: { ...(await bearer('6161')), 'Content-Type': 'application/json' },
			body: JSON.stringify({ inventionDataFilename: 'a.inv', name: '  ' }),
		})
		expect(res.status).toBe(200)
		expect(((await res.json()) as InventionSaveResult).Invention).toMatchObject({
			Name: 'Untitled',
			Description: 'No description yet',
		})
	})

	test('GET /api/inventions/v1 404s for an unknown invention', async () => {
		const res = await exports.default.fetch(`${ORIGIN}/api/inventions/v1?inventionId=999999`)
		expect(res.status).toBe(404)
	})

	test('GET /api/inventions/v1/details returns the tag list; 404s on an unknown id', async () => {
		const save = await exports.default.fetch(`${ORIGIN}/api/inventions/v6/save`, {
			method: 'POST',
			headers: { ...(await bearer('6060')), 'Content-Type': 'application/json' },
			body: JSON.stringify({ name: 'Tagless Sofabed', inventionDataFilename: 'a.inv' }),
		})
		const { Invention } = (await save.json()) as InventionSaveResult

		// A freshly saved invention is untagged until settags writes to it.
		const res = await exports.default.fetch(
			`${ORIGIN}/api/inventions/v1/details?inventionId=${Invention.InventionId}`
		)
		expect(res.status).toBe(200)
		expect(await res.json()).toEqual({ Tags: [] })

		// Tags stored on the record are echoed back under `Tags`.
		const tagged = { ...Invention, InventionId: 5150, Tags: [{ Tag: 'medium', Type: 1 }] }
		await env.DB.prepare('INSERT INTO invention (data) VALUES (?1)')
			.bind(JSON.stringify(tagged))
			.run()
		const withTags = await exports.default.fetch(
			`${ORIGIN}/api/inventions/v1/details?inventionId=5150`
		)
		expect(await withTags.json()).toEqual({ Tags: [{ Tag: 'medium', Type: 1 }] })

		const unknown = await exports.default.fetch(
			`${ORIGIN}/api/inventions/v1/details?inventionId=999999`
		)
		expect(unknown.status).toBe(404)
	})

	test('POST /api/inventions/v1/settags tags the invention; details serves them back', async () => {
		const save = await exports.default.fetch(`${ORIGIN}/api/inventions/v6/save`, {
			method: 'POST',
			headers: { ...(await bearer('4242')), 'Content-Type': 'application/json' },
			body: JSON.stringify({ name: 'Sofabed', inventionDataFilename: 'a.inv' }),
		})
		const { Invention } = (await save.json()) as InventionSaveResult
		const settags = async (body: unknown, sub = '4242'): Promise<Response> =>
			exports.default.fetch(`${ORIGIN}/api/inventions/v1/settags`, {
				method: 'POST',
				headers: { ...(await bearer(sub)), 'Content-Type': 'application/json' },
				body: JSON.stringify(body),
			})

		// Custom tags are Type 0, auto tags Type 2.
		const res = await settags({
			InventionId: Invention.InventionId,
			AutoTags: ['lowink'],
			CustomTags: ['blah'],
		})
		expect(res.status).toBe(200)
		// settags answers the flat list of tag *names*, auto first, then custom.
		expect(await res.json()).toEqual({ Result: 0, Tags: ['lowink', 'blah'] })

		// details serves the typed objects: custom is Type 0, auto is Type 2.
		const details = await exports.default.fetch(
			`${ORIGIN}/api/inventions/v1/details?inventionId=${Invention.InventionId}`
		)
		expect(await details.json()).toEqual({
			Tags: [
				{ Tag: 'lowink', Type: 2 },
				{ Tag: 'blah', Type: 0 },
			],
		})

		// Both lists are replaced wholesale, and tags are normalized + de-duplicated.
		const replaced = await settags({
			InventionId: Invention.InventionId,
			AutoTags: [],
			CustomTags: ['Modern', ' modern ', 'Bed'],
		})
		expect(await replaced.json()).toEqual({ Result: 0, Tags: ['modern', 'bed'] })

		// Only the creator may retag; unknown inventions 404; no token → 401.
		const notMine = await settags({ InventionId: Invention.InventionId, CustomTags: ['x'] }, '9999')
		expect(notMine.status).toBe(403)

		const unknown = await settags({ InventionId: 999999, CustomTags: ['x'] })
		expect(unknown.status).toBe(404)

		const anon = await exports.default.fetch(`${ORIGIN}/api/inventions/v1/settags`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ InventionId: Invention.InventionId, CustomTags: ['x'] }),
		})
		expect(anon.status).toBe(401)
	})

	test('GET /api/inventions/v2/search returns published inventions, filtered by value', async () => {
		// Only published inventions are searchable, and nothing published exists via
		// the save path (a fresh save is private), so seed the rows directly.
		const published = (id: number, name: string, description: string): SavedInvention =>
			({
				InventionId: id,
				ReplicationId: crypto.randomUUID(),
				CreatorPlayerId: 8080,
				Name: name,
				Description: description,
				ImageName: '',
				CurrentVersionNumber: 1,
				CurrentVersion: { InventionId: id, VersionNumber: 1, BlobName: '' },
				IsPublished: true,
				HideFromPlayer: false,
				CreatedAt: `2026-07-0${id}T00:00:00Z`,
			}) as unknown as SavedInvention

		for (const inv of [
			published(101, 'Modern Sofabed', 'Stylistic modern bed'),
			published(102, 'Racing Game', 'A retro inspired TV gaming set'),
			// Unpublished + hidden rows must stay out of the results.
			{ ...published(103, 'Secret Sofabed', ''), IsPublished: false },
			{ ...published(104, 'Hidden Sofabed', ''), HideFromPlayer: true },
		]) {
			await env.DB.prepare('INSERT INTO invention (data) VALUES (?1)')
				.bind(JSON.stringify(inv))
				.run()
		}

		// No `value` → browse everything published, newest first.
		const all = await exports.default.fetch(`${ORIGIN}/api/inventions/v2/search?skip=0&take=100`)
		expect(all.status).toBe(200)
		expect(((await all.json()) as SavedInvention[]).map((i) => i.InventionId)).toEqual([102, 101])

		// `value` matches name or description, case-insensitively.
		const hit = await exports.default.fetch(
			`${ORIGIN}/api/inventions/v2/search?value=${encodeURIComponent('modern sofabed')}`
		)
		expect(((await hit.json()) as SavedInvention[]).map((i) => i.InventionId)).toEqual([101])

		// skip/take paginate the published set.
		const page = await exports.default.fetch(`${ORIGIN}/api/inventions/v2/search?skip=1&take=1`)
		expect(((await page.json()) as SavedInvention[]).map((i) => i.InventionId)).toEqual([101])

		const miss = await exports.default.fetch(`${ORIGIN}/api/inventions/v2/search?value=nomatch`)
		expect(await miss.json()).toEqual([])
	})

	test('GET /api/inventions/v1/tagfilters ranks the tags in use', async () => {
		// Two published inventions tagged `furniture`, one `bed` — plus a tagged draft,
		// whose tags must not leak into the public filter chips.
		const make = async (name: string, tags: string[], publish: boolean): Promise<void> => {
			const save = await exports.default.fetch(`${ORIGIN}/api/inventions/v6/save`, {
				method: 'POST',
				headers: { ...(await bearer('9090')), 'Content-Type': 'application/json' },
				body: JSON.stringify({ name, inventionDataFilename: 'a.inv' }),
			})
			const { Invention } = (await save.json()) as InventionSaveResult
			await exports.default.fetch(`${ORIGIN}/api/inventions/v1/settags`, {
				method: 'POST',
				headers: { ...(await bearer('9090')), 'Content-Type': 'application/json' },
				body: JSON.stringify({ InventionId: Invention.InventionId, CustomTags: tags }),
			})
			if (publish) {
				await exports.default.fetch(
					`${ORIGIN}/api/inventions/v3/publish?inventionId=${Invention.InventionId}`,
					{ headers: await bearer('9090') }
				)
			}
		}
		await make('Filter Sofa', ['furniture', 'bed'], true)
		await make('Filter Chair', ['furniture'], true)
		await make('Filter Draft', ['secrettag'], false)

		const res = await exports.default.fetch(`${ORIGIN}/api/inventions/v1/tagfilters`)
		expect(res.status).toBe(200)
		const filters = (await res.json()) as {
			PinnedFilters: string[]
			PopularFilters: string[]
			TrendingFilters: null
		}
		// Most-used tag first, and the draft's tag is nowhere to be seen.
		expect(filters.PopularFilters.slice(0, 2)).toEqual(['furniture', 'bed'])
		expect(filters.PopularFilters).not.toContain('secrettag')
		expect(filters.PinnedFilters).toEqual(filters.PopularFilters.slice(0, 5))
		expect(filters.TrendingFilters).toBeNull()
	})

	test('GET /api/inventions/v2/batch returns the requested inventions', async () => {
		const save = async (name: string): Promise<SavedInvention> => {
			const res = await exports.default.fetch(`${ORIGIN}/api/inventions/v6/save`, {
				method: 'POST',
				headers: { ...(await bearer('5566')), 'Content-Type': 'application/json' },
				body: JSON.stringify({ name, inventionDataFilename: 'a.inv' }),
			})
			return ((await res.json()) as InventionSaveResult).Invention
		}
		const batch = async (query: string, sub?: string): Promise<SavedInvention[]> => {
			const res = await exports.default.fetch(`${ORIGIN}/api/inventions/v2/batch?${query}`, {
				headers: sub === undefined ? {} : await bearer(sub),
			})
			expect(res.status).toBe(200)
			return (await res.json()) as SavedInvention[]
		}

		const first = await save('Batch One')
		const draft = await save('Batch Draft')
		await exports.default.fetch(
			`${ORIGIN}/api/inventions/v3/publish?inventionId=${first.InventionId}`,
			{
				headers: await bearer('5566'),
			}
		)

		// Repeated ids and comma-separated ids both work, and order is preserved.
		const ids = await batch(`id=${first.InventionId}&id=${first.InventionId}`)
		expect(ids.map((i) => i.InventionId)).toEqual([first.InventionId, first.InventionId])
		const commaSeparated = await batch(`id=${first.InventionId},999999`)
		expect(commaSeparated.map((i) => i.InventionId)).toEqual([first.InventionId])

		// The draft is hidden from everyone but its creator.
		expect((await batch(`id=${draft.InventionId}`)).map((i) => i.InventionId)).toEqual([])
		expect((await batch(`id=${draft.InventionId}`, '9999')).map((i) => i.InventionId)).toEqual([])
		expect((await batch(`id=${draft.InventionId}`, '5566')).map((i) => i.InventionId)).toEqual([
			draft.InventionId,
		])

		// No ids at all → an empty list, not an error.
		expect(await batch('')).toEqual([])
	})

	test('GET /api/inventions/v1/room lists a room’s published inventions', async () => {
		// Two inventions created in room 76, one of them still a draft.
		const create = async (name: string, room: number): Promise<SavedInvention> => {
			const res = await exports.default.fetch(`${ORIGIN}/api/inventions/v6/save`, {
				method: 'POST',
				headers: { ...(await bearer('8484')), 'Content-Type': 'application/json' },
				body: JSON.stringify({ name, creationRoomId: room, inventionDataFilename: 'a.inv' }),
			})
			return ((await res.json()) as InventionSaveResult).Invention
		}
		const publish = async (id: number): Promise<void> => {
			await exports.default.fetch(`${ORIGIN}/api/inventions/v3/publish?inventionId=${id}`, {
				headers: await bearer('8484'),
			})
		}

		const inRoom = await create('Room Lamp', 76)
		const draft = await create('Draft Lamp In Room', 76)
		const otherRoom = await create('Other Room Lamp', 77)
		await publish(inRoom.InventionId)
		await publish(otherRoom.InventionId)

		const res = await exports.default.fetch(`${ORIGIN}/api/inventions/v1/room?id=76`)
		expect(res.status).toBe(200)
		const ids = ((await res.json()) as SavedInvention[]).map((i) => i.InventionId)
		expect(ids).toEqual([inRoom.InventionId])
		// The unpublished one and the other room's are both excluded.
		expect(ids).not.toContain(draft.InventionId)
		expect(ids).not.toContain(otherRoom.InventionId)

		// A room with no inventions is an empty list, not a 404.
		const empty = await exports.default.fetch(`${ORIGIN}/api/inventions/v1/room?id=999`)
		expect(await empty.json()).toEqual([])

		const noId = await exports.default.fetch(`${ORIGIN}/api/inventions/v1/room`)
		expect(noId.status).toBe(400)
	})

	test('GET /api/inventions/v1/personaldetails/:id reports the cheer flag', async () => {
		// No cheer storage yet, so nobody is ever cheering — signed in or not.
		const res = await exports.default.fetch(`${ORIGIN}/api/inventions/v1/personaldetails/2`, {
			headers: await bearer('42'),
		})
		expect(res.status).toBe(200)
		expect(await res.json()).toEqual({ IsCheering: false })

		const anon = await exports.default.fetch(`${ORIGIN}/api/inventions/v1/personaldetails/2`)
		expect(anon.status).toBe(200)
		expect(await anon.json()).toEqual({ IsCheering: false })
	})

	test('GET /api/inventions/v1/version serves the version; unknown versions 404', async () => {
		const save = await exports.default.fetch(`${ORIGIN}/api/inventions/v6/save`, {
			method: 'POST',
			headers: { ...(await bearer('7373')), 'Content-Type': 'application/json' },
			body: JSON.stringify({
				name: 'Versioned Lamp',
				instantiationCost: 42,
				inventionDataFilename: '2026-07-12/lamp.inv',
			}),
		})
		const { Invention } = (await save.json()) as InventionSaveResult

		// The bare RRInventionVersion — the blob name is what the client downloads.
		const res = await exports.default.fetch(
			`${ORIGIN}/api/inventions/v1/version?inventionId=${Invention.InventionId}&version=1`
		)
		expect(res.status).toBe(200)
		expect(await res.json()).toMatchObject({
			InventionId: Invention.InventionId,
			VersionNumber: 1,
			BlobName: '2026-07-12/lamp.inv',
			InstantiationCost: 42,
		})

		// Only the current version exists; anything else 404s, as does an unknown id.
		const v2 = await exports.default.fetch(
			`${ORIGIN}/api/inventions/v1/version?inventionId=${Invention.InventionId}&version=2`
		)
		expect(v2.status).toBe(404)
		const unknown = await exports.default.fetch(
			`${ORIGIN}/api/inventions/v1/version?inventionId=999999&version=1`
		)
		expect(unknown.status).toBe(404)

		// Both params are required.
		const noVersion = await exports.default.fetch(
			`${ORIGIN}/api/inventions/v1/version?inventionId=${Invention.InventionId}`
		)
		expect(noVersion.status).toBe(400)
		const noId = await exports.default.fetch(`${ORIGIN}/api/inventions/v1/version?version=1`)
		expect(noId.status).toBe(400)
	})

	test('GET /api/inventions/v1/update edits metadata + permission, creator only', async () => {
		const save = await exports.default.fetch(`${ORIGIN}/api/inventions/v6/save`, {
			method: 'POST',
			headers: { ...(await bearer('3131')), 'Content-Type': 'application/json' },
			body: JSON.stringify({
				name: 'Draft Lamp',
				description: 'No description yet',
				inventionDataFilename: 'a.inv',
			}),
		})
		const { Invention } = (await save.json()) as InventionSaveResult
		const update = async (query: string, sub = '3131'): Promise<Response> =>
			exports.default.fetch(
				`${ORIGIN}/api/inventions/v1/update?inventionId=${Invention.InventionId}&${query}`,
				{ headers: await bearer(sub) }
			)

		// Update answers the save envelope. Only the params present change — the name
		// is left alone here.
		const res = await update(`description=${encodeURIComponent('my description')}`)
		expect(res.status).toBe(200)
		const edited = (await res.json()) as InventionSaveResult
		expect(edited.Status).toBe(0)
		expect(edited.InventionVersion.InventionId).toBe(Invention.InventionId)
		expect(edited.Invention).toMatchObject({
			InventionId: Invention.InventionId,
			Description: 'my description',
			Name: 'Draft Lamp',
			IsPublished: false,
		})

		// `permission` takes a name or the raw number, and lands on GeneralPermission.
		const byName = (await (await update('permission=edit_and_save')).json()) as InventionSaveResult
		expect(byName.Invention.GeneralPermission).toBe(40)
		const byNumber = (await (await update('permission=80')).json()) as InventionSaveResult
		expect(byNumber.Invention.GeneralPermission).toBe(80)

		// An empty description clears it; an empty name does *not* blank the invention.
		const cleared = (await (await update('description=&name=')).json()) as InventionSaveResult
		expect(cleared.Invention).toMatchObject({ Description: '', Name: 'Draft Lamp' })

		// allowTrial takes true/1.
		const trial = (await (await update('allowTrial=true')).json()) as InventionSaveResult
		expect(trial.Invention.AllowTrial).toBe(true)

		// Update does not publish or price — those are v3/publish and v1/updateprice.
		expect(trial.Invention.IsPublished).toBe(false)

		// Only the creator may edit; unknown inventions 404; no token → 401.
		expect((await update('description=nope', '9999')).status).toBe(403)
		const unknown = await exports.default.fetch(
			`${ORIGIN}/api/inventions/v1/update?inventionId=999999&description=x`,
			{ headers: await bearer('3131') }
		)
		expect(unknown.status).toBe(404)
		const anon = await exports.default.fetch(
			`${ORIGIN}/api/inventions/v1/update?inventionId=${Invention.InventionId}&description=x`
		)
		expect(anon.status).toBe(401)
	})

	test('GET /api/inventions/v3/publish publishes + prices; search then lists it', async () => {
		const save = await exports.default.fetch(`${ORIGIN}/api/inventions/v6/save`, {
			method: 'POST',
			headers: { ...(await bearer('2121')), 'Content-Type': 'application/json' },
			body: JSON.stringify({ name: 'Publishable Lamp', inventionDataFilename: 'a.inv' }),
		})
		const { Invention } = (await save.json()) as InventionSaveResult
		const search = async (): Promise<number[]> => {
			const res = await exports.default.fetch(
				`${ORIGIN}/api/inventions/v2/search?value=${encodeURIComponent('Publishable Lamp')}`
			)
			return ((await res.json()) as SavedInvention[]).map((i) => i.InventionId)
		}

		// A saved draft is invisible until it's published.
		expect(await search()).toEqual([])

		const res = await exports.default.fetch(
			`${ORIGIN}/api/inventions/v3/publish?inventionId=${Invention.InventionId}&permissionLevel=charge&price=250`,
			{ headers: await bearer('2121') }
		)
		expect(res.status).toBe(200)
		const published = (await res.json()) as InventionSaveResult
		expect(published.Status).toBe(0)
		expect(published.Invention).toMatchObject({
			IsPublished: true,
			GeneralPermission: 80, // charge
			Price: 250,
		})
		expect(typeof published.Invention.FirstPublishedAt).toBe('string')

		expect(await search()).toEqual([Invention.InventionId])

		// Publishing with no permissionLevel defaults to UseOnly, and price to 0.
		const other = await exports.default.fetch(`${ORIGIN}/api/inventions/v6/save`, {
			method: 'POST',
			headers: { ...(await bearer('2121')), 'Content-Type': 'application/json' },
			body: JSON.stringify({ name: 'Plain Lamp', inventionDataFilename: 'a.inv' }),
		})
		const plain = ((await other.json()) as InventionSaveResult).Invention
		const defaulted = (await (
			await exports.default.fetch(
				`${ORIGIN}/api/inventions/v3/publish?inventionId=${plain.InventionId}`,
				{ headers: await bearer('2121') }
			)
		).json()) as InventionSaveResult
		expect(defaulted.Invention).toMatchObject({
			IsPublished: true,
			GeneralPermission: 20, // useonly
			Price: 0,
		})

		// Creator-gated like the other writes.
		const notMine = await exports.default.fetch(
			`${ORIGIN}/api/inventions/v3/publish?inventionId=${Invention.InventionId}`,
			{ headers: await bearer('9999') }
		)
		expect(notMine.status).toBe(403)
	})

	test('POST /api/inventions/v1/updateprice sets the price, creator only', async () => {
		const save = await exports.default.fetch(`${ORIGIN}/api/inventions/v6/save`, {
			method: 'POST',
			headers: { ...(await bearer('1212')), 'Content-Type': 'application/json' },
			body: JSON.stringify({ name: 'Priced Lamp', inventionDataFilename: 'a.inv' }),
		})
		const { Invention } = (await save.json()) as InventionSaveResult
		const updateprice = async (body: unknown, sub = '1212'): Promise<Response> =>
			exports.default.fetch(`${ORIGIN}/api/inventions/v1/updateprice`, {
				method: 'POST',
				headers: { ...(await bearer(sub)), 'Content-Type': 'application/json' },
				body: JSON.stringify(body),
			})

		const res = await updateprice({ InventionId: Invention.InventionId, Price: 500 })
		expect(res.status).toBe(200)
		const priced = (await res.json()) as InventionSaveResult
		expect(priced.Status).toBe(0)
		expect(priced.Invention.Price).toBe(500)

		// A negative price is rejected; other players can't reprice someone's invention.
		expect((await updateprice({ InventionId: Invention.InventionId, Price: -1 })).status).toBe(400)
		expect(
			(await updateprice({ InventionId: Invention.InventionId, Price: 10 }, '9999')).status
		).toBe(403)
	})

	test('GET /api/inventions/v1/toptoday + v1/featured serve the invention feeds', async () => {
		const ids = async (res: Response): Promise<number[]> =>
			((await res.json()) as SavedInvention[]).map((i) => i.InventionId)

		// Nothing is flagged IsFeatured yet → featured falls back to the top feed.
		const beforeTop = await ids(await exports.default.fetch(`${ORIGIN}/api/inventions/v1/toptoday`))
		const beforeFeatured = await ids(
			await exports.default.fetch(`${ORIGIN}/api/inventions/v1/featured`)
		)
		expect(beforeFeatured).toEqual(beforeTop)

		const feedInvention = (
			id: number,
			downloads: number,
			extra: Partial<SavedInvention> = {}
		): SavedInvention =>
			({
				InventionId: id,
				CreatorPlayerId: 8080,
				Name: `Feed ${id}`,
				Description: '',
				ImageName: '',
				CurrentVersionNumber: 1,
				CurrentVersion: { InventionId: id, VersionNumber: 1, BlobName: '' },
				IsPublished: true,
				IsFeatured: false,
				HideFromPlayer: false,
				NumDownloads: downloads,
				CheerCount: 0,
				NumPlayersHaveUsedInRoom: 0,
				CreatedAt: '2026-07-01T00:00:00Z',
				...extra,
			}) as unknown as SavedInvention

		for (const inv of [
			feedInvention(201, 500),
			feedInvention(202, 9000, { IsFeatured: true, CreatedAt: '2026-07-02T00:00:00Z' }),
			feedInvention(203, 3000, { IsFeatured: true, CreatedAt: '2026-07-03T00:00:00Z' }),
			// Unpublished/hidden inventions stay out of both feeds, featured or not.
			feedInvention(204, 99999, { IsPublished: false, IsFeatured: true }),
			feedInvention(205, 99999, { HideFromPlayer: true, IsFeatured: true }),
		]) {
			await env.DB.prepare('INSERT INTO invention (data) VALUES (?1)')
				.bind(JSON.stringify(inv))
				.run()
		}

		// Top: engagement-ranked, so the biggest download counts lead.
		const top = await ids(await exports.default.fetch(`${ORIGIN}/api/inventions/v1/toptoday`))
		expect(top.slice(0, 3)).toEqual([202, 203, 201])
		expect(top).not.toContain(204)
		expect(top).not.toContain(205)

		// Featured: only the flagged, visible inventions — newest first.
		const featured = await ids(await exports.default.fetch(`${ORIGIN}/api/inventions/v1/featured`))
		expect(featured).toEqual([203, 202])

		// skip/take paginate the top feed.
		const page = await exports.default.fetch(`${ORIGIN}/api/inventions/v1/toptoday?skip=1&take=1`)
		expect(await ids(page)).toEqual([203])
	})

	test('POST /api/sanitize/v1 echoes the value; isPure reports true', async () => {
		const san = await exports.default.fetch(`${ORIGIN}/api/sanitize/v1`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ Value: 'hello world' }),
		})
		expect(san.status).toBe(200)
		expect(await san.json()).toBe('hello world')

		const pure = await exports.default.fetch(`${ORIGIN}/api/sanitize/v1/isPure`, { method: 'POST' })
		expect(pure.status).toBe(200)
		expect(await pure.json()).toEqual({ IsPure: true })
	})
})

describe('auth-gated endpoints', () => {
	test('401 without a bearer token', async () => {
		const res = await exports.default.fetch(`${ORIGIN}/api/consumables/v2/getUnlocked`)
		expect(res.status).toBe(401)
	})

	test('401 with a garbage token', async () => {
		const res = await exports.default.fetch(`${ORIGIN}/api/consumables/v2/getUnlocked`, {
			headers: { Authorization: 'Bearer not-a-real-token' },
		})
		expect(res.status).toBe(401)
	})
})

describe('rooms', () => {
	test('POST /api/rooms/v1/verifyRole checks creator + room roles', async () => {
		const verify = async (fields: Record<string, string>, sub?: string): Promise<boolean> => {
			const res = await exports.default.fetch(`${ORIGIN}/api/rooms/v1/verifyRole`, {
				method: 'POST',
				headers: {
					'Content-Type': 'application/x-www-form-urlencoded',
					...(sub ? await bearer(sub) : {}),
				},
				body: new URLSearchParams(fields).toString(),
			})
			expect(res.status).toBe(200)
			return (await res.json()) as boolean
		}

		// No token → false.
		expect(await verify({ roomId: '2', role: '255' })).toBe(false)
		// Creator (account 1 owns room 2) → true regardless of role.
		expect(await verify({ roomId: '2', role: '255', context: 'MakerPen' }, '1')).toBe(true)
		// Non-creator with no role in the room → false.
		expect(await verify({ roomId: '2', role: '30' }, '42')).toBe(false)
		// Account 42 holds Role 30 in room 3 → passes when requesting ≤ 30…
		expect(await verify({ roomId: '3', role: '30' }, '42')).toBe(true)
		// …but not a higher role.
		expect(await verify({ roomId: '3', role: '255' }, '42')).toBe(false)
		// Unknown room → false.
		expect(await verify({ roomId: '99999', role: '0' }, '42')).toBe(false)
	})
})

describe('images', () => {
	test('POST /api/images/v4/uploadsaved stores the file in R2 and returns its name', async () => {
		const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4])
		const fd = new FormData()
		fd.append('imgMeta', JSON.stringify({ savedImageType: 1 })) // ShareCamera
		fd.append('image', new File([bytes], 'avatar.png', { type: 'image/png' }))

		const res = await exports.default.fetch(`${ORIGIN}/api/images/v4/uploadsaved`, {
			method: 'POST',
			headers: await bearer(),
			body: fd,
		})
		expect(res.status).toBe(200)
		const { ImageName } = (await res.json()) as { ImageName: string }
		// Keyed by <type>/<date>/<uuid>.<ext> (the type folder mirrors the CDN layout).
		expect(ImageName).toMatch(
			/^sharecamera\/\d{4}-\d{2}-\d{2}\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.png$/
		)

		// The object is in the shared bucket under that key.
		const stored = await env.IMAGES.get(ImageName)
		expect(stored).not.toBeNull()
		expect(new Uint8Array(await stored!.arrayBuffer())).toEqual(bytes)

		// A metadata row was created, and it's readable by name via /api/images/v6.
		const meta = (await (
			await exports.default.fetch(`${ORIGIN}/api/images/v6?name=${ImageName}`)
		).json()) as { ImageName: string; PlayerId: number; Id: number; CheerCount: number }
		expect(meta.ImageName).toBe(ImageName)
		expect(meta.PlayerId).toBe(42)
		expect(typeof meta.Id).toBe('number')
		expect(meta.CheerCount).toBe(0)
	})

	test('GET /api/images/v1/slideshow is public and joins username + room name', async () => {
		// Seed a public image (Accessibility 1) taken in RecCenter (room 2) by account 42.
		await env.DB.prepare('INSERT INTO image (data) VALUES (?1)')
			.bind(
				JSON.stringify({
					Id: 9001,
					Type: 1,
					Accessibility: 1,
					AccessibilityLocked: false,
					ImageName: 'slide9001.jpg',
					Description: null,
					PlayerId: 42,
					TaggedPlayerIds: [7, 8],
					RoomId: 2,
					PlayerEventId: null,
					CreatedAt: new Date().toISOString(),
					CheerCount: 0,
					CommentCount: 0,
				})
			)
			.run()

		// No token — the slideshow is public.
		const res = await exports.default.fetch(`${ORIGIN}/api/images/v1/slideshow`)
		expect(res.status).toBe(200)
		const body = (await res.json()) as {
			Images: Array<Record<string, unknown>>
			ValidTill: string
		}
		expect(body.ValidTill).toMatch(/Z$/)
		const slide = body.Images.find((i) => i.SavedImageId === 9001)
		expect(slide).toMatchObject({
			SavedImageId: 9001,
			ImageName: 'slide9001.jpg',
			Username: 'Tester', // account 42 seeded above
			RoomName: 'RecCenter', // room 2
			RoomId: 2,
			SavedImageType: 1,
			Accessibility: 1,
			PlayerIds: [7, 8],
		})
	})

	test('POST /api/images/v1/cheer persists, syncs CheerCount, and the bulk lookup reflects it', async () => {
		// Seed an image to cheer.
		// Its own player id: 700's photos are asserted on exactly in the player-list test.
		const img = await createImage(env.DB, { imageName: 'cheerme.jpg', playerId: 7001 })
		const cheerBody = JSON.stringify({ SavedImageId: img.Id, Cheer: true })

		// No token → 401.
		expect(
			(
				await exports.default.fetch(`${ORIGIN}/api/images/v1/cheer`, {
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					body: cheerBody,
				})
			).status
		).toBe(401)

		const cheer = async (cheerVal: boolean, sub = '42') =>
			exports.default.fetch(`${ORIGIN}/api/images/v1/cheer`, {
				method: 'POST',
				headers: { ...(await bearer(sub)), 'Content-Type': 'application/json' },
				body: JSON.stringify({ SavedImageId: img.Id, Cheer: cheerVal }),
			})
		const cheerCount = async (): Promise<number> => {
			const row = await env.DB.prepare('SELECT data FROM image WHERE id = ?1')
				.bind(img.Id)
				.first<{ data: string }>()
			return (JSON.parse(row!.data) as { CheerCount: number }).CheerCount
		}

		// Account 42 cheers → CheerCount syncs to 1 (a real integer, not 1.0).
		expect((await cheer(true)).status).toBe(200)
		const rawAfter = await env.DB.prepare('SELECT data FROM image WHERE id = ?1')
			.bind(img.Id)
			.first<{ data: string }>()
		expect(rawAfter!.data).toContain('"CheerCount":1')
		expect(rawAfter!.data).not.toContain('"CheerCount":1.0')
		expect(await cheerCount()).toBe(1)

		// Re-cheering is idempotent on the count.
		await cheer(true)
		expect(await cheerCount()).toBe(1)

		// Un-cheer → count back to 0.
		await cheer(false)
		expect(await cheerCount()).toBe(0)
	})

	test('GET /api/images/v5/cheered/bulk reports per-id cheer state for the caller (auth-gated)', async () => {
		const img = await createImage(env.DB, { imageName: 'bulkcheer.jpg', playerId: 701 })
		const other = 999999

		// No token → 401.
		expect(
			(await exports.default.fetch(`${ORIGIN}/api/images/v5/cheered/bulk?id=${img.Id}`)).status
		).toBe(401)

		const bulk = async (sub: string) =>
			(await (
				await exports.default.fetch(
					`${ORIGIN}/api/images/v5/cheered/bulk?id=${img.Id}&id=${other}`,
					{ headers: await bearer(sub) }
				)
			).json()) as Array<{ SavedImageId: number; IsCheered: boolean }>

		// Before cheering: one entry per requested id, in order, all false.
		expect(await bulk('42')).toEqual([
			{ SavedImageId: img.Id, IsCheered: false },
			{ SavedImageId: other, IsCheered: false },
		])

		// Account 42 cheers the image.
		await exports.default.fetch(`${ORIGIN}/api/images/v1/cheer`, {
			method: 'POST',
			headers: { ...(await bearer('42')), 'Content-Type': 'application/json' },
			body: JSON.stringify({ SavedImageId: img.Id, Cheer: true }),
		})

		// The cheerer sees it cheered; a different player does not.
		expect((await bulk('42')).find((x) => x.SavedImageId === img.Id)?.IsCheered).toBe(true)
		expect((await bulk('43')).find((x) => x.SavedImageId === img.Id)?.IsCheered).toBe(false)

		// No ids → empty array.
		const empty = await exports.default.fetch(`${ORIGIN}/api/images/v5/cheered/bulk`, {
			headers: await bearer('42'),
		})
		expect(await empty.json()).toEqual([])
	})

	test('GET /api/images/v6 400s without a name and 404s for an unknown one', async () => {
		expect((await exports.default.fetch(`${ORIGIN}/api/images/v6`)).status).toBe(400)
		expect(
			(await exports.default.fetch(`${ORIGIN}/api/images/v6?name=doesnotexist.jpg`)).status
		).toBe(404)
	})

	test('POST /api/images/v4/uploadsaved records metadata from imgMeta', async () => {
		const fd = new FormData()
		// The client's real imgMeta shape (tagged players are `playerIds`).
		fd.append(
			'imgMeta',
			JSON.stringify({
				playerIds: [5, 6],
				savedImageType: 1,
				roomId: 777,
				playerEventId: 0,
				accessibility: 2,
			})
		)
		fd.append('image', new File([new Uint8Array([1, 2, 3])], 'pic.png', { type: 'image/png' }))
		const res = await exports.default.fetch(`${ORIGIN}/api/images/v4/uploadsaved`, {
			method: 'POST',
			headers: await bearer('42'),
			body: fd,
		})
		const { ImageName } = (await res.json()) as { ImageName: string }

		const meta = (await (
			await exports.default.fetch(`${ORIGIN}/api/images/v6?name=${ImageName}`)
		).json()) as {
			Type: number
			RoomId: number
			Accessibility: number
			TaggedPlayerIds: number[]
			PlayerEventId: number | null
		}
		expect(meta.Type).toBe(1)
		expect(meta.RoomId).toBe(777)
		expect(meta.Accessibility).toBe(2)
		expect(meta.TaggedPlayerIds).toEqual([5, 6])
		// playerEventId 0 means "none" → stored as null.
		expect(meta.PlayerEventId).toBeNull()
	})

	test('POST /api/images/v4/uploadsaved records a profile thumbnail on the account', async () => {
		const bytes = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3])
		const fd = new FormData()
		// Type 4 = ProfileThumbnail. The client sends the file as image.dat.
		fd.append('imgMeta', JSON.stringify({ savedImageType: 4, roomId: -1 }))
		fd.append('image', new File([bytes], 'image.dat', { type: 'image/jpeg' }))

		const res = await exports.default.fetch(`${ORIGIN}/api/images/v4/uploadsaved`, {
			method: 'POST',
			headers: await bearer('42'),
			body: fd,
		})
		expect(res.status).toBe(200)
		const { ImageName } = (await res.json()) as { ImageName: string }
		// Type 4 → the `profile/` type folder, then <date>/<uuid>.<ext>.
		expect(ImageName).toMatch(
			/^profile\/\d{4}-\d{2}-\d{2}\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.jpg$/
		)

		// The account row now points its profileImage at the uploaded key.
		const row = await env.DB.prepare('SELECT data FROM account WHERE account_id = 42').first<{
			data: string
		}>()
		expect(JSON.parse(row!.data).profileImage).toBe(ImageName)
	})

	test('DELETE /api/images/v1/deletesaved removes the owner’s image (row + cheers + R2)', async () => {
		const ImageName = 'sharecamera/2026-07-17/delete-me.jpg'
		await env.IMAGES.put(ImageName, new Uint8Array([1, 2, 3]))
		await env.DB.prepare('INSERT INTO image (data) VALUES (?1)')
			.bind(
				JSON.stringify({
					Id: 8100,
					Type: 1,
					Accessibility: 1,
					AccessibilityLocked: false,
					ImageName,
					Description: null,
					PlayerId: 42, // owned by the default bearer account
					TaggedPlayerIds: [],
					RoomId: null,
					PlayerEventId: null,
					CreatedAt: new Date().toISOString(),
					CheerCount: 1,
					CommentCount: 0,
				})
			)
			.run()
		await env.DB.prepare(
			'INSERT INTO image_interaction (player_id, saved_image_id, cheered) VALUES (99, 8100, 1)'
		).run()

		const del = (headers: Record<string, string>) =>
			exports.default.fetch(`${ORIGIN}/api/images/v1/deletesaved`, {
				method: 'DELETE',
				headers: { 'Content-Type': 'application/json', ...headers },
				body: JSON.stringify({ ImageName }),
			})

		// No token → 401; a different account → 403 (still present afterwards).
		expect((await del({})).status).toBe(401)
		expect((await del(await bearer('43'))).status).toBe(403)
		expect(await getImageByName(env.DB, ImageName)).not.toBeNull()

		// Unknown image → 404.
		const unknown = await exports.default.fetch(`${ORIGIN}/api/images/v1/deletesaved`, {
			method: 'DELETE',
			headers: { 'Content-Type': 'application/json', ...(await bearer('42')) },
			body: JSON.stringify({ ImageName: 'sharecamera/nope.jpg' }),
		})
		expect(unknown.status).toBe(404)

		// Owner → 200, and the row, its cheers, and the R2 object are all gone.
		expect((await del(await bearer('42'))).status).toBe(200)
		expect(await getImageByName(env.DB, ImageName)).toBeNull()
		expect(await env.IMAGES.get(ImageName)).toBeNull()
		const cheers = await env.DB.prepare(
			'SELECT COUNT(*) AS n FROM image_interaction WHERE saved_image_id = 8100'
		).first<{ n: number }>()
		expect(cheers!.n).toBe(0)
	})

	test('POST /api/images/v4/uploadsaved 401s without a bearer token', async () => {
		const fd = new FormData()
		fd.append('image', new File([new Uint8Array([1, 2, 3])], 'avatar.png', { type: 'image/png' }))
		const res = await exports.default.fetch(`${ORIGIN}/api/images/v4/uploadsaved`, {
			method: 'POST',
			body: fd,
		})
		expect(res.status).toBe(401)
	})

	test('POST /api/images/v4/uploadsaved 400s without a file', async () => {
		const res = await exports.default.fetch(`${ORIGIN}/api/images/v4/uploadsaved`, {
			method: 'POST',
			headers: { ...(await bearer()), 'Content-Type': 'application/x-www-form-urlencoded' },
			body: 'foo=bar',
		})
		expect(res.status).toBe(400)
	})

	test('GET /api/images/v4/room/:id returns a public room feed, filtered/sorted/paginated', async () => {
		// Seed images in room 54: two public (one with more cheers, of different
		// types), one private (hidden), and one in another room (excluded).
		const seed = (img: Partial<SavedImage> & { Id: number }) =>
			env.DB.prepare('INSERT INTO image (data) VALUES (?1)').bind(
				JSON.stringify({
					Type: 1,
					Accessibility: 1,
					AccessibilityLocked: false,
					ImageName: `img${img.Id}.jpg`,
					Description: null,
					PlayerId: 42,
					TaggedPlayerIds: [],
					RoomId: 54,
					PlayerEventId: null,
					CreatedAt: '2026-01-01T00:00:00.000Z',
					CheerCount: 0,
					CommentCount: 0,
					...img,
				})
			)
		await env.DB.batch([
			seed({ Id: 101, CheerCount: 5, CreatedAt: '2026-02-01T00:00:00.000Z' }),
			seed({ Id: 102, CheerCount: 9, CreatedAt: '2026-01-15T00:00:00.000Z', Type: 3 }),
			seed({ Id: 103, Accessibility: 0 }), // private → hidden from the public feed
			seed({ Id: 104, RoomId: 99 }), // different room → excluded
		])

		// sort=1 → most cheered first (102 has 9, 101 has 5).
		const top = (await (
			await exports.default.fetch(`${ORIGIN}/api/images/v4/room/54?sort=1&filter=0&take=100&skip=0`)
		).json()) as SavedImage[]
		expect(top.map((i) => i.Id)).toEqual([102, 101])

		// sort=0 → newest first (101 is more recent than 102).
		const newest = (await (
			await exports.default.fetch(`${ORIGIN}/api/images/v4/room/54?sort=0`)
		).json()) as SavedImage[]
		expect(newest.map((i) => i.Id)).toEqual([101, 102])

		// filter=1 (ShareCamera) drops the Type-3 image (102).
		const filtered = (await (
			await exports.default.fetch(`${ORIGIN}/api/images/v4/room/54?filter=1`)
		).json()) as SavedImage[]
		expect(filtered.map((i) => i.Id)).toEqual([101])

		// take/skip paginate.
		const page = (await (
			await exports.default.fetch(`${ORIGIN}/api/images/v4/room/54?sort=1&take=1&skip=1`)
		).json()) as SavedImage[]
		expect(page.map((i) => i.Id)).toEqual([101])

		// A room with no images → empty array.
		expect(
			await (await exports.default.fetch(`${ORIGIN}/api/images/v4/room/12345`)).json()
		).toEqual([])
	})

	test('GET /api/images/v4/player/:id and v3/feed/player/:id return the player photos + feed', async () => {
		const seed = (img: Partial<SavedImage> & { Id: number }) =>
			env.DB.prepare('INSERT INTO image (data) VALUES (?1)').bind(
				JSON.stringify({
					Type: 1,
					Accessibility: 1,
					AccessibilityLocked: false,
					ImageName: `p${img.Id}.jpg`,
					Description: null,
					PlayerId: 700,
					TaggedPlayerIds: [],
					RoomId: null,
					PlayerEventId: null,
					CreatedAt: '2026-01-01T00:00:00.000Z',
					CheerCount: 0,
					CommentCount: 0,
					...img,
				})
			)
		await env.DB.batch([
			// Player 700's own photos (newest last so ordering is exercised).
			seed({ Id: 201, PlayerId: 700, CreatedAt: '2026-03-01T00:00:00.000Z' }),
			seed({ Id: 202, PlayerId: 700, CreatedAt: '2026-04-01T00:00:00.000Z' }),
			seed({ Id: 203, PlayerId: 700, Accessibility: 0 }), // private → hidden
			// Taken by someone else, but player 700 is tagged in it → feed only.
			seed({
				Id: 204,
				PlayerId: 999,
				TaggedPlayerIds: [700],
				CreatedAt: '2026-05-01T00:00:00.000Z',
			}),
			// Unrelated to 700 → in neither.
			seed({ Id: 205, PlayerId: 999, TaggedPlayerIds: [111] }),
		])

		// The lists serve the client's ImagesPlayer projection: the id and type are
		// SavedImageId/SavedImageType, and TaggedPlayerIds isn't part of it.
		type ImagesPlayer = { SavedImageId: number; SavedImageType: number; ImageName: string }

		// v4/player → only photos 700 *took*, public, newest first.
		const mine = (await (
			await exports.default.fetch(`${ORIGIN}/api/images/v4/player/700`)
		).json()) as ImagesPlayer[]
		expect(mine.map((i) => i.SavedImageId)).toEqual([202, 201])
		expect(mine[0]).toEqual({
			Accessibility: 1,
			AccessibilityLocked: false,
			CheerCount: 0,
			CommentCount: 0,
			CreatedAt: '2026-04-01T00:00:00.000Z',
			Description: null,
			ImageName: 'p202.jpg',
			PlayerEventId: null,
			PlayerId: 700,
			RoomId: null,
			SavedImageId: 202,
			SavedImageType: 1,
		})

		// take paginates.
		const one = (await (
			await exports.default.fetch(`${ORIGIN}/api/images/v4/player/700?take=1`)
		).json()) as ImagesPlayer[]
		expect(one.map((i) => i.SavedImageId)).toEqual([202])

		// v5/player is the same list with a sort option (0 = newest first).
		const sorted = (await (
			await exports.default.fetch(`${ORIGIN}/api/images/v5/player/700?sort=0`)
		).json()) as ImagesPlayer[]
		expect(sorted.map((i) => i.SavedImageId)).toEqual([202, 201])

		// v3/feed/player → photos taken *or* tagged in, newest first (204 is newest).
		const feed = (await (
			await exports.default.fetch(`${ORIGIN}/api/images/v3/feed/player/700?take=100`)
		).json()) as ImagesPlayer[]
		expect(feed.map((i) => i.SavedImageId)).toEqual([204, 202, 201])

		// A player with no photos → empty array on both.
		expect(
			await (await exports.default.fetch(`${ORIGIN}/api/images/v4/player/424242`)).json()
		).toEqual([])
		expect(
			await (await exports.default.fetch(`${ORIGIN}/api/images/v3/feed/player/424242`)).json()
		).toEqual([])
	})
})

describe('relationships', () => {
	// RelationshipType: 0 None, 1 FriendRequestSent, 2 FriendRequestReceived, 3 Friend.
	type Rel = { PlayerID: number; RelationshipType: number; Favorited: number }

	// Call a relationship mutation as `sub`, targeting `playerId` — the real client
	// shape: a GET with the target in `?id=`.
	async function mutate(path: string, sub: string, playerId: number) {
		return exports.default.fetch(`${ORIGIN}${path}?id=${playerId}`, {
			headers: await bearer(sub),
		})
	}

	// Fetch `sub`'s relationships, projected from their point of view.
	async function relationships(sub: string): Promise<Rel[]> {
		const res = await exports.default.fetch(`${ORIGIN}/api/relationships/v2/get`, {
			headers: await bearer(sub),
		})
		return (await res.json()) as Rel[]
	}

	// Standard ack the flag endpoints (favorite/ignore/mute + inverses) now return —
	// the relationship detail rides a RelationshipChanged hub notification instead.
	const ACK = { Success: true, Message: '' }

	// The notify DO is stubbed to record every notifyPlayer call (see vitest.config).
	type Notification = {
		playerId: number
		notificationType: number
		data: { PlayerID: number; RelationshipType: number; Favorited: number; Ignored: number }
	}
	const hub = () => env.RECFLARE_NOTIFICATIONS_HUB.getByName('global')

	/** Drop everything the hub stub has recorded so far. */
	async function resetNotifications() {
		await hub().fetch('http://do/all', { method: 'DELETE' })
	}

	/** Every notification pushed since the last reset, in order. */
	async function sentNotifications(): Promise<Notification[]> {
		return (await (await hub().fetch('http://do/all')).json()) as Notification[]
	}

	// POST a flag mutation the real client way (form body `PlayerId=<id>`), returning
	// the parsed ack body.
	async function ackFlag(path: string, sub: string, playerId: number) {
		return (await (
			await exports.default.fetch(`${ORIGIN}${path}`, {
				method: 'POST',
				headers: { ...(await bearer(sub)), 'Content-Type': 'application/x-www-form-urlencoded' },
				body: `PlayerId=${playerId}`,
			})
		).json()) as { Success: boolean; Message: string }
	}

	// A player's own-side flags read straight from the relationship row — the flag
	// endpoints return only an ack, so the effect is verified against the row itself.
	async function ownFlags(playerId: number, otherId: number) {
		const row = (await env.DB.prepare(
			`SELECT requester_id, requester_favorited, requester_ignored, requester_muted,
			        target_favorited, target_ignored, target_muted
			 FROM relationship
			 WHERE (requester_id = ?1 AND target_id = ?2) OR (requester_id = ?2 AND target_id = ?1)`
		)
			.bind(playerId, otherId)
			.first()) as Record<string, number> | null
		if (!row) return null
		const isRequester = row.requester_id === playerId
		return {
			Favorited: isRequester ? row.requester_favorited : row.target_favorited,
			Ignored: isRequester ? row.requester_ignored : row.target_ignored,
			Muted: isRequester ? row.requester_muted : row.target_muted,
		}
	}

	test('GET /api/relationships/v2/get is auth-gated', async () => {
		expect((await exports.default.fetch(`${ORIGIN}/api/relationships/v2/get`)).status).toBe(401)
	})

	test('mutations are auth-gated', async () => {
		for (const path of [
			'/api/relationships/v2/sendfriendrequest',
			'/api/relationships/v2/acceptfriendrequest',
			'/api/relationships/v2/removefriend',
			'/api/relationships/v2/addfriend',
			'/api/relationships/v1/ignore',
			'/api/relationships/v1/mute',
			'/api/relationships/v1/favorite',
			'/api/relationships/v1/unfavorite',
		]) {
			const res = await exports.default.fetch(`${ORIGIN}${path}?id=1`)
			expect(res.status).toBe(401)
		}
	})

	test('send → the two sides see Sent / Received; accept → both Friend; remove → gone', async () => {
		// 500 sends 501 a request.
		const sent = (await (
			await mutate('/api/relationships/v2/sendfriendrequest', '500', 501)
		).json()) as Rel
		expect(sent).toMatchObject({ PlayerID: 501, RelationshipType: 1 })

		// 500 sees it as Sent (1); 501 sees the mirror as Received (2).
		expect(await relationships('500')).toEqual([
			{ PlayerID: 501, RelationshipType: 1, Favorited: 0, Ignored: 0, Muted: 0 },
		])
		expect(await relationships('501')).toEqual([
			{ PlayerID: 500, RelationshipType: 2, Favorited: 0, Ignored: 0, Muted: 0 },
		])

		// 501 accepts → both are Friends (3).
		const accepted = (await (
			await mutate('/api/relationships/v2/acceptfriendrequest', '501', 500)
		).json()) as Rel
		expect(accepted).toMatchObject({ PlayerID: 500, RelationshipType: 3 })
		expect(await relationships('500')).toEqual([
			{ PlayerID: 501, RelationshipType: 3, Favorited: 0, Ignored: 0, Muted: 0 },
		])
		expect(await relationships('501')).toEqual([
			{ PlayerID: 500, RelationshipType: 3, Favorited: 0, Ignored: 0, Muted: 0 },
		])

		// 500 removes → both sides drop to None. The row is kept (that's where the
		// per-side flags live), so v2/get still reports the pair, now as None (0).
		expect((await mutate('/api/relationships/v2/removefriend', '500', 501)).status).toBe(200)
		expect(await relationships('500')).toEqual([
			{ PlayerID: 501, RelationshipType: 0, Favorited: 0, Ignored: 0, Muted: 0 },
		])
		expect(await relationships('501')).toEqual([
			{ PlayerID: 500, RelationshipType: 0, Favorited: 0, Ignored: 0, Muted: 0 },
		])
	})

	test('removefriend keeps the caller’s ignore flag', async () => {
		// 760 befriends 761 then ignores them; dropping the friendship must not
		// un-ignore them (the flag lives on the row the removal downgrades to None).
		await mutate('/api/relationships/v2/addfriend', '760', 761)
		await ackFlag('/api/relationships/v1/ignore', '760', 761)
		await mutate('/api/relationships/v2/removefriend', '760', 761)
		expect(await ownFlags(760, 761)).toMatchObject({ Ignored: 1 })
		expect(await relationships('760')).toEqual([
			{ PlayerID: 761, RelationshipType: 0, Favorited: 0, Ignored: 1, Muted: 0 },
		])
	})

	test('addfriend makes them friends directly', async () => {
		const res = (await (await mutate('/api/relationships/v2/addfriend', '510', 511)).json()) as Rel
		expect(res).toMatchObject({ PlayerID: 511, RelationshipType: 3 })
		expect(await relationships('511')).toEqual([
			{ PlayerID: 510, RelationshipType: 3, Favorited: 0, Ignored: 0, Muted: 0 },
		])
	})

	test('crossing friend requests become a friendship', async () => {
		await mutate('/api/relationships/v2/sendfriendrequest', '520', 521)
		// 521 sends back to 520 → the crossing requests resolve to Friend for both.
		const crossed = (await (
			await mutate('/api/relationships/v2/sendfriendrequest', '521', 520)
		).json()) as Rel
		expect(crossed).toMatchObject({ PlayerID: 520, RelationshipType: 3 })
		expect(await relationships('520')).toEqual([
			{ PlayerID: 521, RelationshipType: 3, Favorited: 0, Ignored: 0, Muted: 0 },
		])
	})

	test('a self-targeted request is rejected', async () => {
		expect((await mutate('/api/relationships/v2/sendfriendrequest', '530', 530)).status).toBe(400)
	})

	test('v1 ignore/mute set the caller’s own side of the relationship', async () => {
		type FullRel = { PlayerID: number; RelationshipType: number; Ignored: number; Muted: number }

		// 700 ignores 701 with no prior relationship → a bare None row, the caller's side
		// flagged. The response is now just the ack; the flag is verified on the row.
		expect(await ackFlag('/api/relationships/v1/ignore', '700', 701)).toEqual(ACK)
		expect(await ownFlags(700, 701)).toMatchObject({ Ignored: 1, Muted: 0 })
		// 700 then mutes 701 → same row, mute added, the earlier ignore preserved.
		expect(await ackFlag('/api/relationships/v1/mute', '700', 701)).toEqual(ACK)
		expect(await ownFlags(700, 701)).toMatchObject({ Ignored: 1, Muted: 1 })

		// The tricky case: the caller is the row's TARGET. 710 sends 711 a request
		// (710 = requester); 711 ignoring 710 must flag the target side, not the requester's.
		await mutate('/api/relationships/v2/sendfriendrequest', '710', 711)
		expect(await ackFlag('/api/relationships/v1/ignore', '711', 710)).toEqual(ACK)
		// 711 sees 710's request as Received (2) with their own Ignored set.
		expect((await relationships('711')) as unknown as FullRel[]).toEqual([
			expect.objectContaining({ PlayerID: 710, RelationshipType: 2, Ignored: 1 }),
		])
		// 710's own side is untouched — the requester never ignored anyone.
		expect((await relationships('710')) as unknown as FullRel[]).toEqual([
			expect.objectContaining({ PlayerID: 711, RelationshipType: 1, Ignored: 0 }),
		])
	})

	test('v1 unignore/unmute clear the caller’s own flags independently', async () => {
		// 800 ignores and mutes 801 (bare None row, both flags on the caller's side).
		await ackFlag('/api/relationships/v1/ignore', '800', 801)
		await ackFlag('/api/relationships/v1/mute', '800', 801)
		expect(await ownFlags(800, 801)).toMatchObject({ Ignored: 1, Muted: 1 })
		// unignore clears only Ignored; the mute is left in place.
		expect(await ackFlag('/api/relationships/v1/unignore', '800', 801)).toEqual(ACK)
		expect(await ownFlags(800, 801)).toMatchObject({ Ignored: 0, Muted: 1 })
		// unmute then clears Muted too.
		expect(await ackFlag('/api/relationships/v1/unmute', '800', 801)).toEqual(ACK)
		expect(await ownFlags(800, 801)).toMatchObject({ Ignored: 0, Muted: 0 })
	})

	test('v1 favorite/unfavorite toggle the caller’s own side, leaving the friendship intact', async () => {
		// 720 and 721 are friends; 720 favorites 721 — the real client shape, a GET with `?id=`.
		await mutate('/api/relationships/v2/addfriend', '720', 721)
		expect(await (await mutate('/api/relationships/v1/favorite', '720', 721)).json()).toEqual(ACK)
		// 720's own side is favorited; the friendship is intact.
		expect(await relationships('720')).toEqual([
			{ PlayerID: 721, RelationshipType: 3, Favorited: 1, Ignored: 0, Muted: 0 },
		])
		// Favoriting is one-sided: 721 does not see themselves as having favorited 720.
		expect(await relationships('721')).toEqual([
			{ PlayerID: 720, RelationshipType: 3, Favorited: 0, Ignored: 0, Muted: 0 },
		])

		// Unfavorite clears the flag but keeps the friendship.
		expect(await (await mutate('/api/relationships/v1/unfavorite', '720', 721)).json()).toEqual(ACK)
		expect(await relationships('720')).toEqual([
			{ PlayerID: 721, RelationshipType: 3, Favorited: 0, Ignored: 0, Muted: 0 },
		])
	})

	test('favoriting a player you have no relationship with is allowed', async () => {
		// Mirrors ignore/mute: a bare None row is created with the caller's side flagged.
		expect(await (await mutate('/api/relationships/v1/favorite', '730', 731)).json()).toEqual(ACK)
		expect(await ownFlags(730, 731)).toMatchObject({ Favorited: 1 })
		// The bare None row is reported by v2/get — it carries the flag.
		expect(await relationships('730')).toEqual([
			{ PlayerID: 731, RelationshipType: 0, Favorited: 1, Ignored: 0, Muted: 0 },
		])
	})

	test('a self-targeted favorite is rejected', async () => {
		expect((await mutate('/api/relationships/v1/favorite', '740', 740)).status).toBe(400)
	})

	test('a flag change pushes a RelationshipChanged notification with the relationship', async () => {
		// The relationship detail now rides a hub notification instead of the response.
		// The notify DO is stubbed to record its last notifyPlayer call (see vitest.config).
		await ackFlag('/api/relationships/v1/favorite', '750', 751)
		const res = await env.RECFLARE_NOTIFICATIONS_HUB.getByName('global').fetch('http://do/last')
		const last = (await res.json()) as {
			playerId: number
			notificationType: number
			data: { PlayerID: number; Favorited: number; RelationshipType: number }
		}
		expect(last.playerId).toBe(750) // sent to the caller
		expect(last.notificationType).toBe(1) // NotificationType.RelationshipChanged
		expect(last.data).toMatchObject({ PlayerID: 751, Favorited: 1, RelationshipType: 0 })
	})

	test('sendfriendrequest notifies both players with their own projection', async () => {
		await resetNotifications()
		await mutate('/api/relationships/v2/sendfriendrequest', '770', 771)

		// Both sides hear about it, each seeing the other player and their own side's
		// type: the sender Sent (1), the recipient Received (2).
		expect(await sentNotifications()).toEqual([
			{
				playerId: 770,
				notificationType: 1,
				data: { PlayerID: 771, RelationshipType: 1, Favorited: 0, Ignored: 0, Muted: 0 },
			},
			{
				playerId: 771,
				notificationType: 1,
				data: { PlayerID: 770, RelationshipType: 2, Favorited: 0, Ignored: 0, Muted: 0 },
			},
		])
	})

	test('accepting notifies both players as Friend', async () => {
		await mutate('/api/relationships/v2/sendfriendrequest', '780', 781)
		await resetNotifications()
		await mutate('/api/relationships/v2/acceptfriendrequest', '781', 780)

		const sent = await sentNotifications()
		expect(sent).toHaveLength(2)
		// Friend (3) is symmetric, so both sides see the same type, each pointing at the other.
		expect(sent).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					playerId: 780,
					data: expect.objectContaining({ PlayerID: 781, RelationshipType: 3 }),
				}),
				expect.objectContaining({
					playerId: 781,
					data: expect.objectContaining({ PlayerID: 780, RelationshipType: 3 }),
				}),
			])
		)
	})

	test('removefriend notifies both players with None', async () => {
		await mutate('/api/relationships/v2/addfriend', '790', 791)
		await resetNotifications()
		await mutate('/api/relationships/v2/removefriend', '790', 791)

		const sent = await sentNotifications()
		expect(sent).toHaveLength(2)
		expect(sent.map((n) => n.playerId).sort((a, b) => a - b)).toEqual([790, 791])
		for (const n of sent) expect(n.data.RelationshipType).toBe(0)
	})

	test('a no-op friend request notifies nobody', async () => {
		await mutate('/api/relationships/v2/sendfriendrequest', '810', 811)
		await resetNotifications()

		// Re-sending an already-outstanding request writes nothing, so nothing is pushed.
		await mutate('/api/relationships/v2/sendfriendrequest', '810', 811)
		expect(await sentNotifications()).toEqual([])

		// Likewise accepting something that isn't pending (810 has no request to accept).
		await mutate('/api/relationships/v2/acceptfriendrequest', '810', 811)
		expect(await sentNotifications()).toEqual([])
	})

	test('crossing requests notify both players as Friend', async () => {
		await mutate('/api/relationships/v2/sendfriendrequest', '820', 821)
		await resetNotifications()
		// 821's request crosses 820's → an immediate friendship, both sides told.
		await mutate('/api/relationships/v2/sendfriendrequest', '821', 820)

		const sent = await sentNotifications()
		expect(sent).toHaveLength(2)
		for (const n of sent) expect(n.data.RelationshipType).toBe(3)
	})
})
