import { cloudflareTest } from '@cloudflare/vitest-pool-workers'
import { defineConfig } from 'vitest/config'

export default defineConfig({
	plugins: [
		cloudflareTest({
			wrangler: { configPath: `${__dirname}/wrangler.jsonc` },
			miniflare: {
				bindings: {
					ENVIRONMENT: 'VITEST',
				},
				// The worker's RECFLARE_NOTIFICATIONS_HUB binding points at the `notify`
				// worker's DO (script_name: "notify"). That worker isn't part of this
				// isolated test, so provide a minimal stub exposing the same NotificationsHub
				// RPC surface. This one also records what it was sent and hands it back via
				// `takeSent`, so tests can assert on the ChatMessageReceived fan-out.
				workers: [
					{
						name: 'notify',
						modules: true,
						compatibilityDate: '2026-06-16',
						compatibilityFlags: ['nodejs_compat'],
						durableObjects: { RECFLARE_NOTIFICATIONS_HUB: 'NotificationsHub' },
						script: `
							import { DurableObject } from 'cloudflare:workers'
							export class NotificationsHub extends DurableObject {
								constructor(ctx, env) {
									super(ctx, env)
									this.sent = []
								}
								async notifyPlayer(playerId, notificationType, data) {
									this.sent.push({ playerId, notificationType, data })
									return { delivered: 1, queued: false }
								}
								async broadcast() { return { delivered: 0 } }
								async takeSent() {
									const sent = this.sent
									this.sent = []
									return sent
								}
							}
							export default { fetch() { return new Response('ok') } }
						`,
					},
				],
			},
		}),
	],
})
