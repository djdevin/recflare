# match

Matchmaking Worker served on the `match` subdomain. A Hono app for matchmaking.
Database queries are stubbed for now — no real bindings yet.

## Behavior

- **Auth-gated routes** (`/player/heartbeat`, `/goto/room/:room`) validate the
  Bearer JWT issued by the `auth` worker (same dev secret, see `src/jwt.ts`) and
  401 when it's missing/invalid.
- **`GET /player`** always returns the inlined `JSON/getplayer.json` default
  (falls back to that file when the account/room instance isn't found).
- **`POST /goto/none`** returns the static offline-dorm instance with a fresh
  `photonRoomId`.
- **`POST /goto/room/:room`** synthesizes the room-instance response (no Rooms
  binding yet). The dorm gets its known scene id and a private instance; other
  rooms get an empty `location` and respect the posted `JoinMode` (2 = private).
- **`POST /player/heartbeat`** echoes the posted heartbeat fields; `roomInstance`
  is always null and `isOnline` false until there's a DB binding.
- **`/player/login`, `/player/statusvisibility`, `/roominstance/:id/reportjoinresult`**
  return empty 200s.

## TODO before production

- Wire a DB binding (D1/DO) for `Accounts`, `Rooms`/`SubRooms`, `RoomInstances`.
- Implement `/goto/room/:room` (resolve room, upsert instance) and the
  per-account `/player` + `/player/heartbeat` room-instance lookups.
- Move the JWT secret to a shared secret binding (shared with `auth`).
