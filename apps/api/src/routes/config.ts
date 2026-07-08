import { Hono } from 'hono'

import apiConfigV2 from '../../static/api-config-v2.json'
import gameConfigsV1All from '../../static/gameconfigs-v1-all.json'

import type { App } from '../context'

// ---- Config / version ------------------------------------------------------
export const configRoutes = new Hono<App>({ strict: false })
	.get('/api/config/v1/amplitude', (c) =>
		c.json({
			AmplitudeKey: 'a',
			StatSigKey: 'a',
			RudderStackKey: 'a',
			UseRudderStack: false,
		})
	)
	.get('/api/config/v1/azurespeech', (c) =>
		c.json({
			Key: 'dce8de5b297747d9b5bddcc7f19e8c5b',
			Region: 'eastus',
			Enabled: false,
		})
	)
	.get('/api/config/v1/backtrace', (c) =>
		c.json({
			ReportBudget: 125,
			FilterType: 0,
			SampleRate: 1,
			LogLineCount: 50,
			CaptureNativeCrashes: 1,
			AMRThresholdMS: 0,
			MessageCount: 1000,
			MessageRegex:
				"^.*$",
			VersionRegex: '.*',
		})
	)
	// ShareBaseUrl is derived from the deploy-time base domain; the rest of the
	// config is static.
	.get('/api/config/v2', (c) =>
		c.json({ ...apiConfigV2, ShareBaseUrl: `https://www.${c.env.DOMAIN}/{0}` })
	)
	.get('/api/versioncheck/v4', (c) =>
		c.json({
			VersionStatus: 0,
			UpdateNotificationStage: 0,
			IsVersionIslanded: false,
			IsCrossPlayDisabled: false,
		})
	)
	.get('/api/gameconfigs/v1/all', (c) => c.json(gameConfigsV1All))

	// Voice chat config. The client fetches it to set up voice.
	// No reference shape, so return an empty object until the client needs fields.
	.get('/voice/config', (c) => c.json({}))
