import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, resolve } from 'node:path'
import { cloudflare } from '@cloudflare/vite-plugin'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

import type { Plugin } from 'vite'

/**
 * Self-host the Scalar API-reference UI used by the `/docs` page (see src/docs.ts),
 * instead of loading it from a CDN. Scalar's standalone browser bundle is emitted into
 * the client build at `docs/scalar.standalone.js`, so it's served as a same-origin
 * static asset pinned to the installed @scalar/api-reference version.
 *
 * The package doesn't export the standalone subpath, so resolve the package entry and
 * reach its sibling `browser/standalone.js`. Only the client build serves browser
 * assets, so skip the worker build's bundle.
 */
function scalarStandalone(): Plugin {
	const require = createRequire(import.meta.url)
	return {
		name: 'scalar-standalone',
		async generateBundle() {
			if (this.environment.name !== 'client') return
			const entry = require.resolve('@scalar/api-reference') // dist/index.js
			const standalone = resolve(dirname(entry), 'browser/standalone.js')
			this.emitFile({
				type: 'asset',
				fileName: 'docs/scalar.standalone.js',
				source: await readFile(standalone),
			})
		},
	}
}

export default defineConfig({
	plugins: [react(), cloudflare(), scalarStandalone()],
})
