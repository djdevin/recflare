import { Hono } from 'hono'
import { useWorkersLogger } from 'workers-tagged-logger'

import { withNotFound, withOnError } from '@repo/hono-helpers'
import { validateAndGetAccountId } from '@repo/jwt'

import {
	clearHomeClub,
	ClubJoinability,
	ClubMembershipType,
	ClubVisibility,
	createClub,
	createClubAnnouncement,
	deleteClub,
	getClub,
	getClubAnnouncements,
	getClubDetails,
	getClubMembers,
	getClubsByCreator,
	getClubsByMember,
	getHomeClub,
	getMembership,
	joinClub,
	leaveClub,
	MAX_ADDITIONAL_IMAGES,
	requestToJoinClub,
	searchClubs,
	setClubAdditionalImage,
	setHomeClub,
	updateClub,
} from './clubs-db'

import type { Context } from 'hono'
import type { App } from './context'

/**
 * Resolve the account id from a Bearer token. Returns `null` when the header is
 * missing, the token is invalid, or the `sub` claim isn't an integer.
 */
async function authedId(c: Context<App>): Promise<number | null> {
	return validateAndGetAccountId(c.req.raw, await c.env.JWT_SECRET.get())
}

/** Longest a club name may be (the reference's MaxNameLength). */
const MAX_CLUB_NAME_LENGTH = 16

/** The punctuation a club name may use, on top of letters and digits. */
const ALLOWED_NAME_PUNCTUATION = new Set([...` .,'!?-_&()#@:+`])

/**
 * Club names are letters (any Latin script), digits, and basic punctuation — the
 * reference's IsValidName. Anything else (emoji, other scripts, control chars) is
 * rejected rather than stored.
 */
function isValidClubName(name: string): boolean {
	return [...name.normalize('NFC')].every(
		(ch) => /\p{Script=Latin}|\p{Nd}/u.test(ch) || ALLOWED_NAME_PUNCTUATION.has(ch)
	)
}

/** A rejected club action: the same envelope as success, carrying the message. */
function clubError(c: Context<App>, message: string) {
	return c.json({ error: message, success: false, value: null }, 400)
}

/**
 * The client sends enums by *name* (`visibility=Public`, `joinability=Open`), not by
 * number — though the numbers are accepted too. An unrecognized value is undefined,
 * and leaves the field unchanged rather than resetting it.
 */
function parseVisibility(value: string | undefined): number | undefined {
	switch (value?.trim().toLowerCase()) {
		case 'private':
		case '0':
			return ClubVisibility.Private
		case 'public':
		case '1':
			return ClubVisibility.Public
		default:
			return undefined
	}
}

function parseJoinability(value: string | undefined): number | undefined {
	switch (value?.trim().toLowerCase().replace(/_/g, '')) {
		case 'open':
		case '0':
			return ClubJoinability.Open
		case 'inviteonly':
		case '1':
			return ClubJoinability.InviteOnly
		// The client calls this AskToJoin; the reference parses it as RequestToJoin.
		case 'asktojoin':
		case 'requesttojoin':
		case '2':
			return ClubJoinability.AskToJoin
		default:
			return undefined
	}
}

