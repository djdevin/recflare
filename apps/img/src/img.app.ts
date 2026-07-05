import { Hono } from 'hono'
import { useWorkersLogger } from 'workers-tagged-logger'

import { withNotFound, withOnError } from '@repo/hono-helpers'

import type { App, Env } from './context'

/** Key id the client uses to look up the public half of the signing key. */
const SIGNATURE_KEY_ID = 'KEY:RSA:p1.rec.net'

/** Static asset served (200) when the requested key is missing from R2. */
const FALLBACK_ASSET_PATH = '/DefaultProfileImage.jpg'

// Import the signing key once per isolate. The key material is constant for the
// lifetime of the Worker, so caching the promise is safe.
let signingKey: Promise<CryptoKey | null> | undefined

function getSigningKey(env: Env): Promise<CryptoKey | null> {
	if (signingKey === undefined) {
		signingKey = (async () => {
			if (!env.IMG_SIGNING_KEY) return null
			const der = Uint8Array.from(atob(env.IMG_SIGNING_KEY), (ch) => ch.charCodeAt(0))
			return crypto.subtle.importKey(
				'pkcs8',
				der,
				{ name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-1' },
				false,
				['sign']
			)
		})()
	}
	return signingKey
}

/** RSA-SHA1 sign the bytes, base64-encoded. */
async function signImage(env: Env, bytes: ArrayBuffer): Promise<string | null> {
	const key = await getSigningKey(env)
	if (!key) return null
	const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, bytes)
	let binary = ''
	for (const byte of new Uint8Array(sig)) binary += String.fromCharCode(byte)
	return btoa(binary)
}

/**
 * Serve a static asset `Response` with our standard cache headers, honouring
 * `?sig=p1` by RSA-SHA1 signing the (buffered) body into `Content-Signature`.
 */
async function serveStaticAsset(
	env: Env,
	asset: Response,
	wantsSignature: boolean
): Promise<Response> {
	const headers = new Headers()
	const contentType = asset.headers.get('content-type')
	if (contentType) headers.set('content-type', contentType)
	headers.set('cache-control', 'public, max-age=3600')

	if (wantsSignature) {
		const bytes = await asset.arrayBuffer()
		const signature = await signImage(env, bytes)
		if (signature) {
			headers.set('content-signature', `key-id=${SIGNATURE_KEY_ID}; data=${signature}`)
		}
		return new Response(bytes, { headers })
	}

	return new Response(asset.body, { headers })
}

const app = new Hono<App>()
	.use(
		'*',
		// middleware
		(c, next) =>
			useWorkersLogger(c.env.NAME, {
				environment: c.env.ENVIRONMENT,
				release: c.env.SENTRY_RELEASE,
			})(c, next)
	)

	.onError(withOnError())
	.notFound(withNotFound())

	.get('/', (c) => c.json({ service: 'img', status: 'ok' }))

	// Stream an image straight from the R2 bucket by key, e.g.
	// `GET /DefaultProfileImage.jpg`. The key may contain slashes for nested
	// objects. Supports conditional requests via If-None-Match.
	//
	// When the client appends `?sig=p1`, the response body is RSA-SHA1 signed and
	// the signature returned in a `Content-Signature` header. Signing requires the
	// full body, so the object is buffered.
	.get('/:key{.+}', async (c) => {
		const key = c.req.param('key')
		if (key.includes('..')) return c.body(null, 400)

		const wantsSignature = c.req.query('sig') === 'p1'

		// Prefer a bundled static asset when one exists for this key, before hitting
		// R2. This lets us ship canonical images (e.g. room thumbnails in `static/`)
		// that always win over whatever, if anything, is in the bucket.
		const staticAsset = await c.env.ASSETS.fetch(new URL(`/${key}`, c.req.url))
		if (staticAsset.ok) {
			return serveStaticAsset(c.env, staticAsset, wantsSignature)
		}

		const ifNoneMatch = c.req.header('if-none-match')?.replace(/"/g, '')
		const object = await c.env.IMAGES.get(
			key,
			ifNoneMatch ? { onlyIf: { etagDoesNotMatch: ifNoneMatch } } : undefined
		)
		if (!object) {
			// Missing from both static and R2 → serve the bundled DefaultProfileImage.jpg
			// static asset so clients still get a valid image instead of a 404. Honour
			// `?sig=p1` the same way so signed clients can verify the fallback.
			const asset = await c.env.ASSETS.fetch(new URL(FALLBACK_ASSET_PATH, c.req.url))
			return serveStaticAsset(c.env, asset, wantsSignature)
		}

		const headers = new Headers()
		object.writeHttpMetadata(headers)
		headers.set('etag', object.httpEtag)
		headers.set('cache-control', 'public, max-age=3600')

		// Precondition matched (If-None-Match) → R2 returns no body.
		if (!('body' in object)) return new Response(null, { status: 304, headers })

		if (wantsSignature) {
			const bytes = await object.arrayBuffer()
			const signature = await signImage(c.env, bytes)
			if (signature) {
				headers.set('content-signature', `key-id=${SIGNATURE_KEY_ID}; data=${signature}`)
			}
			return new Response(bytes, { headers })
		}

		return new Response(object.body, { headers })
	})

export default app
