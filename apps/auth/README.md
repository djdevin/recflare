# auth

Auth Worker served on the `auth` subdomain. A Hono app handling authentication.
Binding-dependent behavior (database queries) is stubbed for now — no real
KV/D1/DO bindings yet.

## Routes

| Method | Path                                       | Description                        |
| ------ | ------------------------------------------ | ---------------------------------- |
| GET    | `/eac/challenge`                           | EAC challenge, served as text      |
| GET    | `/cachedlogin/forplatformid/:platform/:id` | Cached logins (stubbed → `[]`)     |
| POST   | `/connect/token`                           | OAuth token endpoint, issues a JWT |
| GET    | `/role/developer/:id`                      | Developer role lookup (TODO)       |

## Signing key

Tokens are signed HS256 with the `JWT_SECRET` binding (see `src/jwt.ts`), resolved
at request time via `await c.env.JWT_SECRET.get()`. The key lives in a single shared
**Cloudflare Secrets Store** that every worker binds (so `auth`-signed tokens verify
in `rooms`, `api`, `match`, etc.). The store id is kept out of source in the root
`.env` as `RECFLARE_SECRETS_STORE` and spliced into `wrangler.jsonc`'s `"local"`
`store_id` placeholder at deploy time (see `packages/tools/bin/run-wrangler-deploy`).

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

## Notes / TODO

- `/eac/challenge` content is inlined in `src/auth.app.ts` (Workers have no
  filesystem) — replace `EAC_CHALLENGE` with the real challenge text.
- `/cachedlogin/...` and the `RoomInstance` cleanup in `/connect/token` need a DB
  binding to be implemented.
- `/role/developer/:id` is a stub (`// TODO: implement`).
