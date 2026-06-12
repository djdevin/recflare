# auth

Auth Worker served at `auth.rec.djdevin.net`. A Hono app ported from the C#
`AuthController`. Binding-dependent behavior (EF Core `AppDbContext` queries) is
stubbed for now — no real KV/D1/DO bindings yet.

## Routes

| Method | Path                                       | Description                        |
| ------ | ------------------------------------------ | ---------------------------------- |
| GET    | `/eac/challenge`                           | EAC challenge, served as text      |
| GET    | `/cachedlogin/forplatformid/:platform/:id` | Cached logins (stubbed → `[]`)     |
| POST   | `/connect/token`                           | OAuth token endpoint, issues a JWT |
| GET    | `/role/developer/:id`                      | Developer role lookup (TODO)       |

## Notes / TODO

- `JWT` is signed with a placeholder dev secret in `src/jwt.ts`. Move to a secret
  binding before real use.
- `/eac/challenge` content is inlined in `src/auth.app.ts` (Workers have no
  filesystem) — replace `EAC_CHALLENGE` with the real challenge text.
- `/cachedlogin/...` and the `RoomInstance` cleanup in `/connect/token` need a DB
  binding to be implemented.
- `/role/developer/:id` is a stub, matching the C# `// TODO: implement`.
