import { crop, PhotonImage, resize, SamplingFilter } from '@cf-wasm/photon'
import { Hono } from 'hono'
import { describeRoute, openAPIRouteHandler } from 'hono-openapi'
import { useWorkersLogger } from 'workers-tagged-logger'

import { withCleanSpec, withNotFound, withOnError } from '@repo/hono-helpers'

import { imageBytes, json, ServiceStatus } from './openapi'

import type { App, Env } from './context'

/** Key id the client uses to look up the public half of the signing key. */
const SIGNATURE_KEY_ID = 'KEY:RSA:p1.rec.net'

/** Static asset served (200) when the requested key is missing from R2. */
const FALLBACK_ASSET_PATH = '/DefaultProfileImage.jpg'

/**
 * Cache-Control for served images. Uploaded images are immutable once written,
 * so cache for a year and mark `immutable` so browsers never revalidate. A new
 * image simply uses a new key.
 */
const CACHE_CONTROL = 'public, max-age=31536000, immutable'

/**
 * Allowed output dimensions. Restricting resizes to a small fixed set caps the
 * number of distinct variants an attacker can request, so they can't blow past
 * the edge cache and force the (expensive) WASM resize on every hit.
 */
const ALLOWED_DIMENSIONS = new Set([128, 256, 512, 1024])

/** JPEG quality used when re-encoding a resized image. */
const RESIZE_JPEG_QUALITY = 90

/** A requested transform, from `?width=`/`?height=`/`?cropSquare=1`. At least one applies. */
interface Transform {
	width?: number
	height?: number
	/** Center-crop the source to a square before resizing (`?cropSquare=1`). */
	cropSquare: boolean
}

/** Parse a dimension query param, or `undefined` if absent or not an allowed size. */
function parseDimension(value: string | undefined): number | undefined {
	if (value === undefined) return undefined
	const n = Number(value)
	if (!Number.isInteger(n) || !ALLOWED_DIMENSIONS.has(n)) return undefined
	return n
}

/** Build a `Transform` from the request query, or `null` when none is requested. */
function parseTransform(
	width: string | undefined,
	height: string | undefined,
	cropSquare: string | undefined
): Transform | null {
	const w = parseDimension(width)
	const h = parseDimension(height)
	const square = cropSquare === '1'
	if (w === undefined && h === undefined && !square) return null
	return { width: w, height: h, cropSquare: square }
}

/**
 * Decode `input`, apply the requested transform (optional center-crop to a
 * square, then resize preserving aspect ratio when only one dimension is given),
 * and re-encode as JPEG. Runs the Photon WASM codec in-isolate; edge caching
 * (see `wrangler.jsonc`) means each variant only pays this cost once.
 */
