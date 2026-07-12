import { Hono } from 'hono'
import { useWorkersLogger } from 'workers-tagged-logger'

import { withNotFound, withOnError } from '@repo/hono-helpers'

import loadingScreenTipData from '../static/loading-screen-tip-data.json'

import type { Context } from 'hono'
import type { App, Env } from './context'

/**
 * CDN routes. The `cdn` prefix maps to this worker's subdomain, so method routes
 * are served bare. File-backed routes (`sigs`, `upload`) have no storage binding
 * yet and are stubbed.
 */

/** Parse a single-range `Range: bytes=start-end` header into an R2 range. */
function parseRange(header: string | undefined): R2Range | undefined {
	if (!header) return undefined
	const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim())
	if (!m) return undefined
	const start = m[1]
	const end = m[2]
	if (start === '' && end !== '') return { suffix: Number(end) } // last N bytes
	if (start !== '') {
		return end !== ''
			? { offset: Number(start), length: Number(end) - Number(start) + 1 }
			: { offset: Number(start) }
	}
	return undefined
}

/**
 * Stream a binary asset from the CDN R2 bucket as application/octet-stream,
 * honoring Range requests. 404s when the file is missing.
 * Supports conditional GET and byte-range requests (206) — large-file
 * downloaders fetch in ranges, and a 200 where a 206 is expected corrupts the
 * reassembled file (e.g. EAC "Signatures don't match").
 */
async function serveAsset(c: Context<App>, key: string) {
	if (key.includes('..')) return c.body(null, 400)

	const ifNoneMatch = c.req.header('if-none-match')?.replace(/"/g, '')
	const range = parseRange(c.req.header('range'))
	const object = await (c.env as Env).CDN_ASSETS.get(key, {
		...(ifNoneMatch ? { onlyIf: { etagDoesNotMatch: ifNoneMatch } } : {}),
		...(range ? { range } : {}),
	})
	if (!object) return c.notFound()

	const headers = new Headers()
	object.writeHttpMetadata(headers)
	headers.set('etag', object.httpEtag)
	headers.set('content-type', 'application/octet-stream')
	headers.set('accept-ranges', 'bytes')
	headers.set('cache-control', 'public, max-age=3600')

	// Precondition matched (If-None-Match) → R2 returns no body.
	if (!('body' in object)) return new Response(null, { status: 304, headers })

	// Range honored → 206 Partial Content with Content-Range.
	if (object.range && c.req.header('range')) {
		const r = object.range
		let offset: number
		let length: number
		if ('suffix' in r) {
			length = r.suffix
			offset = object.size - length
		} else {
			offset = r.offset ?? 0
			length = r.length ?? object.size - offset
		}
		headers.set('content-length', String(length))
		headers.set('content-range', `bytes ${offset}-${offset + length - 1}/${object.size}`)
		return new Response(object.body, { status: 206, headers })
	}

	return new Response(object.body, { headers })
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

	.get('/', (c) => c.json({ service: 'cdn', status: 'ok' }))

	// Loading-screen tips, bundled here as static JSON.
	.get('/config/LoadingScreenTipData', (c) => c.json(loadingScreenTipData))

	// Signature blobs by name. Streamed from R2 under the `sigs/` key prefix;
	// 404 when missing.
	.get('/sigs/:sigName', (c) => serveAsset(c, `sigs/${c.req.param('sigName')}`))

	// Room build data by name. The client fetches this for a SubRoom's DataBlob to
	// load the room. Streamed from R2 under `room/`. The name may contain slashes
	// (uploads are foldered by date, e.g. `2026-02-03/<uuid>`), so match the rest of
	// the path.
	.get('/room/:dataBlob{.+}', (c) => serveAsset(c, `room/${c.req.param('dataBlob')}`))

	// Invention data by name. The client fetches this for an invention's
	// `CurrentVersion.BlobName` to spawn it. Streamed from R2 under `invention/`.
	// Like room blobs the name is date-foldered, and it carries the `.inv` extension
	// the upload stored it under, so the rest of the path is matched as-is.
	.get('/invention/:dataBlob{.+}', (c) => serveAsset(c, `invention/${c.req.param('dataBlob')}`))

export default app
