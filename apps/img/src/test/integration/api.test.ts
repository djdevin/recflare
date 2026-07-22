import { PhotonImage } from '@cf-wasm/photon'
import { env, SELF } from 'cloudflare:test'
import { beforeAll, describe, expect, it } from 'vitest'

import '../../img.app'

import type { Env } from '../../context'

declare module 'cloudflare:test' {
	interface ProvidedEnv extends Env {}
}

const ORIGIN = 'https://example.com'

/** Decode a JPEG and read back its pixel dimensions. */
function jpegSize(bytes: Uint8Array): { width: number; height: number } {
	const img = PhotonImage.new_from_byteslice(bytes)
	try {
		return { width: img.get_width(), height: img.get_height() }
	} finally {
		img.free()
	}
}

// A tiny valid JPEG magic-number blob — enough to assert round-tripping.
const IMAGE_BYTES = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46])

// Public half (SPKI DER, base64) of the dev IMG_SIGNING_KEY in wrangler.jsonc —
// used to verify the Content-Signature header.
const PUBLIC_SPKI_B64 =
	'MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA1EIcBzPCvOFRy3WYuG8ICaRyr/OpotABJBpiMq2zcZHsSPXQw7NC+N082JDqYLy627oB9qJ+wC3idtbzFTANLkIYIEWMWJC9hjWl56vBVXOIroji2+lOpR4hV9JRdgmJfBYXmJPtHRP4GAl8np9xcnZpbMJdauR+HIJiQT3QHc2RomLXWCUfOb564cW8Ks7CLlmXPWf4M77DufHhY+788uWq6bI0+QSJ1qrUi3gaou0HPj7YPTl7pUTwX4VOmHKN5Nw+/jB9f2JNpRKp9niylCVUgdHnmHz5iqMW86HRf7EJcalSyYn7cC6b1ng9GPYryybipZ7QuTgl52qu2GQDaQIDAQAB'

// An R2-only key that has no matching file in `static/`, so it exercises the
// bucket path rather than a static asset.
const R2_KEY = 'user-photo.jpg'

beforeAll(async () => {
	await env.IMAGES.put(R2_KEY, IMAGE_BYTES, {
		httpMetadata: { contentType: 'image/jpeg' },
	})
	// Seed R2 with a key that ALSO exists in `static/` to prove static wins.
	await env.IMAGES.put('3DCharades.jpg', IMAGE_BYTES, {
		httpMetadata: { contentType: 'image/jpeg' },
	})
})

