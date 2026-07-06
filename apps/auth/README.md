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

Tokens are signed HS256 with the `JWT_SECRET` binding (see `src/jwt.ts`). It's a
Cloudflare secret in deployed environments and read from `.dev.vars` locally
(gitignored) — never committed. `"keep_vars": true` in `wrangler.jsonc` keeps
deploys from clearing it.

Set the deployed secret once (persists across deploys):

```sh
bunx wrangler secret put JWT_SECRET
```

## Notes / TODO

- `/eac/challenge` content is inlined in `src/auth.app.ts` (Workers have no
  filesystem) — replace `EAC_CHALLENGE` with the real challenge text.
- `/cachedlogin/...` and the `RoomInstance` cleanup in `/connect/token` need a DB
  binding to be implemented.
- `/role/developer/:id` is a stub (`// TODO: implement`).
