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
| GET    | `/api/config`   | none — whether signup is open, plus the Turnstile key    |
| POST   | `/api/signup`   | auth `POST /connect/token` (`grant_type=create_account`) |
| POST   | `/api/login`    | auth `POST /connect/token` (username + password)         |
| POST   | `/api/logout`   | clears the session cookie                                |
| GET    | `/api/me`       | accounts `GET /account/me`                               |
| POST   | `/api/email`    | accounts `POST /account/me/email`                        |
| POST   | `/api/password` | auth `POST /account/me/changepassword`                   |

On signup/login the access token returned by `auth` is stored in an httpOnly
`rf_token` cookie; the other routes read it and forward it as a Bearer token.

### Signup and Turnstile

`POST /api/signup` creates an account with no platform identity (a password
account), so it's the one BFF route a bot could farm — `auth` binds no Steam id to
it and only its coarse per-IP cap applies. It therefore runs behind a
[Turnstile](https://developers.cloudflare.com/turnstile/) check: the browser posts
the widget's token, and the worker verifies it against Turnstile's `siteverify`
server-side before calling `auth`. The secret key never leaves the worker, and the
browser never talks to `siteverify` itself.

Two keys configure it — the public `TURNSTILE_SITE_KEY` var and the
`TURNSTILE_SECRET_KEY` worker secret (see `wrangler.jsonc` and `src/turnstile.ts`).
Signup **fails closed**: with no usable keypair, `/api/config` reports
`signupEnabled: false` (so the SPA shows sign-in only) and `/api/signup` returns
403, rather than serving an unprotected endpoint. Locally (`just dev`, tests) an
unconfigured worker falls back to Turnstile's documented always-passes test
keypair, so the form works in a fresh checkout.

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
