import { Hono } from 'hono'
import { describeRoute } from 'hono-openapi'

import {
	BareBoolean,
	DeviceIdRequest,
	form,
	json,
	JsonArray,
	ModerationBlockDetails,
} from '../openapi'

import type { App } from '../context'

// ---- Player reporting ------------------------------------------------------
export const moderationRoutes = new Hono<App>({ strict: false })
	// Whether the caller is currently blocked (banned / timed out / host-kicked). No
	// ban storage yet, so this is always the "not blocked" answer. `ReportCategory` is
	// -1 (no category) rather than 0, which is a real category; `Message` is null, not
	// an empty string — the client distinguishes "no message" from a blank one.
	.get(
		'/api/PlayerReporting/v1/moderationBlockDetails',
		describeRoute({
			tags: ['Moderation'],
			summary: 'Whether the caller is blocked',
			description:
				'Ban / timeout / host-kick state for the caller. There is no ban storage yet, so ' +
				'this is always the “not blocked” answer. Two details matter to the client: ' +
				'`ReportCategory` is -1 (no category) rather than 0, which is a real category, and ' +
				'`Message` is null rather than an empty string — the client distinguishes “no ' +
				'message” from a blank one.',
			responses: { 200: json(ModerationBlockDetails, 'Always “not blocked”') },
		}),
		(c) =>
			c.json({
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
	)
	.get(
		'/api/PlayerReporting/v1/voteToKickReasons',
		describeRoute({
			tags: ['Moderation'],
			summary: 'Vote-to-kick reasons',
			description:
				'The reasons offered when starting a vote-to-kick. Not hydrated yet, so the list ' +
				'is empty.',
			responses: { 200: json(JsonArray, 'An empty list') },
		}),
		(c) => c.json([])
	) // TODO: hydrate from JSON/vtkreasons.json
	.post(
		'/api/PlayerReporting/v1/hile',
		describeRoute({
			tags: ['Moderation'],
			summary: 'Report submission sink',
			description:
				'A player report. Nothing stores reports, so this accepts whatever it is sent and ' +
				'answers a bare `false`.',
			responses: { 200: json(BareBoolean, 'A bare JSON `false`') },
		}),
		(c) => c.json(false)
	)

	// The client reporting its device id (form-encoded `oldDeviceId`, `newDeviceId`,
	// `platform`), rotating from the id it thinks we hold to the current one. Carries no
	// bearer token and fires before account creation, so there is no caller to attribute
	// the id to and nothing to store it against — we accept it and drop it. The real
	// service answers with a `{ success, error }` envelope.
	// @todo This doesn't do anything, in fact it breaks the client during account creation.
	// I have not been able to find a response shape that doesn't break, so in
	// https://github.com/djdevin/recnet-plugin we disable the device ID check to enable
	// account creation. Nothing in the logs, client just hangs, who knows what it is
	// waiting for.
	.post(
		'/api/PlayerReporting/v1/deviceId',
		describeRoute({
			tags: ['Moderation'],
			summary: 'Device id rotation (known broken)',
			description:
				'The client reporting its device id, rotating from the one it thinks we hold to ' +
				'the current one. It carries no bearer token and fires *before* account creation, ' +
				'so there is no caller to attribute the id to and nothing to store it against — ' +
				'we accept it and drop it.\n\n' +
				'**Known broken.** No response shape found so far keeps the client happy: it ' +
				'hangs during account creation with nothing in the logs. The real service answers ' +
				'a `{ success, error }` envelope; we currently answer an empty array, which does ' +
				'not help either. The workaround is to disable the device-id check client-side ' +
				'(see [recnet-plugin](https://github.com/djdevin/recnet-plugin)).',
			requestBody: form(DeviceIdRequest, 'The id rotation'),
			responses: {
				200: json(JsonArray, 'An empty array — see the note above; this is not the real shape'),
			},
		}),
		(c) => c.json([])
	)
