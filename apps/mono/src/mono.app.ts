/**
 * Combined ("facade") worker.
 *
 * Mounts each RecFlare worker inside a single deployable Worker WITHOUT modifying the
 * originals: every app is imported by relative path and bundled by esbuild at build
 * time. Production routing mirrors the split deployment — requests are dispatched on
 * the request's subdomain (`accounts.<domain>` -> the `accounts` app), so the sub-app
 * paths (and therefore the client contract) are untouched.
 *
 * Local dev has no subdomain, so pick a service explicitly with the
 * `X-Recflare-Service` header or an `?__svc=` query param, e.g.
 *   curl -H 'X-Recflare-Service: accounts' http://localhost:8787/health
 *
 * NOT mounted here: `www`, `img`, `econ`. Each binds a static `assets` directory and
 * Cloudflare allows only one static-assets binding per Worker. Resolve that (serve
 * their static trees from R2, or keep those three as their own Workers) before adding.
 */
import accounts from '../../accounts/src/accounts.app'
import api from '../../api/src/api.app'
import auth from '../../auth/src/auth.app'
import cdn from '../../cdn/src/cdn.app'
import chat from '../../chat/src/chat.app'
import clubs from '../../clubs/src/clubs.app'
import commerce from '../../commerce/src/commerce.app'
import { app as match, scheduled as matchScheduled } from '../../match/src/match.app'
import notify from '../../notify/src/notify.app'
import ns from '../../ns/src/ns.app'
import playersettings from '../../playersettings/src/playersettings.app'
import rooms from '../../rooms/src/rooms.app'
import storage from '../../storage/src/storage.app'

import type { Env } from './context'

// The Notifications Durable Object is defined in `notify`; re-export it so this worker
// owns the class its wrangler.jsonc binds and migrates (bound in-process, no script_name).
export { NotificationsHub } from '../../notify/src/notifications-hub'

/** Anything that can handle a fetch with this worker's (superset) Env. */
type Mounted = {
	fetch(request: Request, env: Env, ctx: ExecutionContext): Response | Promise<Response>
}

/**
 * Subdomain -> mounted app. Keys must match the `<sub>` in `<sub>.<domain>` from the
 * `ns` service-discovery document so production host-based routing lines up.
 */
const services = {
	accounts,
	api,
	auth,
	cdn,
	chat,
	clubs,
	commerce,
	match,
	notify,
	ns,
	playersettings,
	rooms,
	storage,
} satisfies Record<string, Mounted>

type ServiceName = keyof typeof services

function resolveService(request: Request): ServiceName | undefined {
	const url = new URL(request.url)

	// Local-dev / explicit override (localhost has no service subdomain).
	const override = request.headers.get('x-recflare-service') ?? url.searchParams.get('__svc')
	if (override !== null && override in services) return override as ServiceName

	// Production: dispatch on the leftmost DNS label — accounts.<domain> -> accounts.
	const sub = url.hostname.split('.')[0]
	if (sub in services) return sub as ServiceName

	return undefined
}

export default {
	fetch(request: Request, env: Env, ctx: ExecutionContext): Response | Promise<Response> {
		const name = resolveService(request)
		if (name === undefined) {
			return Response.json(
				{
					error: 'unknown_service',
					hint: 'Route by subdomain (<service>.<domain>). In local dev set the X-Recflare-Service header or ?__svc= query.',
					services: Object.keys(services),
				},
				{ status: 404 }
			)
		}
		return services[name].fetch(request, env, ctx)
	},

	// Only `match` runs a cron in the split deployment; this worker owns its presence sweep.
	scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> | void {
		return matchScheduled(controller, env, ctx)
	},
} satisfies ExportedHandler<Env>
