import { cloudflareTest } from '@cloudflare/vitest-pool-workers'
import { defineConfig } from 'vitest/config'

export default defineConfig({
	plugins: [
		cloudflareTest({
			wrangler: { configPath: `${__dirname}/wrangler.jsonc` },
			miniflare: {
				bindings: {
					ENVIRONMENT: 'VITEST',
					// `.dev.vars` is gitignored, so provide a deterministic signing key
					// for tests (and CI, which has no `.dev.vars`).
					JWT_SECRET: 'test-signing-key',
				},
			},
		}),
	],
})
