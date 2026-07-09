# www

The public web frontend — the repo's first browser-facing worker (every other
app is a backend service). A React SPA (built with Vite) for creating an account
and setting/resetting its email and password, served by a Hono worker.

## Architecture

www is a **backend-for-frontend (BFF)**. The browser only ever talks to www; www
forwards to the `auth` and `accounts` workers server-side. This keeps the account
JWT off other origins and sidesteps CORS (those workers set no CORS headers).

- **React SPA** (`src/client/`, entry `index.html` → `src/client/main.tsx`) is
  built by Vite into `dist/client` and served via the `ASSETS` binding, with
  `not_found_handling: single-page-application` for client-side routes.
- **Worker** (`src/www.app.ts`) exposes the `/api/*` BFF routes and falls back to
  the static assets for everything else.

Upstream hosts are derived from the shared base domain (`auth.<DOMAIN>`,
`accounts.<DOMAIN>`), where `DOMAIN` is injected at deploy time (see
`run-wrangler-deploy`). For local dev/preview, point the `DOMAIN` var in
`wrangler.jsonc` at a deployed domain so the BFF can reach those workers.

### BFF endpoints

| Method | Path            | Upstream                                                 |
| ------ | --------------- | -------------------------------------------------------- |
| POST   | `/api/signup`   | auth `POST /connect/token` (`grant_type=create_account`) |
| POST   | `/api/login`    | auth `POST /connect/token` (account id + password)       |
| POST   | `/api/logout`   | clears the session cookie                                |
| GET    | `/api/me`       | accounts `GET /account/me`                               |
| POST   | `/api/email`    | accounts `POST /account/me/email`                        |
| POST   | `/api/password` | auth `POST /account/me/changepassword`                   |

On signup/login the access token returned by `auth` is stored in an httpOnly
`rf_token` cookie; the other routes read it and forward it as a Bearer token.

## Development

### Run in dev mode

```sh
pnpm turbo dev
```

### Run in preview mode

```sh
pnpm turbo preview
```

### Run tests

```sh
pnpm test
```

### Deploy

```sh
pnpm turbo deploy
```
