import { Hono } from 'hono'
import { useWorkersLogger } from 'workers-tagged-logger'

import { withNotFound, withOnError } from '@repo/hono-helpers'
import { validateAndGetAccountId } from '@repo/jwt'

import type { App } from './context'

/**
 * Storage worker. Handles client file uploads (`POST /upload`) into the shared
 * CDN R2 bucket, foldered by the posted `FileType` so the `cdn` worker can serve
 * them back.
 */

/**
 * The client's `UploadFileType` enum → the R2 subfolder uploads of that type are
 * stored under. `Unknown` (0) is intentionally absent: like the referencecdn
 * server's `makeUploadName`, an unrecognized type has no destination and is
 * rejected rather than stored.
 *
 * RoomSave (1) lands under `room/` (not `roomsave/`) so the `cdn` worker's
 * `GET /room/:dataBlob` route serves the blob back — both bind the same
 * `recflare-cdn` bucket, so the key prefixes must match.
 */
const UPLOAD_SUBFOLDER: Record<number, string> = {
	1: 'room',
	2: 'holotar',
	3: 'image',
	4: 'video',
	5: 'invention',
	6: 'roommetadata',
}

/** Resolve the storage subfolder for a posted FileType, or `undefined` when unknown. */
function subfolderForFileType(fileType: string): string | undefined {
	return UPLOAD_SUBFOLDER[Number.parseInt(fileType, 10)]
}

/**
 * The file extension an upload of a given type keeps. Invention data blobs are
 * named `<name>.inv` — the client expects the extension on the `BlobName` it later
 * gets back from the api worker, so it has to be part of the stored key too, or the
 * blob wouldn't be there to download. Other types are stored under a bare name.
 */
const UPLOAD_EXTENSION: Record<number, string> = {
	5: '.inv',
}

function extensionForFileType(fileType: string): string {
	return UPLOAD_EXTENSION[Number.parseInt(fileType, 10)] ?? ''
}

/** Read a text form field by any of its accepted names, matched case-insensitively. */
function textField(body: Record<string, unknown>, ...names: string[]): string | undefined {
	for (const [key, value] of Object.entries(body)) {
		if (typeof value === 'string' && names.includes(key.toLowerCase())) return value
	}
	return undefined
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

	.get('/', async (c) => {
		return c.text('hello, world!')
	})

	// File upload. Auth-gated — any valid account token is allowed (no role check).
	// Multipart form with `FileType` (the client's UploadFileType enum) and a binary
	// part. Stores the file in the shared CDN R2 bucket under
	// `<type-subfolder>/<upload-date>/<random-name>` and returns the generated name
	// (the `<upload-date>/<random-name>` part the `cdn` worker serves back) the client
	// references it by. Also accepts a name-only post (no binary) that just echoes
	// back an explicit `name`/`filename`/`imagename`. Mirrors the reference `Upload`.
	.post('/upload', async (c) => {
		const id = await validateAndGetAccountId(c.req.raw, await c.env.JWT_SECRET.get())
		if (id === null) return c.body(null, 401)

		const body = await c.req.parseBody().catch(() => ({}) as Record<string, unknown>)

		// The binary part is identified by being a file (filename/content-type),
		// not by its field name — matching the reference's part detection.
		const file = Object.values(body).find((v): v is File => v instanceof File)

		if (file) {
			const fileType = textField(body, 'filetype') ?? '0'
			const subfolder = subfolderForFileType(fileType)
			if (subfolder === undefined) {
				// makeUploadName == "" → no destination for an unknown/missing type.
				return c.json({ error: 'missing or unknown FileType' }, 400)
			}
			// Folder each upload under its date (e.g. `room/2026-02-03/<uuid>`) so the
			// bucket stays browsable. The date is part of the returned name, so the key
			// the `cdn` worker reads back (`<subfolder>/<name>`) still round-trips — as
			// does the extension, which is why it goes on the key, not just the name.
			const datePrefix = new Date().toISOString().slice(0, 10)
			const filename = `${datePrefix}/${crypto.randomUUID()}${extensionForFileType(fileType)}`
			await c.env.CDN_ASSETS.put(`${subfolder}/${filename}`, await file.arrayBuffer(), {
				httpMetadata: { contentType: file.type || 'application/octet-stream' },
			})
			return c.json({ filename })
		}

		// No binary — accept an explicit name and echo it straight back.
		const explicitName = textField(body, 'imagename', 'filename', 'name')
		if (explicitName) return c.json({ filename: explicitName })

		return c.json({ error: 'missing filename or valid upload data' }, 400)
	})

export default app
