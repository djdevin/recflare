import { env, SELF } from 'cloudflare:test'
import { beforeAll, describe, expect, it } from 'vitest'

import '../../img.app'

import type { Env } from '../../context'

declare module 'cloudflare:test' {
	interface ProvidedEnv extends Env {}
}

const ORIGIN = 'https://img.rec.djdevin.net'

// A tiny valid JPEG magic-number blob — enough to assert round-tripping.
const IMAGE_BYTES = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46])

// Public half (SPKI DER, base64) of the dev IMG_SIGNING_KEY in wrangler.jsonc —
// used to verify the Content-Signature header.
const PUBLIC_SPKI_B64 =
	'MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA1EIcBzPCvOFRy3WYuG8ICaRyr/OpotABJBpiMq2zcZHsSPXQw7NC+N082JDqYLy627oB9qJ+wC3idtbzFTANLkIYIEWMWJC9hjWl56vBVXOIroji2+lOpR4hV9JRdgmJfBYXmJPtHRP4GAl8np9xcnZpbMJdauR+HIJiQT3QHc2RomLXWCUfOb564cW8Ks7CLlmXPWf4M77DufHhY+788uWq6bI0+QSJ1qrUi3gaou0HPj7YPTl7pUTwX4VOmHKN5Nw+/jB9f2JNpRKp9niylCVUgdHnmHz5iqMW86HRf7EJcalSyYn7cC6b1ng9GPYryybipZ7QuTgl52qu2GQDaQIDAQAB'

beforeAll(async () => {
	await env.IMAGES.put('DefaultProfileImage.jpg', IMAGE_BYTES, {
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
		const res = await SELF.fetch(`${ORIGIN}/DefaultProfileImage.jpg`)
		expect(res.status).toBe(200)
		expect(res.headers.get('content-type')).toBe('image/jpeg')
		expect(new Uint8Array(await res.arrayBuffer())).toEqual(IMAGE_BYTES)
	})

	it('returns 304 when If-None-Match matches the etag', async () => {
		const first = await SELF.fetch(`${ORIGIN}/DefaultProfileImage.jpg`)
		const etag = first.headers.get('etag')
		expect(etag).toBeTruthy()
		const res = await SELF.fetch(`${ORIGIN}/DefaultProfileImage.jpg`, {
			headers: { 'If-None-Match': etag! },
		})
		expect(res.status).toBe(304)
	})

	it('404 for a missing image', async () => {
		const res = await SELF.fetch(`${ORIGIN}/missing.png`)
		expect(res.status).toBe(404)
	})

	it('signs the response with ?sig=p1 and the signature verifies', async () => {
		const res = await SELF.fetch(`${ORIGIN}/DefaultProfileImage.jpg?sig=p1`)
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
		const res = await SELF.fetch(`${ORIGIN}/DefaultProfileImage.jpg`)
		expect(res.headers.get('content-signature')).toBeNull()
	})
})
