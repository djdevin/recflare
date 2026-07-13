import { Hono } from 'hono'

import { setDeviceId } from '@repo/domain'

import { authedId, unauthorized } from '../http'

import type { App } from '../context'

// ---- Player reporting ------------------------------------------------------
export const moderationRoutes = new Hono<App>({ strict: false })
	// Whether the caller is currently blocked (banned / timed out / host-kicked). No
	// ban storage yet, so this is always the "not blocked" answer. `ReportCategory` is
	// -1 (no category) rather than 0, which is a real category; `Message` is null, not
	// an empty string — the client distinguishes "no message" from a blank one.
	.get('/api/PlayerReporting/v1/moderationBlockDetails', (c) =>
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
	.get('/api/PlayerReporting/v1/voteToKickReasons', (c) => c.json([])) // TODO: hydrate from JSON/vtkreasons.json
	.post('/api/PlayerReporting/v1/hile', (c) => c.json(false))

	// The client reporting its device id (form-encoded `oldDeviceId`, `newDeviceId`,
	// `platform`), rotating from the id it thinks we hold to the current one. We don't
	// reconcile the two: the client is the only source for either, so a mismatch tells
	// us nothing and last write wins. `platform` is ignored — the account already
	// records the platform its login is linked to. Auth-gated; the client ignores the
	// response body, and the real service answers with an empty array.
	.post('/api/PlayerReporting/v1/deviceId', async (c) => {
		const id = await authedId(c)
		if (id === null) return unauthorized(c)
		const body = await c.req.parseBody().catch(() => ({}) as Record<string, unknown>)
		const newDeviceId = body.newDeviceId
		if (typeof newDeviceId !== 'string' || newDeviceId === '') {
			return c.json({ error: 'newDeviceId is required' }, 400)
		}
		await setDeviceId(c.env.DB, id, newDeviceId)
		return c.json([])
	})
