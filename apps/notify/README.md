# notify

Notifications Worker served on the `notify` subdomain. Hosts a SignalR hub at
`/hub/v1`.

The hub is implemented as a **Durable Object** (`NotificationsHub`) speaking the
SignalR JSON Hub Protocol over a hibernatable WebSocket. A single global DO
instance holds the shared hub state (one process across all connections).

## Endpoints

- `POST /hub/v1/negotiate` — SignalR negotiation. Returns a `connectionId` /
  `connectionToken` and advertises the WebSocket transport. The token is passed
  back as `?id=` on the WebSocket connect.
- `GET /hub/v1` (WebSocket upgrade) — the hub. Forwarded to the Durable Object.
  Non-upgrade requests get `426`.
- `POST /internal/notify` — `{ playerId, notificationType, data? }`. Send to a
  player's connections, queueing if they're offline. **Admin-gated**: requires a
  Bearer token carrying an admin role (`developer`/`moderator`) in its `role` claim.
- `POST /internal/broadcast` — `{ notificationType, data? }`. Send to every
  connected client. Same admin-role gate as `/internal/notify`.
- `POST /internal/coach-message-all` — `{ messageContent }`. Broadcast a coach/system
  `MessageReceived` to every connected client (online-only; not persisted). Same
  admin-role gate.

## Hub protocol

1. Client `POST /hub/v1/negotiate`, then opens a WebSocket to `/hub/v1?id=<token>`.
2. Handshake: client sends `{"protocol":"json","version":1}␞`, server replies
   `{}␞` (`␞` = record separator `0x1e`).
3. Server immediately sends the `OnConnect` invocation on connect.
4. Client→server invocations:
   - `SubscribeToPlayers({ playerIds })` — replaces this connection's
     subscriptions and flushes any queued notifications for those players.
   - `GetSubscriptions()` → completion with the subscribed player id array.
5. Server→client: `Notification` invocations carrying a JSON string
   `{ Id: <PushNotificationId>, Msg: { ... } }`.
6. Pings (type 6) are echoed.

## State

Held in the DO's SQLite so it survives hibernation:

- `subscriptions(connectionId, playerId)` — serves both the connection→players
  and player→connections lookups.
- `pending(id, playerId, payload)` — per-player queue delivered once the player
  subscribes.

A connection's rows are removed on `webSocketClose`.

## TODO before production

- Authenticate the `/internal/*` endpoints (or move them to a service binding /
  RPC reachable only by other workers).
- Wire the real callers (relationships, gifts, storefront, events, chat, …) to
  push through `notifyPlayer` / `broadcast`.
- Consider server-initiated keepalive pings if clients rely on them.
