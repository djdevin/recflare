# auth

Auth Worker served on the `auth` subdomain (`auth.recflare.net`) — a Hono app that
authenticates players and issues the JWTs every other worker verifies.

## Routes

| Method | Path                                       | Description                                            |
| ------ | ------------------------------------------ | ------------------------------------------------------ |
| GET    | `/eac/challenge`                           | EAC handshake; a constant, JSON-quoted, as text        |
| GET    | `/cachedlogin/forplatformid/:platform/:id` | Accounts linked to a platform id, for the login screen |
| POST   | `/cachedlogin/forplatformids`              | Bulk cached-login lookup (friends resolution)          |
| POST   | `/connect/token`                           | OAuth token endpoint; issues a JWT + refresh token     |
| POST   | `/account/me/changepassword`               | Change the caller's password (auth-gated)              |
| GET    | `/role/developer/:id`                      | Developer role lookup; a bare JSON boolean             |
| GET    | `/role/moderator/:id`                      | Moderator role lookup; a bare JSON boolean             |
| GET    | `/openapi.json`                            | Generated OpenAPI 3.1 spec (see below)                 |

## API documentation

`GET /openapi.json` serves a spec generated from `describeRoute` blocks that sit
alongside each handler, with the schemas in `src/openapi.ts`.

**The spec is descriptive, not enforced.** Nothing validates requests against it. That
is deliberate: this worker serves a protocol reverse-engineered from the Rec Room
client, and the handlers are intentionally lenient — every field is read as
`typeof body.x === 'string' ? body.x : ''`, and missing or malformed input generally
falls through to a graceful path rather than a 400. Which parts of that tolerance the
client actually depends on isn't fully known, so enforcing a schema would risk
rejecting requests that work today. Read a "required" field as _the client always
sends it_, not _the server rejects it if absent_.

A test asserts that every route the worker serves appears in the spec, so adding a
route without documenting it fails rather than silently shipping an incomplete spec.

## Grants

`POST /connect/token` selects behavior from `grant_type`:

- **`create_account`** — mints an account with an auto-assigned random username and
  places the player in the Orientation room (RoomId 13), which the client enters
  without matchmaking. A posted `password` becomes the login credential.
- **`cached_login`** — logs into an already-linked account using platform ownership as
  the credential; no password. The posted `account_id` must be linked to exactly the
  identity the Steam ticket proves.
- **`refresh_token`** — redeems a stored single-use refresh token, rotating it.
  30-day TTL; platform and platform id come from what was stored at issue time.
- **`password`** — the fallback for any unrecognised or absent `grant_type`. Identifies
  the account by `username` or numeric `account_id` and requires the matching password
  (PBKDF2-SHA256, `salt:hash`). An account with no stored hash cannot be logged into at
  all, which is what closes id/username-only takeover.

Access tokens live for 1 hour (`TOKEN_TTL_SECONDS` in `@repo/jwt`) and carry a `role`
claim, so developer/moderator powers refresh on every login and every refresh grant.
Grant those flags with `runx admin grant-developer` / `grant-moderator`.

### Steam is the only verifiable platform

`platform_auth` tickets are verified **offline** — `src/steam-ticket.ts` parses the
ticket and checks Steam's signature against Steam's system public key. No publisher
Web API key, no network call. Steam (platform `0`) is therefore the only platform
whose identity can be proven, so any grant that authenticates _by platform identity_
(`cached_login`, and `create_account` when it asserts a platform) must be Steam. The
verified SteamID64 replaces the client-supplied `platform_id` and is the only value
ever written to an account's `platformId`.

## Signup caps

`create_account` is capped on two independent arms, per verified platform id and per
signup IP. The platform arm can't be spoofed or reset by changing networks; the IP arm
is coarse and will produce false positives behind NAT, shared campus and mobile
networks. Both default to 3.

Override per environment via the root `.env` (`RECFLARE_MAX_ACCOUNTS_PER_PLATFORM_ID`,
`RECFLARE_MAX_ACCOUNTS_PER_IP`), injected at deploy time so tuning them never means
editing a versioned file. Setting an arm to `0` disables it — worth reaching for on a
small private server, or when a shared network is being locked out.

## Bindings

| Binding              | Type          | Notes                                                  |
| -------------------- | ------------- | ------------------------------------------------------ |
| `DB`                 | D1            | Shared `recflare` database; this worker owns `account` |
| `JWT_SECRET`         | Secrets Store | Shared HS256 signing key                               |
| `MAX_ACCOUNTS_PER_*` | vars          | Optional signup caps; read via `intVar`                |

Migrations live in `migrations/` and are tracked in their own `d1_migrations_auth`
table, so they stay independent of the `rooms` worker's migrations on the same
database. Run them with `pnpm -F auth migrate`.

## Signing key

Tokens are signed HS256 with the `JWT_SECRET` binding (see `@repo/jwt`), resolved at
request time via `await c.env.JWT_SECRET.get()`. The key lives in a single shared
**Cloudflare Secrets Store** that every worker binds, so `auth`-signed tokens verify in
`rooms`, `api`, `match`, etc. The store id is kept out of source in the root `.env` as
`RECFLARE_SECRETS_STORE` and spliced into `wrangler.jsonc`'s `"local"` `store_id`
placeholder at deploy time (see `packages/tools/bin/run-wrangler-deploy`).

If the secret resolves empty, the worker refuses to issue a token at all rather than
sign one with an empty key — every worker validates against that same key, so an
empty-key token would be forgeable by anyone.

One-time setup (needs Cloudflare auth):

```sh
# Create the store, then put the returned id in .env as RECFLARE_SECRETS_STORE
wrangler secrets-store store create recflare --scopes workers

# Set the shared signing key (prompted for the value)
wrangler secrets-store secret create <store-id> --name JWT_SECRET --scopes workers --remote
```

For local `wrangler dev`, seed a local value (omit `--remote`) so `.get()` resolves:

```sh
wrangler secrets-store secret create local --name JWT_SECRET --value <dev-key> --scopes workers
```

Rotating the store value invalidates all existing tokens (clients re-authenticate).
