import { exports } from 'cloudflare:workers'
import { describe, expect, test } from 'vitest'

import '../../match.app'

const ORIGIN = 'https://match.rec.djdevin.net'

// Mint a token the way the `auth` worker does, using the same dev secret, so the
// match worker's validation accepts it. Kept inline to avoid a cross-package
// import.
const DEV_SECRET = 'dev-insecure-signing-key-change-me'

function b64url(input: ArrayBuffer | string): string {
	const bytes = typeof input === 'string' ? new TextEncoder().encode(input) : new Uint8Array(input)
	let binary = ''
	for (const byte of bytes) binary += String.fromCharCode(byte)
	return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

async function bearer(sub = '42'): Promise<Record<string, string>> {
	const now = Math.floor(Date.now() / 1000)
	const signingInput = `${b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }))}.${b64url(
		JSON.stringify({ sub, exp: now + 3600 })
	)}`
	const key = await crypto.subtle.importKey(
		'raw',
		new TextEncoder().encode(DEV_SECRET),
		{ name: 'HMAC', hash: 'SHA-256' },
		false,
		['sign']
	)
	const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(signingInput))
	return { Authorization: `Bearer ${signingInput}.${b64url(sig)}` }
}

describe('public endpoints', () => {
	test('POST /player/login returns 200', async () => {
		const res = await exports.default.fetch(`${ORIGIN}/player/login`, { method: 'POST' })
		expect(res.status).toBe(200)
	})

	test('GET /player returns the default payload', async () => {
		const res = await exports.default.fetch(`${ORIGIN}/player?id=99`)
		expect(res.status).toBe(200)
		const players = (await res.json()) as Array<{ playerId: number; isOnline: boolean }>
		expect(players[0]).toMatchObject({ playerId: 1, isOnline: true, appVersion: '20210129' })
	})

	test('POST /goto/none returns the offline dorm', async () => {
		const res = await exports.default.fetch(`${ORIGIN}/goto/none`, { method: 'POST' })
		expect(res.status).toBe(200)
		const body = (await res.json()) as {
			errorCode: number
			roomInstance: { name: string; location: string; photonRoomId: string }
		}
		expect(body.errorCode).toBe(0)
		expect(body.roomInstance).toMatchObject({
			name: 'DormRoom',
			location: '76d98498-60a1-430c-ab76-b54a29b7a163',
			isPrivate: true,
		})
		expect(body.roomInstance.photonRoomId).toMatch(/^[0-9a-f-]{36}$/)
	})

	test('PUT /player/statusvisibility returns 200', async () => {
		const res = await exports.default.fetch(`${ORIGIN}/player/statusvisibility`, { method: 'PUT' })
		expect(res.status).toBe(200)
	})

	test('POST /roominstance/:id/reportjoinresult returns 200', async () => {
		const res = await exports.default.fetch(`${ORIGIN}/roominstance/5/reportjoinresult`, {
			method: 'POST',
		})
		expect(res.status).toBe(200)
	})
})

describe('auth-gated endpoints', () => {
	test('POST /goto/room/:room 401s without a token', async () => {
		const res = await exports.default.fetch(`${ORIGIN}/goto/room/dormroom`, { method: 'POST' })
		expect(res.status).toBe(401)
	})

	test('POST /goto/room/dormroom returns the dorm instance', async () => {
		const res = await exports.default.fetch(`${ORIGIN}/goto/room/dormroom`, {
			method: 'POST',
			headers: await bearer(),
		})
		expect(res.status).toBe(200)
		const body = (await res.json()) as {
			errorCode: number
			roomInstance: { name: string; location: string; isPrivate: boolean; roomId: number }
		}
		expect(body.errorCode).toBe(0)
		expect(body.roomInstance).toMatchObject({
			name: 'DormRoom',
			location: '76d98498-60a1-430c-ab76-b54a29b7a163',
			isPrivate: true,
			roomId: 1,
		})
	})

	test('POST /goto/room/:id synthesizes an instance and honors JoinMode', async () => {
		const res = await exports.default.fetch(`${ORIGIN}/goto/room/42`, {
			method: 'POST',
			headers: { ...(await bearer()), 'Content-Type': 'application/x-www-form-urlencoded' },
			body: new URLSearchParams({ JoinMode: '2' }).toString(),
		})
		expect(res.status).toBe(200)
		const body = (await res.json()) as { roomInstance: { roomId: number; isPrivate: boolean; name: string } }
		expect(body.roomInstance).toMatchObject({ roomId: 42, isPrivate: true, name: '42' })
	})

	test('POST /player/heartbeat 401s without a token', async () => {
		const res = await exports.default.fetch(`${ORIGIN}/player/heartbeat`, { method: 'POST' })
		expect(res.status).toBe(401)
	})

	test('POST /player/heartbeat echoes the body and defaults playerId to the token id', async () => {
		const res = await exports.default.fetch(`${ORIGIN}/player/heartbeat`, {
			method: 'POST',
			headers: { ...(await bearer()), 'Content-Type': 'application/json' },
			body: JSON.stringify({ statusVisibility: 2, platform: 5, appVersion: '20210129' }),
		})
		expect(res.status).toBe(200)
		expect(await res.json()).toMatchObject({
			playerId: 42,
			statusVisibility: 2,
			vrMovementMode: 1,
			roomInstance: null,
			isOnline: false,
			appVersion: '20210129',
			platform: 5,
		})
	})
})
