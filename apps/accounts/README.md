# accounts

Accounts Worker served at `accounts.rec.djdevin.net`. A Hono app ported from the
C# `AccountsController`. EF Core (`AppDbContext`) queries are stubbed for now —
no real bindings yet.

## Behavior

- **Auth-gated routes** validate the Bearer JWT issued by the `auth` worker
  (same dev secret, see `src/jwt.ts`) and 401 when it's missing/invalid.
- **DB-backed reads** return synthesized default accounts. The C# already fills
  every column with a fallback (`Player{id}`, `DefaultProfileImage.jpg`, etc.),
  so the stubs return those defaults rather than 404ing on a missing row.
- **DB-backed writes** (`create`, the `PUT /account/me/*` mutations) accept the
  request and ack without persisting. `create` mints a random account id and
  returns it wrapped in the RecNet result envelope `{ success, value }`.

## Endpoints

- `GET /` — health check
- `GET /account/me` — authed self account (`SelfAccount`)
- `GET /account/bulk?id=1&id=2` — accounts for the requested ids
- `GET /account/:id` — single account
- `GET /account/:id/bio` — player bio
- `POST /account/create` — create an account → `{ success, value }`
- `GET /parentalcontrol/me` — authed parental-control flags
- `PUT /account/me/displayname` — authed, body `displayName`
- `PUT /account/me/username` — authed, body `username`
- `PUT /account/me/bio` — authed, body `bio`
- `PUT /account/me/profileimage` — authed, body `imageName`

## TODO before production

- Wire a DB binding (D1/DO) for `Accounts`, `CachedLogins`, `PlayerBios`,
  `Rooms`/`SubRooms` (the dorm room created on signup).
- Make reads 404 on missing rows once real data exists.
- Persist the `PUT /account/me/*` mutations.
- Move the JWT secret to a shared secret binding (shared with `auth`).
