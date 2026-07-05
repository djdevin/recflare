import { env, SELF } from 'cloudflare:test'
import { beforeAll, describe, expect, it } from 'vitest'

import '../../img.app'

import type { Env } from '../../context'

declare module 'cloudflare:test' {
	interface ProvidedEnv extends Env {}
}

const ORIGIN = 'https://example.com'

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
})
