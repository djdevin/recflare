import { exports } from 'cloudflare:workers'
import { describe, expect, test } from 'vitest'

import '../../notify.app'

const ORIGIN = 'https://notify.rec.djdevin.net'
const RS = '\u001e'

interface HubRecord {
	type?: number
	target?: string
	invocationId?: string
	result?: unknown
	arguments?: unknown[]
}

/** Open a hub WebSocket, accept it, and complete the SignalR handshake. */
async function connect(
	id: string
): Promise<{ ws: WebSocket; waitFor: (pred: (r: HubRecord) => boolean) => Promise<HubRecord> }> {
	const res = await exports.default.fetch(`${ORIGIN}/hub/v1?id=${id}`, {
		headers: { Upgrade: 'websocket' },
	})
	expect(res.status).toBe(101)
	const ws = res.webSocket!
	ws.accept()

	const records: HubRecord[] = []
	const waiters: Array<{ pred: (r: HubRecord) => boolean; resolve: (r: HubRecord) => void }> = []
	ws.addEventListener('message', (e: MessageEvent) => {
		const text =
			typeof e.data === 'string' ? e.data : new TextDecoder().decode(e.data as ArrayBuffer)
		for (const part of text.split(RS)) {
			if (!part) continue
			const rec = JSON.parse(part) as HubRecord
			records.push(rec)
			for (let i = waiters.length - 1; i >= 0; i--) {
				if (waiters[i].pred(rec)) {
					waiters[i].resolve(rec)
					waiters.splice(i, 1)
				}
			}
		}
	})

	const waitFor = (pred: (r: HubRecord) => boolean): Promise<HubRecord> => {
		const existing = records.find(pred)
		if (existing) return Promise.resolve(existing)
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => reject(new Error('timed out waiting for hub message')), 2000)
			waiters.push({
				pred,
				resolve: (r) => {
					clearTimeout(timer)
					resolve(r)
				},
			})
		})
	}

	// Handshake, then the C# OnConnect callback.
	ws.send(`{"protocol":"json","version":1}${RS}`)
	await waitFor((r) => r.type === 1 && r.target === 'OnConnect')

	return { ws, waitFor }
}

const send = (ws: WebSocket, msg: HubRecord) => ws.send(JSON.stringify(msg) + RS)

const post = (path: string, body: unknown) =>
	exports.default.fetch(`${ORIGIN}${path}`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify(body),
	})

describe('negotiate', () => {
	test('POST /hub/v1/negotiate advertises the WebSocket transport', async () => {
		const res = await exports.default.fetch(`${ORIGIN}/hub/v1/negotiate?negotiateVersion=1`, {
			method: 'POST',
		})
		expect(res.status).toBe(200)
		const body = (await res.json()) as {
			connectionId: string
			connectionToken: string
			availableTransports: Array<{ transport: string }>
		}
		expect(body.connectionId).toMatch(/^[0-9a-f-]{36}$/)
		expect(body.connectionToken).toBe(body.connectionId)
		expect(body.availableTransports[0].transport).toBe('WebSockets')
	})

	test('GET /hub/v1 without an upgrade header is 426', async () => {
		const res = await exports.default.fetch(`${ORIGIN}/hub/v1`)
		expect(res.status).toBe(426)
	})
})

describe('hub protocol', () => {
	test('GetSubscriptions reflects SubscribeToPlayers', async () => {
		const { ws, waitFor } = await connect('conn-subs')

		send(ws, { type: 1, invocationId: '1', target: 'GetSubscriptions', arguments: [] })
		const empty = await waitFor((r) => r.type === 3 && r.invocationId === '1')
		expect(empty.result).toEqual([])

		send(ws, { type: 1, target: 'SubscribeToPlayers', arguments: [{ playerIds: [1, 2, 2] }] })
		send(ws, { type: 1, invocationId: '2', target: 'GetSubscriptions', arguments: [] })
		const subscribed = await waitFor((r) => r.type === 3 && r.invocationId === '2')
		expect((subscribed.result as number[]).sort((a, b) => a - b)).toEqual([1, 2])

		ws.close()
	})

	test('responds to ping', async () => {
		const { ws, waitFor } = await connect('conn-ping')
		send(ws, { type: 6 })
		const pong = await waitFor((r) => r.type === 6)
		expect(pong.type).toBe(6)
		ws.close()
	})
})

describe('notification delivery', () => {
	test('queues for an offline player and flushes on subscribe', async () => {
		const playerId = 9001
		const queued = await post('/internal/notify', {
			playerId,
			notificationType: 2,
			data: { messageId: 'm1' },
		})
		expect(await queued.json()).toMatchObject({ queued: true, delivered: 0 })

		const { ws, waitFor } = await connect('conn-pending')
		send(ws, { type: 1, target: 'SubscribeToPlayers', arguments: [{ playerIds: [playerId] }] })
		const note = await waitFor((r) => r.type === 1 && r.target === 'Notification')
		expect(JSON.parse((note.arguments as string[])[0])).toEqual({ Id: 2, Msg: { messageId: 'm1' } })

		ws.close()
	})

	test('delivers live to a subscribed player', async () => {
		const playerId = 9002
		const { ws, waitFor } = await connect('conn-live')
		send(ws, {
			type: 1,
			invocationId: 's',
			target: 'SubscribeToPlayers',
			arguments: [{ playerIds: [playerId] }],
		})
		await waitFor((r) => r.type === 3 && r.invocationId === 's')

		const res = await post('/internal/notify', {
			playerId,
			notificationType: 1,
			data: { accountId: 42 },
		})
		expect(await res.json()).toMatchObject({ delivered: 1, queued: false })

		const note = await waitFor((r) => r.type === 1 && r.target === 'Notification')
		expect(JSON.parse((note.arguments as string[])[0])).toEqual({ Id: 1, Msg: { accountId: 42 } })

		ws.close()
	})

	test('broadcast reaches connected clients', async () => {
		const { ws, waitFor } = await connect('conn-broadcast')
		const res = await post('/internal/broadcast', {
			notificationType: 25,
			data: { message: 'maint' },
		})
		expect(((await res.json()) as { delivered: number }).delivered).toBeGreaterThanOrEqual(1)
		const note = await waitFor((r) => r.type === 1 && r.target === 'Notification')
		expect(JSON.parse((note.arguments as string[])[0])).toEqual({
			Id: 25,
			Msg: { message: 'maint' },
		})
		ws.close()
	})
})