function resizeImage(input: Uint8Array, transform: Transform): Uint8Array {
	let img = PhotonImage.new_from_byteslice(input)
	// Every PhotonImage we allocate (source + each stage) must be freed.
	const owned = [img]
	try {
		if (transform.cropSquare) {
			const w = img.get_width()
			const h = img.get_height()
			const side = Math.min(w, h)
			const x = Math.floor((w - side) / 2)
			const y = Math.floor((h - side) / 2)
			img = crop(img, x, y, x + side, y + side)
			owned.push(img)
		}

		let { width, height } = transform
		if (width !== undefined || height !== undefined) {
			const srcW = img.get_width()
			const srcH = img.get_height()
			if (width !== undefined && height === undefined) {
				height = Math.max(1, Math.round((srcH / srcW) * width))
			} else if (height !== undefined && width === undefined) {
				width = Math.max(1, Math.round((srcW / srcH) * height))
			}
			img = resize(img, width!, height!, SamplingFilter.Lanczos3)
			owned.push(img)
		}

		return img.get_bytes_jpeg(RESIZE_JPEG_QUALITY)
	} finally {
		for (const image of owned) image.free()
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
	headers.set('cache-control', CACHE_CONTROL)

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

	.get(
		'/',
		describeRoute({
			tags: ['Images'],
			summary: 'Service status',
			description: 'Liveness probe. Always `{ service: "img", status: "ok" }`.',
			responses: { 200: json(ServiceStatus, 'The worker is up') },
		}),
		(c) => c.json({ service: 'img', status: 'ok' })
	)

// The generated spec. Documentation only — no request is validated against it (see
// openapi.ts). `hide: true` keeps this route out of its own output.
//
// Registered BEFORE the `/:key{.+}` catch-all below: that route matches every path and
// always returns a Response (the DefaultProfileImage.jpg fallback when nothing is
// stored), so anything declared after it is unreachable. The spec is still complete —
// `openAPIRouteHandler` walks `app.routes` at request time, after the catch-all has
// been registered.
app.get(
	'/openapi.json',
	describeRoute({ hide: true }),
	withCleanSpec(
		openAPIRouteHandler(app, {
			documentation: {
				info: {
					title: 'recflare img',
					version: '1.0.0',
					description: [
						'Image hosting for recflare, a private-server reimplementation of the Rec Room',
						'backend. Serves every image the client renders — profile photos, room thumbnails,',
						'club banners and the photo feed — from an R2 bucket, with bundled static assets',
						'(`static/`) taking precedence over the bucket and `DefaultProfileImage.jpg` served',
						'as the fallback when a key is missing. Optional on-the-fly center-crop and resize',
						'run through the Photon WASM codec; `?sig=p1` adds the RSA-SHA1 `Content-Signature`',
						'header the client verifies against `KEY:RSA:p1.rec.net`.',
						'',
						'Note that this worker only serves bytes: the image metadata the client lists (the',
						'`SavedImage` records behind `/api/images/...`) lives in the `api` worker, which',
						'points at keys here.',
					].join('\n'),
				},
				servers: [{ url: 'https://img.recflare.net', description: 'Production' }],
			},
		})
	)
)

// Stream an image straight from the R2 bucket by key, e.g.
// `GET /DefaultProfileImage.jpg`. The key may contain slashes for nested
// objects. Supports conditional requests via If-None-Match.
//
// When the client appends `?sig=p1`, the response body is RSA-SHA1 signed and
// the signature returned in a `Content-Signature` header. Signing requires the
// full body, so the object is buffered.
app.get(
	'/:key{.+}',
	describeRoute({
		tags: ['Images'],
		summary: 'Serve an image by key',
		description: [
			'Serves the image stored under `key`, which may contain slashes for nested objects',
			'(e.g. `Base/Clearcut.jpg`). A bundled static asset always wins over an R2 object of',
			'the same key; when neither exists the bundled `DefaultProfileImage.jpg` is served',
			'with a 200 rather than a 404, so the client never renders a broken image.',
			'',
			'Responses carry `Cache-Control: public, max-age=31536000, immutable` — an uploaded',
			'image is never rewritten in place, a new image gets a new key.',
			'',
			'`?width`/`?height`/`?cropSquare=1` run the body through the Photon codec and always',
			'return JPEG with no `ETag` (the source etag no longer describes the body), and the',
			'`If-None-Match` precondition is skipped. An out-of-range or non-integer dimension is',
			'ignored and the original is served — never an error.',
		].join('\n'),
		parameters: [
			{
				name: 'key',
				in: 'path',
				required: true,
				description: 'Object key; may contain slashes. A key containing `..` is rejected (400).',
				schema: { type: 'string' },
			},
			{
				name: 'width',
				in: 'query',
				required: false,
				description: [
					'Output width. Only 128, 256, 512 or 1024 are honoured — any other value is',
					'ignored and the source served untouched. Given alone, height follows the aspect ratio.',
				].join(' '),
				schema: { type: 'integer', enum: [128, 256, 512, 1024], example: 512 },
			},
			{
				name: 'height',
				in: 'query',
				required: false,
				description:
					'Output height, same allowed set as `width`. Given alone, width follows the aspect ratio.',
				schema: { type: 'integer', enum: [128, 256, 512, 1024], example: 512 },
			},
			{
				name: 'cropSquare',
				in: 'query',
				required: false,
				description: [
					'`1` center-crops the source to a square before any resize. Used for the square',
					'profile/thumbnail slots. Any other value is ignored.',
				].join(' '),
				schema: { type: 'string', enum: ['1'] },
			},
			{
				name: 'sig',
				in: 'query',
				required: false,
				description: [
					'`p1` RSA-SHA1 signs the response body and returns it as',
					'`Content-Signature: key-id=KEY:RSA:p1.rec.net; data=<base64>`. Signed over the',
					'bytes actually returned, i.e. the resized body when a transform applies. Omitted',
					'when the worker has no `IMG_SIGNING_KEY`.',
				].join(' '),
				schema: { type: 'string', enum: ['p1'] },
			},
			{
				name: 'If-None-Match',
				in: 'header',
				required: false,
				description:
					'Conditional request against the R2 object etag. Ignored when a transform is requested.',
				schema: { type: 'string' },
			},
		],
		responses: {
			200: imageBytes('The image bytes (or the DefaultProfileImage.jpg fallback)'),
			304: { description: 'If-None-Match matched the stored object etag; no body' },
			400: { description: 'The key contained `..`; no body' },
		},
	}),
	async (c) => {
		const key = c.req.param('key')
		if (key.includes('..')) return c.body(null, 400)

		const wantsSignature = c.req.query('sig') === 'p1'
		const transform = parseTransform(
			c.req.query('width'),
			c.req.query('height'),
			c.req.query('cropSquare')
		)

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
		headers.set('cache-control', CACHE_CONTROL)

		// Precondition matched (If-None-Match) → R2 returns no body.
		if (!('body' in object)) return new Response(null, { status: 304, headers })

		if (transform || wantsSignature) {
			const bytes = await object.arrayBuffer()
			return finalizeImage(c.env, bytes, headers, transform, wantsSignature)
		}

		return new Response(object.body, { headers })
	}
)

export default app
