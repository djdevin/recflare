import type { Env } from './context'

/**
 * Aggregated API docs, served on www at `/docs`.
 *
 * www is already a backend-for-frontend that reaches the other workers server-side
 * (see upstream.ts), so it can serve every worker's OpenAPI spec same-origin — the
 * browser only ever talks to www, and there's no cross-origin/CORS problem even though
 * the specs live on separate subdomains. The Scalar UI (a self-hosted asset, see the
 * vite plugin in vite.config.ts) fetches each spec from `/docs/openapi/{service}.json`,
 * which this module proxies to `https://{service}.<DOMAIN>/openapi.json`.
 */

/**
 * The workers whose `/openapi.json` we aggregate. Single source of truth: the docs
 * page's Scalar sources and the `/docs/openapi/:service` proxy allowlist are both built
 * from this, so they can never drift. Add a worker here once it serves `/openapi.json`.
 */
export const DOCUMENTED_SERVICES: ReadonlyArray<{ slug: string; title: string }> = [
	{ slug: 'auth', title: 'auth — authentication & tokens' },
	{ slug: 'accounts', title: 'accounts — profiles & lookups' },
	{ slug: 'match', title: 'match — matchmaking & presence' },
	{ slug: 'econ', title: 'econ — avatar & economy' },
]

/** Path (served as a static asset) of the self-hosted Scalar standalone bundle. */
const SCALAR_ASSET = '/docs/scalar.standalone.js'

/**
 * The upstream `/openapi.json` URL for a service, derived from the shared base domain
 * the same way upstream.ts derives the auth/accounts hosts.
 */
export function specUpstream(env: Env, slug: string): string {
	return `https://${slug}.${env.DOMAIN}/openapi.json`
}

/**
 * Proxy a documented worker's `/openapi.json` back to the browser, same-origin. Returns
 * null for a service that isn't in the allowlist so the caller can 404 — this keeps the
 * route from being turned into an open proxy to `https://<anything>.<DOMAIN>`.
 */
export async function fetchSpec(env: Env, slug: string): Promise<Response | null> {
	if (!DOCUMENTED_SERVICES.some((s) => s.slug === slug)) return null
	const upstream = await fetch(specUpstream(env, slug))
	// Re-wrap so we control the content type and don't forward upstream headers verbatim.
	return new Response(upstream.body, {
		status: upstream.status,
		headers: { 'content-type': 'application/json; charset=utf-8' },
	})
}

/**
 * The `/docs` HTML page. Mounts the self-hosted Scalar UI with one source per
 * documented service (a dropdown to switch between them). Built from
 * DOCUMENTED_SERVICES so it stays in sync with the proxy.
 */
export function docsPage(): string {
	const sources = DOCUMENTED_SERVICES.map((s) => ({
		url: `/docs/openapi/${s.slug}.json`,
		title: s.title,
		slug: s.slug,
	}))
	// The config is inlined as JSON — the slugs/titles are static constants, not user
	// input, so there's nothing to escape here.
	const config = JSON.stringify({ sources })
	return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>recflare API docs</title>
</head>
<body>
<div id="app"></div>
<script src="${SCALAR_ASSET}"></script>
<script>
	Scalar.createApiReference('#app', ${config})
</script>
</body>
</html>`
}
