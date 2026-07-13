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
