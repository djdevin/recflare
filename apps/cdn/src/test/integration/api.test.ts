import { env } from 'cloudflare:test'
import { exports } from 'cloudflare:workers'
import { describe, expect, test } from 'vitest'

import '../../cdn.app'

import type { Env } from '../../context'

declare module 'cloudflare:test' {
	interface ProvidedEnv extends Env {}
}

const ORIGIN = 'https://example.com'

describe('cdn endpoints', () => {
	test('GET / reports service status', async () => {
		const res = await exports.default.fetch(`${ORIGIN}/`)
		expect(res.status).toBe(200)
		expect(await res.json()).toEqual({ service: 'cdn', status: 'ok' })
	})

	test('GET /config/LoadingScreenTipData returns the tip array', async () => {
		const res = await exports.default.fetch(`${ORIGIN}/config/LoadingScreenTipData`)
		expect(res.status).toBe(200)
		const body = (await res.json()) as Array<{ Title: string }>
		expect(Array.isArray(body)).toBe(true)
		expect(body.length).toBeGreaterThan(0)
		expect(body[0]).toHaveProperty('Title')
	})

	test('GET /sigs/:sigName 404s when the blob is absent', async () => {
		const res = await exports.default.fetch(`${ORIGIN}/sigs/does-not-exist`)
		expect(res.status).toBe(404)
	})

	test('GET /sigs/:sigName streams the blob from R2 as octet-stream', async () => {
		await env.CDN_ASSETS.put('sigs/682c1283', new Uint8Array([1, 2, 3, 4]))
		const res = await exports.default.fetch(`${ORIGIN}/sigs/682c1283`)
		expect(res.status).toBe(200)
		expect(res.headers.get('content-type')).toBe('application/octet-stream')
		expect(new Uint8Array(await res.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3, 4]))
	})

	test('GET /sigs/:sigName honors a Range request with 206', async () => {
		await env.CDN_ASSETS.put('sigs/ranged', new Uint8Array([10, 11, 12, 13, 14, 15]))
		const res = await exports.default.fetch(`${ORIGIN}/sigs/ranged`, {
			headers: { Range: 'bytes=2-4' },
		})
		expect(res.status).toBe(206)
		expect(res.headers.get('content-range')).toBe('bytes 2-4/6')
		expect(res.headers.get('accept-ranges')).toBe('bytes')
		expect(new Uint8Array(await res.arrayBuffer())).toEqual(new Uint8Array([12, 13, 14]))
	})

	test('GET /room/:dataBlob streams the room blob from R2', async () => {
		await env.CDN_ASSETS.put('room/94tp5zjtwz0gppp8xlv1j9l5b.room', new Uint8Array([9, 8, 7]))
		const res = await exports.default.fetch(`${ORIGIN}/room/94tp5zjtwz0gppp8xlv1j9l5b.room`)
		expect(res.status).toBe(200)
		expect(res.headers.get('content-type')).toBe('application/octet-stream')
		expect(new Uint8Array(await res.arrayBuffer())).toEqual(new Uint8Array([9, 8, 7]))
	})

	test('GET /room/:dataBlob 404s when the blob is absent', async () => {
		const res = await exports.default.fetch(`${ORIGIN}/room/missing.room`)
		expect(res.status).toBe(404)
	})
})
