import { Command } from '@commander-js/extra-typings'
import { z } from 'zod'

import { getRepoRoot } from '../path'

const Env = z.object({
	/** Base domain that all service hosts are derived from, e.g. `rec.example.com`. */
	domain: z.string().min(1),
	/**
	 * Optional per-app subdomain overrides, keyed by the app's directory name.
	 * Defaults to the directory name when not set.
	 */
	subdomains: z.record(z.string(), z.string()).optional(),
})

type Edit = {
	label: string
	file: string
	/** Rewrites the file's derived values; a no-op when nothing needs changing. */
	transform: (text: string) => string
}

export const syncCmd = new Command('sync')
	.description('Sync generated config (wrangler routes, ns endpoints, etc.) from env.json')
	.option('--check', `Exit non-zero if any file is out of sync (don't write changes)`, false)
	.action(async ({ check }) => {
		const repoRoot = getRepoRoot()
		const env = Env.parse(await fs.readJson(path.join(repoRoot, 'env.json')))

		const edits: Edit[] = []

		// Worker custom-domain routes: `<subdomain>.<domain>`, derived from the app dir name.
		const wranglerConfigs = await glob('apps/*/wrangler.jsonc', { cwd: repoRoot, absolute: true })
		for (const file of wranglerConfigs.sort()) {
			const dir = path.basename(path.dirname(file))
			const subdomain = env.subdomains?.[dir] ?? dir
			const pattern = `${subdomain}.${env.domain}`
			edits.push({
				label: `apps/${dir}/wrangler.jsonc → ${pattern}`,
				file,
				// Only matches when the file has a route; otherwise leaves the file untouched.
				transform: (t) => t.replace(/("pattern":\s*")[^"]*(")/, `$1${pattern}$2`),
			})
		}

		// ns service-discovery document — every host is one of our own subdomains, so swap
		// the base domain while preserving each entry's subdomain label.
		const endpointsFile = path.join(repoRoot, 'apps/ns/static/endpoints.json')
		if (await fs.pathExists(endpointsFile)) {
			edits.push({
				label: 'apps/ns/static/endpoints.json',
				file: endpointsFile,
				transform: (t) =>
					t.replace(/("https:\/\/[a-z0-9-]+\.)[a-z0-9.-]+(")/g, `$1${env.domain}$2`),
			})
		}

		// Share-link base URL in the api worker's static config (only this one field is a
		// host of ours; other URLs in the file are third-party and must be left alone).
		const apiConfig = path.join(repoRoot, 'apps/api/static/api-config-v2.json')
		if (await fs.pathExists(apiConfig)) {
			edits.push({
				label: 'apps/api/static/api-config-v2.json (ShareBaseUrl)',
				file: apiConfig,
				transform: (t) =>
					t.replace(/("ShareBaseUrl":\s*"https:\/\/[a-z0-9-]+\.)[a-z0-9.-]+(\/)/, `$1${env.domain}$2`),
			})
		}

		const outOfSync: string[] = []
		for (const { label, file, transform } of edits) {
			const text = await fs.readFile(file, 'utf8')
			const next = transform(text)
			if (next === text) continue
			outOfSync.push(label)
			if (!check) await fs.writeFile(file, next)
		}

		if (outOfSync.length === 0) {
			echo(chalk.green('✓ generated config in sync'))
			return
		}

		if (check) {
			echo(chalk.red('✗ generated config out of sync. Run `just sync` to fix:'))
			for (const line of outOfSync) echo(`  ${line}`)
			process.exit(1)
		}

		echo(chalk.green(`✓ synced ${outOfSync.length} file(s):`))
		for (const line of outOfSync) echo(`  ${line}`)
	})
