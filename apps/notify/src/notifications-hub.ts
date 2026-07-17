import { DurableObject } from 'cloudflare:workers'

import { NotificationType } from './notification-types'

import type { Env } from './context'

/**
 * Durable Object hosting the SignalR notifications hub. A single global instance
 * holds the shared hub state (one process, shared across connections).
 *
 * It speaks the SignalR JSON Hub Protocol over a hibernatable WebSocket:
 *   1. negotiate happens in the worker; the client then opens a WS to `/hub/v1`.
 *   2. handshake: client sends `{"protocol":"json","version":1}␞`, we reply `{}␞`.
 *   3. framed messages are `␞` (0x1e) delimited JSON; type 1 = invocation,
 *      3 = completion, 6 = ping, 7 = close.
 *
 * Connection/subscription state lives in SQLite so it survives hibernation:
 *   - `subscriptions(connectionId, playerId)` — both the connection→players and
 *     (queried the other way) the player→connections maps.
 *   - `pending(id, playerId, payload)` — the per-player queue delivered once a
 *     player is subscribed.
 */

/** SignalR record separator (0x1e) that terminates every protocol message. */
const RS = '\u001e'

interface SocketState {
	connectionId: string
	handshakeDone: boolean
}

interface HubMessage {
	type: number
	target?: string
	invocationId?: string
	arguments?: unknown[]
}

/** The Coach system account — the `FromPlayerId` on a coach message (see coachMessageAll). */
const COACH_PLAYER_ID = 1

/** The Message `Type` a coach/system message carries (a Message-model enum, not a NotificationType). */
const COACH_MESSAGE_TYPE = 100

