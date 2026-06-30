# RecFlare

RecFlare is an implementation of RecNet — the Rec Room backend — built on
Cloudflare Workers. It implements the network services the Rec Room client talks
to — accounts, auth, rooms, matchmaking, economy, chat, notifications, and more —
each as an independent Worker on its own subdomain.

> **Disclaimer:** This is an unofficial, fan-made project for preservation and
> experimentation. It is not affiliated with, endorsed by, or connected to Rec
> Room Inc. "Rec Room" is a trademark of its respective owner.

## Why?

There are already so many multiplayer clones, why?

1. None of them are fully open source (some had leaks of old code).
2. None of them run on microservice architecture, and crash constantly.
3. "Upgrading the server" is not a lasting fix.
4. Exploits were rampant due to bad code.
5. This was fun (sort of).

RecFlare uses a true microservice architecture which, if developed correctly, is
near infinitely scalable and could support the same number of concurrent users
as the original game. It will never run out of CPU, memory, or disk space.

Being truly open source means that this project should have more eyes on it,
resulting in bugs getting fixed faster. I hope.

Of course, cloud services cost money. That's the only limitation.

## Client

RecFlare is compatible with the
[CannedNet client](https://github.com/djdevin/CannedNet) and the build of Rec
Room with manifest `7859140924515540835`. Other client or game versions may expect
different endpoints and response shapes and are not supported.

See the project page for information on how to mod the game to connect to this server.

## How it works

The Rec Room client discovers every service by fetching an _endpoints document_
from the name-server (`ns`) worker at the apex domain. That document maps each
service to a host like `https://match.<your-domain>`. Every service runs as a
separate Cloudflare Worker attached to its own subdomain, so the client's traffic
fans out across the workers in `apps/`.

Authentication is a Bearer-JWT flow: the `auth` worker issues tokens from
`/connect/token` and owns the shared `accounts` table; every other worker
validates that token on its auth-gated routes.

State is persisted with Cloudflare's storage primitives — the workers are
completely stateless and no data is stored alongside the microservices.

## Services

This is a list of every RecNet service the client discovers, taken from the
service-discovery map in [`apps/ns/src/endpoints.ts`](apps/ns/src/endpoints.ts).
Each is reached at `https://<subdomain>.<your-domain>`. Services with a worker in
`apps/` are implemented here; the rest are advertised in the endpoints document
but not yet backed by a Worker. Not all services are fully implemented.

| Service                 | Subdomain               | Worker             | Notes                                                              |
| ----------------------- | ----------------------- | ------------------ | ----------------------------------------------------------------- |
| Accounts                | `accounts`              | `accounts`         | Player accounts & profile reads/writes (D1)                       |
| AI                      | `ai`                    | —                  | Not yet implemented                                               |
| API                     | `api`                   | `api`              | Core Game API — config, social, avatar, rooms, image uploads (D1, R2) |
| Auth                    | `auth`                  | `auth`             | OAuth token issuance (`/connect/token`); owns the accounts table (D1, KV) |
| BugReporting            | `bugreporting`          | —                  | Not yet implemented                                               |
| Cards                   | `cards`                 | —                  | Not yet implemented                                               |
| CDN                     | `cdn`                   | `cdn`              | Binary CDN — signature blobs & room build data (R2)               |
| Chat                    | `chat`                  | `chat`             | Chat service                                                      |
| Clubs                   | `clubs`                 | `clubs`            | Clubs                                                             |
| CMS                     | `cms`                   | —                  | Not yet implemented                                               |
| Commerce                | `commerce`              | `commerce`         | Store / purchase endpoints                                        |
| Data                    | `data`                  | —                  | Not yet implemented                                               |
| DataCollection          | `datacollection`        | `datacollection`   | Client telemetry / analytics sink                                 |
| Discovery               | `discovery`             | —                  | Not yet implemented                                               |
| Econ                    | `econ`                  | `econ`             | Economy & avatar endpoints (separate from `api`)                 |
| GameLogs                | `gamelogs`              | —                  | Not yet implemented                                               |
| Geo                     | `geo`                   | —                  | Not yet implemented                                               |
| Images                  | `img`                   | `img`              | Image storage & signed delivery (R2)                             |
| Leaderboard             | `leaderboard`           | —                  | Not yet implemented                                               |
| Link                    | `link`                  | —                  | Not yet implemented                                               |
| Lists                   | `lists`                 | —                  | Not yet implemented                                               |
| Matchmaking             | `match`                 | `match`            | Matchmaking & per-player presence (D1, KV)                       |
| Moderation              | `moderation`            | —                  | Not yet implemented                                               |
| Notifications           | `notify`                | `notify`           | Real-time notifications over SignalR/WebSockets (Durable Object) |
| PlatformNotifications   | `platformnotifications` | —                  | Not yet implemented                                               |
| PlayerSettings          | `playersettings`        | `playersettings`   | Per-player settings (KV)                                         |
| RoomComments            | `roomcomments`          | —                  | Not yet implemented                                               |
| RoomieIntegrations      | `roomieintegrations`    | —                  | Not yet implemented                                               |
| Rooms                   | `rooms`                 | `rooms`            | Room storage & queries; seeds the Dorm & Orientation rooms (D1) |
| Storage                 | `storage`               | —                  | Not yet implemented                                               |
| Strings                 | `strings`               | —                  | Not yet implemented                                               |
| StringsCDN              | `strings-cdn`           | —                  | Not yet implemented                                               |
| Studio                  | `studio`                | —                  | Not yet implemented                                               |
| Thorn                   | `thorn`                 | —                  | Not yet implemented                                               |
| Videos                  | `videos`                | —                  | Not yet implemented                                               |
| WWW                     | `www`                   | —                  | Website host (not a Worker)                                       |

Additionally, the small `ns` worker itself serves this discovery document at the
apex/`ns` host and isn't listed within it. Each implemented worker has its own
`README.md` under `apps/<name>/` documenting its routes.

## Why Cloudflare?

- **It's free to run a lot of services.** Cloudflare Workers' free tier is keyed
  to usage, not to the number of Workers — so whether you deploy 1 service or all
  36, the baseline cost is the same. You only start paying once usage crosses the
  free-tier limits.
- **It mirrors RecNet's architecture.** Rec Room's backend is a set of
  independent microservices, not one monolith. Modeling each service as its own
  Worker keeps RecFlare's structure close to the real thing — services scale,
  fail, and deploy independently — instead of collapsing everything into a single
  giant server.

## Do I have to use Cloudflare?

No. The services are plain [Hono](https://hono.dev) apps, so the request-handling
code isn't tied to Cloudflare and can be deployed to other hosting providers —
AWS (Lambda), Vercel, Netlify, Fly.io, a plain Node/Bun server, and so on.

**However**

The catch is everything _around_ the code. RecFlare leans on Cloudflare for the
deployment and infrastructure layer — custom-domain routing per service, plus the
storage bindings (D1, KV, R2, Durable Objects) the workers use. On another
provider you'll need to provide equivalents (per-service routing, databases,
object storage, a pub/sub or WebSocket layer) and wire up the deployment yourself.

## Prerequisites

- node (modern)
- pnpm
- bun
- jq
- A Cloudflare account with a zone (domain) you control, for deploying

Cloudflare's free plan is good enough for testing (100k requests/day) but the
Rec Room client is pretty chatty. Frequent testing may exhaust that quota.

See https://developers.cloudflare.com/workers/platform/pricing/#workers

## Getting Started

**Install dependencies:**

```bash
just install
```

**Configure your custom domain:**

Create a new .env file:

```bash
cp .env.example .env
# edit .env and set RECFLARE_DOMAIN to your domain
```

Or, export it:

```bash
export RECFLARE_DOMAIN=rec.example.com
```

`just deploy` resolves the base domain at deploy time and passes it to wrangler —
each worker is attached to its custom domain via `--domain <subdomain>.<domain>`,
and the base domain is injected as the `DOMAIN` var so the `ns` service-discovery
document and the api share-link base URL are built at runtime. Nothing in version
control is rewritten; committed `wrangler.jsonc` files have no routes.

Per-app subdomain overrides come from
`RECFLARE_SUBDOMAINS` (a JSON object, e.g. `'{"playersettings":"settings"}'`).

**Create the storage resources:**

The workers bind Cloudflare storage primitives — one shared D1 database, two KV
namespaces, two R2 buckets, and a Durable Object. Create them once against your
Cloudflare account, then record the ids in `.env`. The committed `wrangler.jsonc`
files carry `"local"` placeholders; the real ids are spliced in at deploy time, so
nothing in version control needs editing. Authenticate wrangler first
(`wrangler login`).

_D1 — one shared `recflare` database_ (bound by `api`, `accounts`, `auth`, `match`,
`rooms`):

```bash
wrangler d1 create recflare
# copy the printed database_id into .env:
#   RECFLARE_D1=<database_id>
```

Then apply the schema. The `rooms` and `auth` workers own the migrations under
their `apps/<worker>/migrations/` directories. `just migrate` applies them to the
remote database (splicing `RECFLARE_D1` into the `"local"` placeholder the same way
`just deploy` does, so you don't edit any config):

```bash
just migrate                 # migrate every worker that owns migrations
just migrate -F rooms        # or scope to one worker
just migrate -- --local      # target the local dev db instead of remote
```

_KV — two namespaces_ (`RECFLARE_MATCH_PRESENCE` for `match`/`auth`,
`RECFLARE_PLAYER_SETTINGS` for `playersettings`):

```bash
wrangler kv namespace create RECFLARE_MATCH_PRESENCE
wrangler kv namespace create RECFLARE_PLAYER_SETTINGS
```

Record both ids in `.env` as a single JSON object keyed by binding name (note the
surrounding single quotes — without them the shell strips the inner quotes):

```bash
RECFLARE_KV='{"RECFLARE_MATCH_PRESENCE":"<id>","RECFLARE_PLAYER_SETTINGS":"<id>"}'
```

_R2 — two buckets_ (`recflare-cdn` for `cdn`, `recflare-img` for `api`/`img`):

```bash
wrangler r2 bucket create recflare-cdn
wrangler r2 bucket create recflare-img
```

R2 buckets are referenced by name in the committed `wrangler.jsonc`, so there is
nothing to add to `.env`. See [`apps/img/README.md`](apps/img/README.md) for
seeding the default avatar/profile images.

_Durable Objects — no manual setup_. The `notify` worker's `RECFLARE_NOTIFICATIONS_HUB`
binding (class `NotificationsHub`) is provisioned automatically from the migration
declared in its `wrangler.jsonc` on first deploy — there is no id to create or set.

**Run the development microservices:**

> **Note:** This runs, but the name-server document still advertises the deployed
> hosts, not your local instances — so service discovery won't resolve locally.
> You can still call each service directly; each Wrangler instance runs on its own
> port.

```bash
just dev
```

**Deploy all workers:**

```bash
just deploy
```

Deploying requires `wrangler` to be authenticated against your Cloudflare
account (`wrangler login`, or `CLOUDFLARE_API_TOKEN` / `CLOUDFLARE_ACCOUNT_ID`
in the environment). It also requires the storage resources to exist and their
ids to be set in `.env` — see **Create the storage resources** above. At deploy
time the deploy script splices `RECFLARE_D1` and `RECFLARE_KV` into the `"local"`
placeholders in each worker's `wrangler.jsonc`; a missing id fails the deploy with
a message naming the binding.

## Repository Structure

- `apps/` - The service workers, one deployable Worker per subdirectory. Each has
  its own `README.md`, `wrangler.jsonc`, `src/`, and tests.
- `packages/` - Shared libraries and configuration used across the workers.
  - `@repo/hono-helpers` - Hono framework utilities (logging, error handling).
  - `@repo/tools` - The `runx` CLI and the `bin/` scripts each worker's
    package.json delegates to, so build/test/deploy stays consistent.
  - `@repo/typescript-config`, `@repo/oxlint-config` - Shared TS and lint config.
- `turbo/generators/` - `turbo gen` templates for scaffolding new workers/packages.
- `Justfile` - Convenient aliases for common development tasks.

## Available Commands

This repository uses a `Justfile`. Run `just` (or `just --list`) to see every
command. Some key ones:

- `just install` - Install all dependencies.
- `just dev` - Start the dev server (context-aware: runs `bun runx dev`).
- `just build` - Build all workers.
- `just test` - Run tests (vitest).
- `just check` - Check code quality: deps, lint, types, format.
- `just fix` - Fix code issues: deps, lint, format, workers-types.
- `just deploy` - Deploy all workers to your domain.
- `just new-worker` (alias: `just gen`) - Scaffold a new service worker.
- `just new-package` - Scaffold a new shared package.
- `just update deps` - Update dependencies across the monorepo with syncpack.

For a single worker, scope with -F, e.g. `just deploy -F playersettings`.

## FAQ

### What year is this for?

This works with 2023 clients. It has been tested with manifest `7859140924515540835`. Other clients may not work.

See the "Client" section above for instructions on how to modify a client to connect to this server.

### Can I run this locally on my PC?

It's not currently supported. But theoretically, you could.

See "Run the development microservices" above. It may be possible later as Wrangler will mock remote services. YMMV for now.

### Can I use this to make my own server?

Yes, that's the point.

### Can I copy this project and modify it?

Yes, see the [LICENSE](LICENSE).

I would love if you contributed your changes back.

### Why a monorepo?

The services share types, auth logic, and tooling, so keeping them in one repo
keeps those in sync: `pnpm` workspaces share dependencies, `@repo/` packages
share code, Turborepo runs build/test/lint with a single cached task graph, and
cross-service changes land in one atomic commit.
