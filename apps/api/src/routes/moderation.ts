import { Hono } from 'hono'

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
	// `platform`), rotating from the id it thinks we hold to the current one. Carries no
	// bearer token and fires before account creation, so there is no caller to attribute
	// the id to and nothing to store it against — we accept it and drop it. The real
	// service answers with a `{ success, error }` envelope.
	// @todo This doesn't do anything, in fact it breaks the client during account creation.
	// I have not been able to find a response shape that doesn't break, so in
	// https://github.com/djdevin/recnet-plugin we disable the device ID check to enable
	// account creation. Nothing in the logs, client just hangs, who knows what it is
	// waiting for.
	.post('/api/PlayerReporting/v1/deviceId', (c) => c.json([]));