export class NotificationsHub extends DurableObject<Env> {
	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env)
		void ctx.blockConcurrencyWhile(async () => {
			this.ctx.storage.sql.exec(`
				CREATE TABLE IF NOT EXISTS subscriptions (
					connectionId TEXT NOT NULL,
					playerId INTEGER NOT NULL
				);
				CREATE INDEX IF NOT EXISTS idx_sub_conn ON subscriptions(connectionId);
				CREATE INDEX IF NOT EXISTS idx_sub_player ON subscriptions(playerId);
				CREATE TABLE IF NOT EXISTS pending (
					id INTEGER PRIMARY KEY AUTOINCREMENT,
					playerId INTEGER NOT NULL,
					payload TEXT NOT NULL
				);
				CREATE INDEX IF NOT EXISTS idx_pending_player ON pending(playerId);
			`)
		})
	}

	/** WebSocket upgrade entrypoint — the worker forwards `/hub/v1` here. */
	override async fetch(request: Request): Promise<Response> {
		if ((request.headers.get('Upgrade') ?? '').toLowerCase() !== 'websocket') {
			return new Response('Expected a WebSocket upgrade request', { status: 426 })
		}

		const url = new URL(request.url)
		// negotiate handed the client this id as `connectionToken`/`connectionId`.
		const connectionId = url.searchParams.get('id') || crypto.randomUUID()

		const pair = new WebSocketPair()
		const server = pair[1]
		// Tag by connectionId so we can find this socket via getWebSockets(id).
		this.ctx.acceptWebSocket(server, [connectionId])
		server.serializeAttachment({ connectionId, handshakeDone: false } satisfies SocketState)

		return new Response(null, { status: 101, webSocket: pair[0] })
	}

	override async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
		const text = typeof message === 'string' ? message : new TextDecoder().decode(message)
		const state = ws.deserializeAttachment() as SocketState | null
		if (!state) return

		for (const record of text.split(RS)) {
			if (record.length === 0) continue

			if (!state.handshakeDone) {
				// First frame is the SignalR handshake request.
				this.completeHandshake(ws, record, state)
				continue
			}

			let msg: HubMessage
			try {
				msg = JSON.parse(record) as HubMessage
			} catch {
				continue
			}
			this.handleMessage(ws, state.connectionId, msg)
		}
	}

	override async webSocketClose(ws: WebSocket): Promise<void> {
		const state = ws.deserializeAttachment() as SocketState | null
		if (state) {
			// Mirrors OnDisconnected: drop this connection's subscriptions, which
			// also removes it from every player's connection set.
			this.ctx.storage.sql.exec(
				'DELETE FROM subscriptions WHERE connectionId = ?',
				state.connectionId
			)
		}
		try {
			ws.close()
		} catch {
			// already closed
		}
	}

	// ---- SignalR protocol ----------------------------------------------------

	private completeHandshake(ws: WebSocket, record: string, state: SocketState): void {
		let protocol = 'json'
		try {
			protocol = (JSON.parse(record) as { protocol?: string }).protocol ?? 'json'
		} catch {
			// fall through to the json default
		}
		if (protocol !== 'json') {
			ws.send(JSON.stringify({ error: `Unsupported protocol '${protocol}'` }) + RS)
			ws.close(1002, 'unsupported protocol')
			return
		}

		// Empty object = handshake success.
		ws.send('{}' + RS)
		state.handshakeDone = true
		ws.serializeAttachment(state)

		// Send "OnConnect" to the caller after connecting.
		ws.send(this.invocation('OnConnect', []))
	}

	private handleMessage(ws: WebSocket, connectionId: string, msg: HubMessage): void {
		switch (msg.type) {
			case 1: // Invocation
				this.handleInvocation(ws, connectionId, msg)
				break
			case 6: // Ping — echo to keep the connection alive.
				ws.send(JSON.stringify({ type: 6 }) + RS)
				break
			case 7: // Close
				ws.close()
				break
			default:
				break
		}
	}

	private handleInvocation(ws: WebSocket, connectionId: string, msg: HubMessage): void {
		switch (msg.target) {
			case 'SubscribeToPlayers': {
				const arg = msg.arguments?.[0] as { playerIds?: number[] } | undefined
				const playerIds = (arg?.playerIds ?? []).filter((n) => typeof n === 'number')
				this.subscribeToPlayers(ws, connectionId, playerIds)
				if (msg.invocationId) ws.send(this.completion(msg.invocationId, null))
				break
			}
			case 'GetSubscriptions': {
				const players = this.getSubscribedPlayers(connectionId)
				if (msg.invocationId) ws.send(this.completion(msg.invocationId, players))
				break
			}
			default:
				if (msg.invocationId) {
					ws.send(this.completionError(msg.invocationId, `Unknown method '${msg.target}'`))
				}
				break
		}
	}

	private subscribeToPlayers(ws: WebSocket, connectionId: string, playerIds: number[]): void {
		const unique = [...new Set(playerIds)]

		// Replace this connection's subscription set.
		this.ctx.storage.sql.exec('DELETE FROM subscriptions WHERE connectionId = ?', connectionId)
		for (const playerId of unique) {
			this.ctx.storage.sql.exec(
				'INSERT INTO subscriptions (connectionId, playerId) VALUES (?, ?)',
				connectionId,
				playerId
			)
		}

		// Flush any notifications queued while these players were offline.
		for (const playerId of unique) {
			const pending = this.ctx.storage.sql
				.exec<{
					payload: string
				}>('SELECT payload FROM pending WHERE playerId = ? ORDER BY id', playerId)
				.toArray()
			if (pending.length === 0) continue
			for (const row of pending) {
				ws.send(this.invocation('Notification', [row.payload]))
			}
			this.ctx.storage.sql.exec('DELETE FROM pending WHERE playerId = ?', playerId)
		}
	}

	private getSubscribedPlayers(connectionId: string): number[] {
		return this.ctx.storage.sql
			.exec<{ playerId: number }>(
				'SELECT DISTINCT playerId FROM subscriptions WHERE connectionId = ?',
				connectionId
			)
			.toArray()
			.map((r) => r.playerId)
	}

	// ---- Server → client RPC (callable from other workers) -------------------

	/**
	 * Send a notification to a player's connections, queueing it if the player
	 * isn't currently connected (mirrors `SendNotificationToPlayer`).
	 */
	async notifyPlayer(
		playerId: number,
		notificationType: string | number,
		data?: Record<string, unknown>
	): Promise<{ delivered: number; queued: boolean }> {
		const payload = this.buildNotificationPayload(notificationType, data)
		const delivered = this.deliverToPlayer(playerId, payload)

		if (delivered === 0) {
			this.ctx.storage.sql.exec(
				'INSERT INTO pending (playerId, payload) VALUES (?, ?)',
				playerId,
				payload
			)
			return { delivered: 0, queued: true }
		}
		return { delivered, queued: false }
	}

	/**
	 * Send a "coach" message to every connected client (mirrors the reference
	 * `SendCoachMessageAll`, using the hub's live connections as the online set): each
	 * handshaken socket gets a `MessageReceived` notification carrying a Message from
	 * the Coach account (player 1). Online-only — nothing is queued or persisted, and
	 * it's a broadcast, so the Message has no per-recipient `ToPlayerId`. Returns how
	 * many connected clients were messaged.
	 */
	async coachMessageAll(content: string): Promise<{ sent: number }> {
		const payload = this.buildNotificationPayload(NotificationType.MessageReceived, {
			FromPlayerId: COACH_PLAYER_ID,
			Type: COACH_MESSAGE_TYPE,
			Data: content,
		})
		return { sent: this.broadcastToConnected(payload) }
	}

	/** Broadcast a notification to every connected (handshaken) client. */
	async broadcast(
		notificationType: string | number,
		data?: Record<string, unknown>
	): Promise<{ delivered: number }> {
		return { delivered: this.broadcastToConnected(this.buildNotificationPayload(notificationType, data)) }
	}

	// ---- Helpers -------------------------------------------------------------

	/**
	 * Send an already-built `Notification` payload to every live socket of a player's
	 * subscribed connections; returns how many sockets received it (0 = offline). The
	 * shared send path for {@link notifyPlayer} and {@link coachMessageAll}.
	 */
	private deliverToPlayer(playerId: number, payload: string): number {
		const connectionIds = this.ctx.storage.sql
			.exec<{ connectionId: string }>(
				'SELECT DISTINCT connectionId FROM subscriptions WHERE playerId = ?',
				playerId
			)
			.toArray()
			.map((r) => r.connectionId)

		let delivered = 0
		for (const connectionId of connectionIds) {
			for (const ws of this.ctx.getWebSockets(connectionId)) {
				ws.send(this.invocation('Notification', [payload]))
				delivered++
			}
		}
		return delivered
	}

	/**
	 * Send an already-built `Notification` payload to every connected (handshaken)
	 * socket; returns how many received it. Shared by {@link broadcast} and
	 * {@link coachMessageAll}.
	 */
	private broadcastToConnected(payload: string): number {
		let delivered = 0
		for (const ws of this.ctx.getWebSockets()) {
			const state = ws.deserializeAttachment() as SocketState | null
			if (!state?.handshakeDone) continue
			ws.send(this.invocation('Notification', [payload]))
			delivered++
		}
		return delivered
	}

	/**
	 * Build the `Notification` argument: a JSON string `{ Id, Msg }`
	 * (null values are dropped from `Msg`). `Id` is a client-defined tag — a
	 * string name (e.g. "AccountUpdate") or a numeric code. It is always emitted
	 * as a string: the client dispatches on a string `Id`, so a numeric frame
	 * (e.g. the `NotificationType` enum values sent by `econ`) would otherwise be
	 * silently dropped.
	 */
	private buildNotificationPayload(
		notificationType: string | number,
		data?: Record<string, unknown>
	): string {
		const msg: Record<string, unknown> = {}
		if (data) {
			for (const [key, value] of Object.entries(data)) {
				if (value === null || value === undefined) continue
				msg[key] = value
			}
		}
		return JSON.stringify({ Id: String(notificationType), Msg: msg })
	}

	private invocation(target: string, args: unknown[]): string {
		return JSON.stringify({ type: 1, target, arguments: args }) + RS
	}

	private completion(invocationId: string, result: unknown): string {
		return JSON.stringify({ type: 3, invocationId, result }) + RS
	}

	private completionError(invocationId: string, error: string): string {
		return JSON.stringify({ type: 3, invocationId, error }) + RS
	}
}