/** Form booleans arrive as `True`/`false`/`1`/`yes`. */
function parseFormBool(value: string | undefined): boolean | undefined {
	switch (value?.trim().toLowerCase()) {
		case 'true':
		case '1':
		case 'yes':
			return true
		case 'false':
		case '0':
		case 'no':
			return false
		default:
			return undefined
	}
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

	// The player's home club — the one whose clubhouse they spawn into, stored on their
	// account. Auth-gated. 404 when they have no home club, the club is gone, or it has
	// no clubhouse room: the client expects a 404 for "no home club" and errors on an
	// empty object. Returns the bare club (not the envelope), as the reference does.
	.get('/club/home/me', async (c) => {
		const id = await authedId(c)
		if (id === null) return c.body(null, 401)
		const club = await getHomeClub(c.env.DB, id)
		return club === null ? c.notFound() : c.json(club)
	})

	// Set the player's home club (`clubId` form field). They must be a member of it —
	// you can't make a club you don't belong to your home. Answers the envelope.
	.put('/club/home/me', async (c) => {
		const id = await authedId(c)
		if (id === null) return c.body(null, 401)

		const body = (await c.req.parseBody().catch(() => ({}))) as Record<string, unknown>
		const key = Object.keys(body).find((k) => k.toLowerCase() === 'clubid')
		const clubId = Number.parseInt(
			typeof body[key ?? ''] === 'string' ? String(body[key ?? '']) : '',
			10
		)
		if (Number.isNaN(clubId) || clubId === 0) return clubError(c, 'Invalid clubId.')

		const club = await getClub(c.env.DB, clubId)
		if (club === null) return c.notFound()

		const membership = await getMembership(c.env.DB, clubId, id)
		if (membership < ClubMembershipType.Member) {
			return c.json(
				{ error: 'You are not a member of that club.', success: false, value: null },
				403
			)
		}

		await setHomeClub(c.env.DB, id, clubId)
		return c.json({ error: '', success: true, value: club })
	})

	// Clear the player's home club — they spawn into the default hub again instead of a
	// clubhouse. No body, idempotent (clearing when there's none set is a no-op, not a
	// 404), and it doesn't touch their membership of the club. The envelope's value is
	// null because there's no home club left to describe; GET goes back to 404ing.
	.delete('/club/home/me', async (c) => {
		const id = await authedId(c)
		if (id === null) return c.body(null, 401)
		await clearHomeClub(c.env.DB, id)
		return c.json({ error: '', success: true, value: null })
	})

	// A real Rec Room client endpoint with no backing implementation yet. The
	// client calls it on the clubs host at /subscription/mine/member (no /club
	// prefix) and sends no auth header, so it isn't gated. Returns an empty
	// array = no club subscription memberships (the client chokes on null).
	.get('/subscription/mine/member', (c) => c.json([]))

	// Subscription details for an account (numeric id) — simulated: no club, no subs.
	.get('/subscription/details/:accountId{[0-9]+}', (c) =>
		c.json({
			accountId: Number.parseInt(c.req.param('accountId'), 10),
			clubId: 0,
			subscriberCount: 0,
		})
	)

	// Details for a named subscription (e.g. `rrplus`). The client deserializes this
	// into an object, so it must return `{}` (not `[]`).
	.get('/subscription/details/:subscription', (c) => c.json({}))

	// Subscriber count for an account. No club subscriptions yet → 0.
	.get('/subscription/subscriberCount/:accountId{[0-9]+}', (c) => c.json(0))

	// The player's clubs that have unread announcements (MyClubsWithUnread-
	// Announcements). Nothing tracks what a player has read yet → nothing is unread.
	.get('/announcements/v2/mine/unread', (c) => c.json([]))

	// A club's announcements — its noticeboard, newest first. Public. Answers the
	// envelope, with `LastAnnouncementId` the newest one (null when there are none)
	// and `LastReadAnnouncementId` 0: nothing tracks read state yet.
	.get('/announcements/club/:clubId{[0-9]+}', async (c) => {
		const clubId = Number.parseInt(c.req.param('clubId'), 10)
		const announcements = await getClubAnnouncements(c.env.DB, clubId)
		return c.json({
			error: '',
			success: true,
			value: {
				Announcements: announcements,
				ClubId: clubId,
				LastAnnouncementId: announcements[0]?.AnnouncementId ?? null,
				LastReadAnnouncementId: 0,
			},
		})
	})

	// Post an announcement to a club. Co-owner or above only. The envelope's value is
	// the new announcement's id.
	.post('/announcements/club/:clubId{[0-9]+}', async (c) => {
		const id = await authedId(c)
		if (id === null) return c.body(null, 401)

		const clubId = Number.parseInt(c.req.param('clubId'), 10)
		const club = await getClub(c.env.DB, clubId)
		if (club === null) return c.notFound()

		const membership = await getMembership(c.env.DB, clubId, id)
		if (membership < ClubMembershipType.Coowner) {
			return c.json({ error: 'Insufficient permissions.', success: false, value: null }, 403)
		}

		const body = (await c.req.parseBody().catch(() => ({}))) as Record<string, unknown>
		const field = (name: string): string | undefined => {
			const key = Object.keys(body).find((k) => k.toLowerCase() === name.toLowerCase())
			const v = key === undefined ? undefined : body[key]
			return typeof v === 'string' ? v : undefined
		}

		const announcementId = await createClubAnnouncement(c.env.DB, clubId, id, {
			title: field('title'),
			body: field('body'),
			imageName: field('imageName'),
			meta: field('meta'),
		})
		return c.json({ error: '', success: true, value: announcementId })
	})

	// The clubs the player is a member of (GetMyMembershipClubs). Reads the caller's
	// memberships from `club_member`. A caller with no valid token has no clubs, so
	// this answers an empty list rather than 401ing — the client shows the "my clubs"
	// shelf either way, and an error there breaks the screen.
	.get('/club/mine/member', async (c) => {
		const id = await authedId(c)
		if (id === null) return c.json([])
		return c.json(await getClubsByMember(c.env.DB, id))
	})

	// The clubs the player created (GetMyCreatedClubs). Empty list when signed out,
	// like mine/member.
	.get('/club/mine/created', async (c) => {
		const id = await authedId(c)
		if (id === null) return c.json([])
		return c.json(await getClubsByCreator(c.env.DB, id))
	})

	// Club search / browse. Public, non-subscription clubs; `category` filters to that
	// category, `query` matches the name or description, `sort` picks the order (1 =
	// newest, 2 = by name, default = most members first), and `count` caps the page
	// (out of range → 30). Public. Answers `{ Clubs, ContinuationToken, TotalClubs }`.
	.get('/club/search', async (c) => {
		const count = Number.parseInt(c.req.query('count') ?? '', 10)
		return c.json(
			await searchClubs(
				c.env.DB,
				c.req.query('category') ?? '',
				c.req.query('query') ?? '',
				c.req.query('sort'),
				Number.isNaN(count) || count <= 0 || count > 100 ? 30 : count
			)
		)
	})

	// The set of club category tags a club can be filed under — a fixed list.
	.get('/club/categoryTags', (c) =>
		c.json(['Social', 'Creative', 'Competitive', 'Casual', 'Entertainment'])
	)

	// Create a club. The client posts a form to `/club/create` with lowercase fields
	// (`name`, `description`, `category`). Auth-gated. Answers the `{ error, success,
	// value }` envelope carrying the new club's details — not a bare club.
	.post('/club/create', async (c) => {
		const id = await authedId(c)
		if (id === null) return c.body(null, 401)

		const body = (await c.req.parseBody().catch(() => ({}))) as Record<string, unknown>
		// The client sends lowercase field names; accept either casing.
		const field = (name: string): string | undefined => {
			const key = Object.keys(body).find((k) => k.toLowerCase() === name.toLowerCase())
			const v = key === undefined ? undefined : body[key]
			return typeof v === 'string' ? v : undefined
		}
		const int = (v: string | undefined): number | undefined => {
			const n = v === undefined ? Number.NaN : Number.parseInt(v, 10)
			return Number.isNaN(n) ? undefined : n
		}

		const name = field('name')?.trim() ?? ''
		const description = field('description') ?? ''
		if (name === '') return clubError(c, 'You must enter a name for your club.')
		if (!isValidClubName(name)) {
			return clubError(c, 'Club names can only use letters, numbers, and basic punctuation.')
		}
		if ([...name].length > MAX_CLUB_NAME_LENGTH) {
			return clubError(c, `Club names can be at most ${MAX_CLUB_NAME_LENGTH} characters.`)
		}

		const club = await createClub(c.env.DB, id, {
			name,
			description,
			// An unset category files the club under Social, as the reference does.
			category: field('category')?.trim() || 'Social',
			visibility: parseVisibility(field('visibility')),
			joinability: parseJoinability(field('joinability')),
			allowJuniors: parseFormBool(field('allowJuniors')),
			mainImageName: field('mainImageName'),
			// ClubType is deliberately not taken from the client: a player-created club
			// is always a regular one. Letting the client pick would let it mint a
			// subscription club (type 1), which is excluded from every club listing.
			minLevel: int(field('minLevel')),
		})
		return c.json({
			error: '',
			success: true,
			value: await getClubDetails(c.env.DB, club, id),
		})
	})

	// Edit a club's details. The client PUTs a form of the fields it's changing —
	// enums by name (`visibility=Public`, `joinability=Open`, `allowJuniors=True`) —
	// and absent fields keep their stored value. `customTags` may repeat; when present
	// it replaces the club's tag set wholesale. Co-owner or above only. Answers the
	// same `{ error, success, value }` envelope create does.
	//
	// `/modify` is the same endpoint under the shorter name the client also PUTs to
	// (`name=…&description=…&category=…`); one handler, so the two can't drift.
	.on('PUT', ['/club/:clubId{[0-9]+}/modifydetails', '/club/:clubId{[0-9]+}/modify'], async (c) => {
		const id = await authedId(c)
		if (id === null) return c.body(null, 401)

		const clubId = Number.parseInt(c.req.param('clubId'), 10)
		const club = await getClub(c.env.DB, clubId)
		if (club === null) return c.notFound()

		// Editing details is a co-owner power — plain members and moderators can't.
		const membership = await getMembership(c.env.DB, clubId, id)
		if (membership < ClubMembershipType.Coowner) {
			return c.json({ error: 'Insufficient permissions.', success: false, value: null }, 403)
		}

		// `all: true` so a repeated `customTags` field arrives as a list.
		const body = (await c.req.parseBody({ all: true }).catch(() => ({}))) as Record<string, unknown>
		const field = (name: string): string | undefined => {
			const key = Object.keys(body).find((k) => k.toLowerCase() === name.toLowerCase())
			const v = key === undefined ? undefined : body[key]
			const first = Array.isArray(v) ? v[0] : v
			return typeof first === 'string' ? first : undefined
		}
		const list = (name: string): string[] | undefined => {
			const key = Object.keys(body).find((k) => k.toLowerCase() === name.toLowerCase())
			if (key === undefined) return undefined
			const v = body[key]
			const values = Array.isArray(v) ? v : [v]
			return values.filter((t): t is string => typeof t === 'string')
		}
		const int = (v: string | undefined): number | undefined => {
			const n = v === undefined ? Number.NaN : Number.parseInt(v, 10)
			return Number.isNaN(n) ? undefined : n
		}

		// An empty name/description means "unchanged", not "clear it" — the reference
		// only applies these when non-empty.
		const name = field('name')?.trim() || undefined
		if (name !== undefined) {
			if (!isValidClubName(name)) {
				return clubError(c, 'Club names can only use letters, numbers, and basic punctuation.')
			}
			if ([...name].length > MAX_CLUB_NAME_LENGTH) {
				return clubError(c, `Club names can be at most ${MAX_CLUB_NAME_LENGTH} characters.`)
			}
		}

		const updated = await updateClub(c.env.DB, clubId, {
			name,
			description: field('description') || undefined,
			category: field('category')?.trim() || undefined,
			visibility: parseVisibility(field('visibility')),
			joinability: parseJoinability(field('joinability')),
			allowJuniors: parseFormBool(field('allowJuniors')),
			mainImageName: field('mainImageName') || undefined,
			minLevel: int(field('minLevel')),
			customTags: list('customTags'),
		})
		if (updated === null) return c.notFound()

		return c.json({
			error: '',
			success: true,
			value: await getClubDetails(c.env.DB, updated, id),
		})
	})

	// A club's full details — the club plus its tags, the per-tier permissions, and the
	// caller's own membership. Public (a signed-out viewer just gets MyMembershipType
	// 0). Unlike create/modifydetails this one is *not* enveloped: the reference writes
	// the details object straight out.
	.get('/club/:clubId{[0-9]+}/details', async (c) => {
		const clubId = Number.parseInt(c.req.param('clubId'), 10)
		const club = await getClub(c.env.DB, clubId)
		if (club === null) return c.notFound()
		const id = await authedId(c)
		return c.json(await getClubDetails(c.env.DB, club, id))
	})

	// Whether a club has turned its club chat off. Nothing can disable club chat yet
	// (no setting, no storage), so chat is always on → `false`. A bare JSON boolean,
	// like the other `is…`/`has…` gates the client polls; not in the reference, so if
	// the client chokes on this it likely wants the `{ error, success, value }`
	// envelope the other club endpoints use.
	.get('/club/:clubId{[0-9]+}/hasDisabledClubChat', (c) => c.json(false))

	// A club's members. `membershipType` filters to exactly that tier (an exact match,
	// not a threshold — `30` lists co-owners only, not the creator above them), and
	// `sortBy` picks the order (1 = account id, 2 = oldest first, default = highest
	// tier first). Public, and an unknown club is an empty list. Answers the envelope.
	.get('/club/:clubId{[0-9]+}/members', async (c) => {
		const clubId = Number.parseInt(c.req.param('clubId'), 10)
		const raw = c.req.query('membershipType')
		const membershipType = raw === undefined ? Number.NaN : Number.parseInt(raw, 10)

		const members = await getClubMembers(
			c.env.DB,
			clubId,
			Number.isNaN(membershipType) ? undefined : membershipType,
			c.req.query('sortBy')
		)
		return c.json({ error: '', success: true, value: members })
	})

	// Set the minimum player level required to join the club. The reference has no such
	// route (it only takes `minLevel` on modifydetails), but the client PUTs it here.
	// Same rules as the other club edits: co-owner or above, and the details envelope.
	.put('/club/:clubId{[0-9]+}/minlevel', async (c) => {
		const id = await authedId(c)
		if (id === null) return c.body(null, 401)

		const clubId = Number.parseInt(c.req.param('clubId'), 10)
		const club = await getClub(c.env.DB, clubId)
		if (club === null) return c.notFound()

		const membership = await getMembership(c.env.DB, clubId, id)
		if (membership < ClubMembershipType.Coowner) {
			return c.json({ error: 'Insufficient permissions.', success: false, value: null }, 403)
		}

		const body = (await c.req.parseBody().catch(() => ({}))) as Record<string, unknown>
		const key = Object.keys(body).find((k) => k.toLowerCase() === 'minlevel')
		const minLevel = Number.parseInt(
			typeof body[key ?? ''] === 'string' ? String(body[key ?? '']) : '',
			10
		)
		if (Number.isNaN(minLevel) || minLevel < 0) return clubError(c, 'Invalid minLevel.')

		const updated = await updateClub(c.env.DB, clubId, { minLevel })
		if (updated === null) return c.notFound()
		return c.json({
			error: '',
			success: true,
			value: await getClubDetails(c.env.DB, updated, id),
		})
	})

	// Set (or clear) the club's clubhouse room — the room players spawn into when the
	// club is their home. `roomId` sets it; omitting it clears the clubhouse. Co-owner
	// or above only. Answers the details envelope (the reference returns a null value
	// here, but the client re-renders from the response and leaves the old clubhouse
	// on screen unless it gets the updated club back).
	//
	// DELETE is the same thing with the clearing spelled out — it ignores any body and
	// always unsets the room, so "remove the clubhouse" doesn't depend on the client
	// remembering to send an empty PUT.
	.on(['PUT', 'DELETE'], '/club/:clubId{[0-9]+}/clubhouse', async (c) => {
		const id = await authedId(c)
		if (id === null) return c.body(null, 401)

		const clubId = Number.parseInt(c.req.param('clubId'), 10)
		const club = await getClub(c.env.DB, clubId)
		if (club === null) return c.notFound()

		const membership = await getMembership(c.env.DB, clubId, id)
		if (membership < ClubMembershipType.Coowner) {
			return c.json({ error: 'Insufficient permissions.', success: false, value: null }, 403)
		}

		let roomId: number | null = null
		if (c.req.method !== 'DELETE') {
			const body = (await c.req.parseBody().catch(() => ({}))) as Record<string, unknown>
			const key = Object.keys(body).find((k) => k.toLowerCase() === 'roomid')
			const raw = typeof body[key ?? ''] === 'string' ? String(body[key ?? '']).trim() : ''
			if (raw !== '' && Number.isNaN(Number.parseInt(raw, 10))) {
				return clubError(c, 'Invalid roomId.')
			}
			roomId = raw === '' ? null : Number.parseInt(raw, 10)
		}

		const updated = await updateClub(c.env.DB, clubId, { clubhouseRoomId: roomId })
		if (updated === null) return c.notFound()
		return c.json({
			error: '',
			success: true,
			value: await getClubDetails(c.env.DB, updated, id),
		})
	})

	// The club's main image. PUT sets it from an uploaded image's `imageName` (the
	// name the `storage` worker handed back); co-owner or above only. GET reads it —
	// the reference has no GET here (it 404s), but the client asks for it, so this
	// answers the same details envelope rather than erroring; the image name is on
	// `value.Club.MainImageName`.
	.get('/club/:clubId{[0-9]+}/mainimage', async (c) => {
		const clubId = Number.parseInt(c.req.param('clubId'), 10)
		const club = await getClub(c.env.DB, clubId)
		if (club === null) return c.notFound()
		const id = await authedId(c)
		return c.json({
			error: '',
			success: true,
			value: await getClubDetails(c.env.DB, club, id),
		})
	})
	.put('/club/:clubId{[0-9]+}/mainimage', async (c) => {
		const id = await authedId(c)
		if (id === null) return c.body(null, 401)

		const clubId = Number.parseInt(c.req.param('clubId'), 10)
		const club = await getClub(c.env.DB, clubId)
		if (club === null) return c.notFound()

		const membership = await getMembership(c.env.DB, clubId, id)
		if (membership < ClubMembershipType.Coowner) {
			return c.json({ error: 'Insufficient permissions.', success: false, value: null }, 403)
		}

		const body = (await c.req.parseBody().catch(() => ({}))) as Record<string, unknown>
		const key = Object.keys(body).find((k) => k.toLowerCase() === 'imagename')
		const imageName = typeof body[key ?? ''] === 'string' ? (body[key ?? ''] as string).trim() : ''
		if (imageName === '') return clubError(c, 'imageName is required.')

		const updated = await updateClub(c.env.DB, clubId, { mainImageName: imageName })
		if (updated === null) return c.notFound()
		return c.json({
			error: '',
			success: true,
			value: await getClubDetails(c.env.DB, updated, id),
		})
	})

	// One of the club's gallery images, by slot (`/additionalimage/{index}`, 0-based —
	// the client PUTs the first image to 0, the second to 1). Takes the same
	// `imageName` the `storage` worker handed back; an empty one clears that slot.
	// Co-owner or above, like the main image. The slots are positional, so clearing
	// one doesn't shift the others; they come back on `value.AdditionalImages`.
	//
	// DELETE removes that slot's image — same thing as PUTting an empty name, with the
	// intent spelled out. It ignores any body, so it can't accidentally set one, and
	// deleting an already-empty slot is a no-op rather than an error.
	.on(['PUT', 'DELETE'], '/club/:clubId{[0-9]+}/additionalimage/:index{[0-9]+}', async (c) => {
		const id = await authedId(c)
		if (id === null) return c.body(null, 401)

		const clubId = Number.parseInt(c.req.param('clubId'), 10)
		const club = await getClub(c.env.DB, clubId)
		if (club === null) return c.notFound()

		const membership = await getMembership(c.env.DB, clubId, id)
		if (membership < ClubMembershipType.Coowner) {
			return c.json({ error: 'Insufficient permissions.', success: false, value: null }, 403)
		}

		const index = Number.parseInt(c.req.param('index'), 10)
		if (index >= MAX_ADDITIONAL_IMAGES) {
			return clubError(c, `A club has ${MAX_ADDITIONAL_IMAGES} additional image slots (0-based).`)
		}

		let imageName = ''
		if (c.req.method !== 'DELETE') {
			const body = (await c.req.parseBody().catch(() => ({}))) as Record<string, unknown>
			const key = Object.keys(body).find((k) => k.toLowerCase() === 'imagename')
			imageName = typeof body[key ?? ''] === 'string' ? (body[key ?? ''] as string).trim() : ''
		}

		const updated = await setClubAdditionalImage(c.env.DB, clubId, index, imageName)
		if (updated === null) return c.notFound()
		return c.json({
			error: '',
			success: true,
			value: await getClubDetails(c.env.DB, updated, id),
		})
	})

	// A single club by id. 404 when the club isn't in the DB. Public.
	.get('/club/:clubId{[0-9]+}', async (c) => {
		const club = await getClub(c.env.DB, Number.parseInt(c.req.param('clubId'), 10))
		return club ? c.json(club) : c.notFound()
	})

	// Delete a club, along with its memberships and announcements. The creator only —
	// not co-owners, who can edit a club but can't destroy one — which is also the way
	// out for a creator, since they aren't allowed to leave (see /members/leave).
	// Answers the envelope with a null value; the club is gone, so there are no details
	// left to return.
	.delete('/club/:clubId{[0-9]+}', async (c) => {
		const id = await authedId(c)
		if (id === null) return c.body(null, 401)

		const clubId = Number.parseInt(c.req.param('clubId'), 10)
		const club = await getClub(c.env.DB, clubId)
		if (club === null) return c.notFound()

		const membership = await getMembership(c.env.DB, clubId, id)
		if (membership < ClubMembershipType.Creator) {
			return c.json({ error: 'Insufficient permissions.', success: false, value: null }, 403)
		}

		await deleteClub(c.env.DB, clubId)
		return c.json({ error: '', success: true, value: null })
	})

	// Ask to join a club. No body — the club id and the Bearer token are the whole
	// request. What it does depends on the club's Joinability: an Open club takes the
	// caller straight in as a Member, an AskToJoin club records a PendingRequested row
	// for a co-owner to approve, and an InviteOnly club refuses (you can only get in
	// through an invite). Repeats are idempotent; a banned account stays out. Answers
	// the details envelope so the client can read its new `MyMembershipType`.
	.put('/club/:clubId{[0-9]+}/members/requesttojoin', async (c) => {
		const id = await authedId(c)
		if (id === null) return c.body(null, 401)

		const clubId = Number.parseInt(c.req.param('clubId'), 10)
		const outcome = await requestToJoinClub(c.env.DB, clubId, id)
		if (outcome === null) return c.notFound()

		if (outcome.result === 'inviteOnly') {
			return clubError(c, 'This club is invite only.')
		}
		if (outcome.result === 'banned') {
			return c.json({ error: 'You are banned from this club.', success: false, value: null }, 403)
		}

		return c.json({
			error: '',
			success: true,
			value: await getClubDetails(c.env.DB, outcome.club, id),
		})
	})

	// Leave a club. No body, like requesttojoin — the club id and the Bearer token are
	// the whole request. Idempotent (leaving a club you're not in is a no-op), and it
	// also withdraws a pending request; a ban is preserved, since you can't clear one
	// by leaving. The creator is refused — they'd leave the club ownerless, so they
	// have to delete it instead. Answers the details envelope so the client sees
	// `MyMembershipType` drop to 0 (or stay at -1 for a banned account).
	.post('/club/:clubId{[0-9]+}/members/leave', async (c) => {
		const id = await authedId(c)
		if (id === null) return c.body(null, 401)

		const clubId = Number.parseInt(c.req.param('clubId'), 10)
		const outcome = await leaveClub(c.env.DB, clubId, id)
		if (outcome === null) return c.notFound()
		if (outcome.result === 'creator') {
			return c.json(
				{
					error: 'You created this club — delete it instead of leaving.',
					success: false,
					value: null,
				},
				403
			)
		}

		return c.json({
			error: '',
			success: true,
			value: await getClubDetails(c.env.DB, outcome.club, id),
		})
	})

	// Join / leave a club (auth-gated, idempotent). Both return the club with its
	// refreshed MemberCount; 404 when the club doesn't exist.
	.post('/club/:clubId{[0-9]+}/join', async (c) => {
		const id = await authedId(c)
		if (id === null) return c.body(null, 401)
		const club = await joinClub(c.env.DB, Number.parseInt(c.req.param('clubId'), 10), id)
		return club ? c.json(club) : c.notFound()
	})
	// Leaving is refused for the creator here too (see /members/leave), so the two
	// routes can't disagree about who's still in the club.
	.post('/club/:clubId{[0-9]+}/leave', async (c) => {
		const id = await authedId(c)
		if (id === null) return c.body(null, 401)
		const outcome = await leaveClub(c.env.DB, Number.parseInt(c.req.param('clubId'), 10), id)
		if (outcome === null) return c.notFound()
		if (outcome.result === 'creator') {
			return c.json(
				{
					error: 'You created this club — delete it instead of leaving.',
					success: false,
					value: null,
				},
				403
			)
		}
		return c.json(outcome.club)
	})

export default app
