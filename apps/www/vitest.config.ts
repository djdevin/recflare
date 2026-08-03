import { cloudflareTest } from '@cloudflare/vitest-pool-workers'
import { defineConfig } from 'vitest/config'

export default defineConfig({
	plugins: [
		cloudflareTest({
			wrangler: { configPath: `${__dirname}/wrangler.jsonc` },
			miniflare: {
				bindings: {
					ENVIRONMENT: 'VITEST',
					// The Turnstile keypair is NOT bound here: both keys come from the Secrets
					// Store now, and the tests seed the local store with the test pair (see
					// src/test/integration/api.test.ts). A plain binding of the same name would
					// shadow the store binding with a string.
				},
			},
		}),
	],
})
