import { PhotonImage, resize, SamplingFilter } from '@cf-wasm/photon'
import { Hono } from 'hono'
import { useWorkersLogger } from 'workers-tagged-logger'

import { withNotFound, withOnError } from '@repo/hono-helpers'

import type { App, Env } from './context'

/** Key id the client uses to look up the public half of the signing key. */
const SIGNATURE_KEY_ID = 'KEY:RSA:p1.rec.net'

/** Static asset served (200) when the requested key is missing from R2. */
const FALLBACK_ASSET_PATH = '/DefaultProfileImage.jpg'

/** Upper bound on a requested output dimension; guards against abuse. */
const MAX_DIMENSION = 4096

/** JPEG quality used when re-encoding a resized image. */
const RESIZE_JPEG_QUALITY = 90

/** A requested resize, from `?width=`/`?height=`. At least one is set. */
interface Transform {
	width?: number
	height?: number
}

/** Parse a positive-integer dimension query param, or `undefined` if invalid/absent. */
function parseDimension(value: string | undefined): number | undefined {
	if (value === undefined) return undefined
	const n = Number(value)
	if (!Number.isInteger(n) || n <= 0 || n > MAX_DIMENSION) return undefined
	return n
}

/** Build a `Transform` from the request query, or `null` when none is requested. */
function parseTransform(width: string | undefined, height: string | undefined): Transform | null {
	const w = parseDimension(width)
	const h = parseDimension(height)
	if (w === undefined && h === undefined) return null
	return { width: w, height: h }
}

/**
 * Decode `input`, resize (preserving aspect ratio when only one dimension is
 * given), and re-encode as JPEG. Runs the Photon WASM codec in-isolate — there
 * is no caching yet, so every request pays the full decode/resize/encode cost.
 */
function resizeImage(input: Uint8Array, transform: Transform): Uint8Array {
	const img = PhotonImage.new_from_byteslice(input)
	try {
		const srcW = img.get_width()
		const srcH = img.get_height()
		let { width, height } = transform
		if (width !== undefined && height === undefined) {
			height = Math.max(1, Math.round((srcH / srcW) * width))
		} else if (height !== undefined && width === undefined) {
			width = Math.max(1, Math.round((srcW / srcH) * height))
		}
		const resized = resize(img, width!, height!, SamplingFilter.Lanczos3)
		try {
			return resized.get_bytes_jpeg(RESIZE_JPEG_QUALITY)
		} finally {
			resized.free()
		}
	} finally {
		img.free()
	}
}

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
async function signImage(env: Env, bytes: BufferSource): Promise<string | null> {
	const key = await getSigningKey(env)
	if (!key) return null
	const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, bytes)
	let binary = ''
	for (const byte of new Uint8Array(sig)) binary += String.fromCharCode(byte)
	return btoa(binary)
}

/**
 * Given the full image bytes and prepared response `headers`, optionally resize
 * (Photon) and/or RSA-SHA1 sign (`?sig=p1`) before returning the `Response`.
 * Both operations need the whole body, so callers buffer before calling this.
 */
async function finalizeImage(
	env: Env,
	bytes: ArrayBuffer,
	headers: Headers,
	transform: Transform | null,
	wantsSignature: boolean
): Promise<Response> {
	let body: BufferSource = bytes
	if (transform) {
		body = resizeImage(new Uint8Array(bytes), transform)
		// Output is always JPEG, and the source etag no longer describes the body.
		headers.set('content-type', 'image/jpeg')
		headers.delete('etag')
	}

	if (wantsSignature) {
		const signature = await signImage(env, body)
		if (signature) {
			headers.set('content-signature', `key-id=${SIGNATURE_KEY_ID}; data=${signature}`)
		}
	}

	return new Response(body, { headers })
}

/**
 * Serve a static asset `Response` with our standard cache headers, honouring
 * `?width`/`?height` (resize) and `?sig=p1` (signing). Either requires the full
 * body, so the asset is buffered; otherwise it is streamed through untouched.
 */
async function serveStaticAsset(
	env: Env,
	asset: Response,
	transform: Transform | null,
	wantsSignature: boolean
): Promise<Response> {
	const headers = new Headers()
	const contentType = asset.headers.get('content-type')
	if (contentType) headers.set('content-type', contentType)
	headers.set('cache-control', 'public, max-age=3600')

	if (transform || wantsSignature) {
		const bytes = await asset.arrayBuffer()
		return finalizeImage(env, bytes, headers, transform, wantsSignature)
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
		const transform = parseTransform(c.req.query('width'), c.req.query('height'))

		// Prefer a bundled static asset when one exists for this key, before hitting
		// R2. This lets us ship canonical images (e.g. room thumbnails in `static/`)
		// that always win over whatever, if anything, is in the bucket.
		const staticAsset = await c.env.ASSETS.fetch(new URL(`/${key}`, c.req.url))
		if (staticAsset.ok) {
			return serveStaticAsset(c.env, staticAsset, transform, wantsSignature)
		}

		// Conditional requests only make sense for the untransformed object: a
		// resized response carries no etag, so the client can never send a matching
		// one. Skip the precondition when a transform is requested.
		const ifNoneMatch = transform ? undefined : c.req.header('if-none-match')?.replace(/"/g, '')
		const object = await c.env.IMAGES.get(
			key,
			ifNoneMatch ? { onlyIf: { etagDoesNotMatch: ifNoneMatch } } : undefined
		)
		if (!object) {
			// Missing from both static and R2 → serve the bundled DefaultProfileImage.jpg
			// static asset so clients still get a valid image instead of a 404. Honour
			// `?sig=p1` the same way so signed clients can verify the fallback.
			const asset = await c.env.ASSETS.fetch(new URL(FALLBACK_ASSET_PATH, c.req.url))
			return serveStaticAsset(c.env, asset, transform, wantsSignature)
		}

		const headers = new Headers()
		object.writeHttpMetadata(headers)
		headers.set('etag', object.httpEtag)
		headers.set('cache-control', 'public, max-age=3600')

		// Precondition matched (If-None-Match) → R2 returns no body.
		if (!('body' in object)) return new Response(null, { status: 304, headers })

		if (transform || wantsSignature) {
			const bytes = await object.arrayBuffer()
			return finalizeImage(c.env, bytes, headers, transform, wantsSignature)
		}

		return new Response(object.body, { headers })
	})

export default app