describe('img endpoints', () => {
	it('GET / reports service status', async () => {
		const res = await SELF.fetch(`${ORIGIN}/`)
		expect(res.status).toBe(200)
		expect(await res.json()).toEqual({ service: 'img', status: 'ok' })
	})

	it('streams an image stored in R2 with its content type', async () => {
		const res = await SELF.fetch(`${ORIGIN}/${R2_KEY}`)
		expect(res.status).toBe(200)
		expect(res.headers.get('content-type')).toBe('image/jpeg')
		expect(new Uint8Array(await res.arrayBuffer())).toEqual(IMAGE_BYTES)
	})

	it('serves a static asset in preference to an R2 object of the same key', async () => {
		const res = await SELF.fetch(`${ORIGIN}/3DCharades.jpg`)
		expect(res.status).toBe(200)
		expect(res.headers.get('content-type')).toMatch(/^image\/jpeg/)
		// The bundled static JPEG, not the tiny IMAGE_BYTES stub seeded into R2.
		const body = new Uint8Array(await res.arrayBuffer())
		expect(body.length).toBeGreaterThan(IMAGE_BYTES.length)
		expect(body[0]).toBe(0xff)
		expect(body[1]).toBe(0xd8)
	})

	it('serves a nested static asset', async () => {
		const res = await SELF.fetch(`${ORIGIN}/Base/Clearcut.jpg`)
		expect(res.status).toBe(200)
		expect(res.headers.get('content-type')).toMatch(/^image\/jpeg/)
		const body = new Uint8Array(await res.arrayBuffer())
		expect(body.length).toBeGreaterThan(0)
		expect(body[0]).toBe(0xff)
		expect(body[1]).toBe(0xd8)
	})

	it('returns 304 when If-None-Match matches the etag', async () => {
		const first = await SELF.fetch(`${ORIGIN}/${R2_KEY}`)
		const etag = first.headers.get('etag')
		expect(etag).toBeTruthy()
		const res = await SELF.fetch(`${ORIGIN}/${R2_KEY}`, {
			headers: { 'If-None-Match': etag! },
		})
		expect(res.status).toBe(304)
	})

	it('serves the DefaultProfileImage.jpg fallback for a missing image', async () => {
		const res = await SELF.fetch(`${ORIGIN}/missing.png`)
		expect(res.status).toBe(200)
		expect(res.headers.get('content-type')).toMatch(/^image\/jpeg/)
		const body = new Uint8Array(await res.arrayBuffer())
		// Real JPEG static asset: SOI marker + non-empty body.
		expect(body.length).toBeGreaterThan(0)
		expect(body[0]).toBe(0xff)
		expect(body[1]).toBe(0xd8)
	})

	it('signs the DefaultProfileImage.jpg fallback with ?sig=p1', async () => {
		const res = await SELF.fetch(`${ORIGIN}/missing.png?sig=p1`)
		expect(res.status).toBe(200)

		const header = res.headers.get('content-signature')
		expect(header).toMatch(/^key-id=KEY:RSA:p1\.rec\.net; data=/)

		const signatureB64 = header!.split('data=')[1]
		const signature = Uint8Array.from(atob(signatureB64), (ch) => ch.charCodeAt(0))
		const body = new Uint8Array(await res.arrayBuffer())

		const publicKey = await crypto.subtle.importKey(
			'spki',
			Uint8Array.from(atob(PUBLIC_SPKI_B64), (ch) => ch.charCodeAt(0)),
			{ name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-1' },
			false,
			['verify']
		)
		const ok = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', publicKey, signature, body)
		expect(ok).toBe(true)
	})

	it('signs the response with ?sig=p1 and the signature verifies', async () => {
		const res = await SELF.fetch(`${ORIGIN}/${R2_KEY}?sig=p1`)
		expect(res.status).toBe(200)

		const header = res.headers.get('content-signature')
		expect(header).toMatch(/^key-id=KEY:RSA:p1\.rec\.net; data=/)

		const signatureB64 = header!.split('data=')[1]
		const signature = Uint8Array.from(atob(signatureB64), (ch) => ch.charCodeAt(0))
		const body = new Uint8Array(await res.arrayBuffer())

		const publicKey = await crypto.subtle.importKey(
			'spki',
			Uint8Array.from(atob(PUBLIC_SPKI_B64), (ch) => ch.charCodeAt(0)),
			{ name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-1' },
			false,
			['verify']
		)
		const ok = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', publicKey, signature, body)
		expect(ok).toBe(true)
	})

	it('does not sign without ?sig=p1', async () => {
		const res = await SELF.fetch(`${ORIGIN}/${R2_KEY}`)
		expect(res.headers.get('content-signature')).toBeNull()
	})

	it('resizes a static asset to ?width, preserving aspect ratio', async () => {
		const full = new Uint8Array(await (await SELF.fetch(`${ORIGIN}/RecCenter.jpg`)).arrayBuffer())
		const original = jpegSize(full)

		const res = await SELF.fetch(`${ORIGIN}/RecCenter.jpg?width=512`)
		expect(res.status).toBe(200)
		expect(res.headers.get('content-type')).toBe('image/jpeg')
		// Resized responses carry no etag (the source etag no longer describes them).
		expect(res.headers.get('etag')).toBeNull()

		const body = new Uint8Array(await res.arrayBuffer())
		const resized = jpegSize(body)
		expect(resized.width).toBe(512)
		// Height scales with the source aspect ratio (allow 1px rounding).
		expect(resized.height).toBeCloseTo(Math.round((original.height / original.width) * 512), -0.5)
	})

	it('center-crops to a square and resizes with ?cropSquare=1&width', async () => {
		const res = await SELF.fetch(`${ORIGIN}/RecCenter.jpg?width=256&cropSquare=1`)
		expect(res.status).toBe(200)
		expect(res.headers.get('content-type')).toBe('image/jpeg')

		const size = jpegSize(new Uint8Array(await res.arrayBuffer()))
		expect(size.width).toBe(256)
		expect(size.height).toBe(256)
	})

	it('crops to a square at native size with ?cropSquare=1 alone', async () => {
		const full = jpegSize(
			new Uint8Array(await (await SELF.fetch(`${ORIGIN}/RecCenter.jpg`)).arrayBuffer())
		)
		const res = await SELF.fetch(`${ORIGIN}/RecCenter.jpg?cropSquare=1`)
		expect(res.status).toBe(200)

		const size = jpegSize(new Uint8Array(await res.arrayBuffer()))
		expect(size.width).toBe(size.height)
		// The square's side is the shorter source dimension.
		expect(size.width).toBe(Math.min(full.width, full.height))
	})

	it('ignores an invalid ?width and serves the original', async () => {
		const full = new Uint8Array(await (await SELF.fetch(`${ORIGIN}/RecCenter.jpg`)).arrayBuffer())
		const res = await SELF.fetch(`${ORIGIN}/RecCenter.jpg?width=0`)
		expect(res.status).toBe(200)
		expect(new Uint8Array(await res.arrayBuffer())).toEqual(full)
	})

	it('ignores a ?width outside the allowed sizes and serves the original', async () => {
		const full = new Uint8Array(await (await SELF.fetch(`${ORIGIN}/RecCenter.jpg`)).arrayBuffer())
		// 300 isn't one of 128/256/512/1024, so it's rejected and the source served.
		const res = await SELF.fetch(`${ORIGIN}/RecCenter.jpg?width=300`)
		expect(res.status).toBe(200)
		expect(new Uint8Array(await res.arrayBuffer())).toEqual(full)
	})

	it('signs the resized body with ?width and ?sig=p1', async () => {
		const res = await SELF.fetch(`${ORIGIN}/RecCenter.jpg?width=512&sig=p1`)
		expect(res.status).toBe(200)
		expect(jpegSize(new Uint8Array(await res.clone().arrayBuffer())).width).toBe(512)

		const header = res.headers.get('content-signature')
		expect(header).toMatch(/^key-id=KEY:RSA:p1\.rec\.net; data=/)

		const signature = Uint8Array.from(atob(header!.split('data=')[1]), (ch) => ch.charCodeAt(0))
		const body = new Uint8Array(await res.arrayBuffer())

		const publicKey = await crypto.subtle.importKey(
			'spki',
			Uint8Array.from(atob(PUBLIC_SPKI_B64), (ch) => ch.charCodeAt(0)),
			{ name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-1' },
			false,
			['verify']
		)
		// The signature must verify over the RESIZED bytes the client receives.
		const ok = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', publicKey, signature, body)
		expect(ok).toBe(true)
	})

	it('GET /openapi.json documents every route', async () => {
		const res = await SELF.fetch(`${ORIGIN}/openapi.json`)
		expect(res.status).toBe(200)
		const spec = (await res.json()) as {
			openapi: string
			paths: Record<string, Record<string, { summary?: string }>>
		}
		expect(spec.openapi).toMatch(/^3\.1/)

		// The spec route hides itself.
		expect(spec.paths['/openapi.json']).toBeUndefined()

		// Every route the worker serves is described. This is the drift guard: adding a
		// route without a describeRoute() block fails here rather than silently shipping
		// an incomplete spec. Hono's `:param` syntax becomes OpenAPI's `{param}`.
		const documented = new Set(
			Object.entries(spec.paths).flatMap(([path, ops]) =>
				Object.keys(ops).map((method) => `${method.toUpperCase()} ${path}`)
			)
		)
		expect([...documented].sort()).toEqual(['GET /', 'GET /{key}'])

		// Every operation carries a summary — a path present but undescribed is not
		// documentation.
		for (const ops of Object.values(spec.paths)) {
			for (const op of Object.values(ops)) expect(op.summary).toBeTruthy()
		}

		// Schemas must inline: a `$ref` here is a dangling reference (see openapi.ts).
		expect(JSON.stringify(spec).includes('"$ref"')).toBe(false)
	})
})
