import { cloudflareTest } from '@cloudflare/vitest-pool-workers'
import { defineConfig } from 'vitest/config'

export default defineConfig({
	plugins: [
		cloudflareTest({
			wrangler: { configPath: `${__dirname}/wrangler.jsonc` },
			miniflare: {
				bindings: {
					ENVIRONMENT: 'VITEST',
					// Turnstile's documented always-passes test keypair, standing in for the two
					// worker secrets a deployed www carries. They're what OPENS signup (see
					// src/turnstile.ts), so without them every signup test would just be testing
					// the closed door.
					TURNSTILE_SITE_KEY: '1x00000000000000000000AA',
					TURNSTILE_SECRET_KEY: '1x0000000000000000000000000000000AA',
				},
			},
		}),
	],
})
