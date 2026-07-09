# RecFlare

<img width="256" height="256" alt="be292b38-950c-4d7f-b4ee-57fe361ede7d" src="https://github.com/user-attachments/assets/d7bb9266-64a2-449f-9267-89116c870f74" />

RecFlare is an implementation of RecNet — the Rec Room backend — built on
Cloudflare Workers. It implements the network services the Rec Room client talks
to — accounts, auth, rooms, matchmaking, economy, chat, notifications, and more —
each as an independent Worker on their own subdomains, just how RecNet was.

> ⚠️ **Disclaimer:** This is an unofficial, fan-made project for preservation and
> experimentation. It is not affiliated with, endorsed by, or connected to Rec
> Room Inc. "Rec Room" is a trademark of its respective owner.

## Why?

There are already so many multiplayer clones, why?

1. None of them are fully open source (some had leaks of old code).
2. None of them run on microservice architecture, most on a single server.
3. None of them had unit tests.
4. "Upgrading the server" is not sustainable plan for growth.
5. This was fun (sort of).

RecFlare uses a true microservice architecture which, if developed correctly, is
near infinitely scalable and could support the same number of concurrent users
as the original game. It will never run out of CPU, memory, or disk space.

Being truly open source means that this project should have more eyes on it,
resulting in bugs getting fixed faster. I hope.

Of course, cloud services cost money. That's the only limitation.

## Client

RecFlare is compatible with the
[RecNet Plugin](https://github.com/djdevin/recnet-plugin) and the build of Rec
Room with manifest `7859140924515540835`. Other client or game versions may expect
different endpoints and response shapes and are not supported.

Generally speaking any client that effectively rewrites the nameserver can be used
with this server.

See the above project page for information on how to mod the game to connect to this
server.

## How it works

The Rec Room client discovers every service by fetching an _endpoints document_
from the name-server (`ns`) worker at the apex domain. That document maps each
service to a host like `https://match.<your-domain>`. Every service runs as a
separate Cloudflare Worker attached to its own subdomain, so the client's traffic
fans out across the workers in `apps/` instead of to a single machine.

State is persisted with Cloudflare's storage primitives — the workers are
completely stateless and no data is stored alongside the microservices.

## Services

This is a list of every RecNet service the client discovers, taken from the
service-discovery map in [`apps/ns/src/endpoints.ts`](apps/ns/src/endpoints.ts).
Each is reached at `https://<subdomain>.<your-domain>`. Services with a worker in
`apps/` are implemented here; the rest are advertised in the endpoints document
but not yet backed by a Worker. Not all services are fully implemented.

| Service               | Subdomain               | Worker           | Notes                                                                     |
| --------------------- | ----------------------- | ---------------- | ------------------------------------------------------------------------- |
| Accounts              | `accounts`              | `accounts`       | Player accounts & profile reads/writes (D1)                               |
| AI                    | `ai`                    | —                | Not yet implemented                                                       |
| API                   | `api`                   | `api`            | Core Game API — config, social, avatar, rooms, image uploads (D1, R2)     |
| Auth                  | `auth`                  | `auth`           | OAuth token issuance (`/connect/token`); (D1)                             |
| BugReporting          | `bugreporting`          | —                | Not yet implemented                                                       |
| Cards                 | `cards`                 | —                | Not yet implemented                                                       |
| CDN                   | `cdn`                   | `cdn`            | Binary CDN — room data (R2)                                               |
| Chat                  | `chat`                  | `chat`           | Player chat service (not in room)                                         |
| Clubs                 | `clubs`                 | `clubs`          | Clubs, not yet implemented                                                |
| CMS                   | `cms`                   | —                | Not yet implemented                                                       |
| Commerce              | `commerce`              | `commerce`       | Store / purchase endpoints                                                |
| Data                  | `data`                  | —                | Not yet implemented                                                       |
| DataCollection        | `datacollection`        | `datacollection` | Client telemetry / analytics sink                                         |
| Discovery             | `discovery`             | —                | Not yet implemented                                                       |
| Econ                  | `econ`                  | `econ`           | Economy & avatar endpoints (separate from `api`)                          |
| GameLogs              | `gamelogs`              | —                | Not yet implemented                                                       |
| Geo                   | `geo`                   | —                | Not yet implemented                                                       |
| Images                | `img`                   | `img`            | Image storage & signed delivery (R2)                                      |
| Leaderboard           | `leaderboard`           | —                | Not yet implemented                                                       |
| Link                  | `link`                  | —                | Not yet implemented                                                       |
| Lists                 | `lists`                 | —                | Not yet implemented                                                       |
| Matchmaking           | `match`                 | `match`          | Matchmaking & per-player presence (D1, KV)                                |
| Moderation            | `moderation`            | —                | Not yet implemented                                                       |
| Notifications         | `notify`                | `notify`         | Real-time notifications over SignalR/WebSockets (Durable Object)          |
| PlatformNotifications | `platformnotifications` | —                | Not yet implemented                                                       |
| PlayerSettings        | `playersettings`        | `playersettings` | Per-player settings (KV)                                                  |
| RoomComments          | `roomcomments`          | —                | Not yet implemented                                                       |
| RoomieIntegrations    | `roomieintegrations`    | —                | Not yet implemented                                                       |
| Rooms                 | `rooms`                 | `rooms`          | Room storage & queries; seeds the Dorm & Orientation rooms (D1)           |
| Storage               | `storage`               | —                | Room uploader                                                             |
| Strings               | `strings`               | —                | Not yet implemented                                                       |
| StringsCDN            | `strings-cdn`           | —                | Not yet implemented                                                       |
| Studio                | `studio`                | —                | Not yet implemented                                                       |
| Thorn                 | `thorn`                 | —                | Not yet implemented                                                       |
| Videos                | `videos`                | —                | Not yet implemented                                                       |
| WWW                   | `www`                   | —                | Website/Panel			                                                       |

Additionally, the small `ns` worker itself serves this discovery document at the
apex/`ns` host and isn't listed within it. Each implemented worker has its own
`README.md` under `apps/<name>/` documenting its routes.

## Why Cloudflare?

- **Makes it easy to mirror RecNet**
	Rec Room's backend is (was) a set of independent microservices, not one big monolith.
	Modeling each service as its own isolated Worker keeps RecFlare's structure close to
  the real thing — services scale,
  fail, and deploy independently — instead of collapsing everything into a single
  giant server.
- **It's free/cheap to run a lot of service.**
  Cloudflare Workers' free tier is keyed
  to usage, not to the number of Workers — so whether you deploy 1 service or all
  36, the baseline cost is the same. You only start paying once usage crosses the
  free-tier limits. Additionally for development or maybe a private instance, the cost
  is near zero when not in use.
- **Bundled Cloud CDN/Storage/SQL**
  Cloudflare offers several cloud services we can rely on so the microservices can remain
  stateless (effectively read-only). They are also scalable by default so we don't need to worry
  about adding more disk space or upgrading services. If we start outgrowing the limits of these,
  well, we'll cross that bridge when we get to it.
  	- D1 (a SQLite-compatible distributed database)
  	- R2 (service like S3 for mass file hosting)
  	- KV (service to distributed offer key/value stores)
  	- Durable Objects (for a notifications hub)

## Do I have to use Cloudflare?

Short answer, no. The services are plain [Hono](https://hono.dev) apps, so the request-handling
code isn't tied to Cloudflare and can be deployed to other hosting providers —
AWS, Vercel, Netlify, Fly.io, a plain Node/Bun server, and so on.

Long answer: the catch is everything _around_ the code. RecFlare leans on Cloudflare for the
deployment (Wrangler) and infrastructure layer — custom-domain routing per service, plus the
storage bindings (D1, KV, R2, Durable Objects) the workers use. On another
provider you'll need to provide equivalents (per-service routing, databases,
object storage, a pub/sub or WebSocket layer) and wire up the deployment yourself.

So for example if you wanted to run on Vercel, you'd have to swap out KV for Redis, which are very similar
services but would require small code changes.

## Prerequisites

- node (modern)
- pnpm
- bun
- jq/awk/sed
- A Cloudflare account with a zone (domain) you control, for deploying.

Cloudflare's free plan is good enough for testing (100k worker requests/day) but the
Rec Room client is very chatty. Frequent testing may exhaust that quota. The $5/month
Worker plan includes 10M requests/month.

See https://developers.cloudflare.com/workers/platform/pricing/#workers

## Getting Started

**Install dependencies:**

We use [Just](https://github.com/casey/just) for convenience. This will install all dependencies across the microservices.

```bash
just install
```

**Configure your custom domain:**

Create a new .env file from the template:

```bash
cp .env.example .env
```

Edit `.env` and set `RECFLARE_DOMAIN` to your domain (or declare it with `export RECFLARE_DOMAIN=rec.example.com`)

(Optional) - per-app subdomain overrides come from
`RECFLARE_SUBDOMAINS` (a JSON object, e.g. `'{"playersettings":"settings"}'`). This would be used
if you wanted to merge two services together.

**Create the storage resources:**

The workers bind Cloudflare storage primitive. Create them once against your
Cloudflare account, then record the IDs in `.env`. The committed `wrangler.jsonc`
files carry `"local"` placeholders; the real IDs are spliced in at deploy time, so
nothing in version control needs editing. Authenticate wrangler first
(`wrangler login`).

```bash
wrangler d1 create recflare
wrangler kv namespace create RECFLARE_MATCH_PRESENCE
wrangler kv namespace create RECFLARE_PLAYER_SETTINGS
wrangler secrets-store store create recflare --scopes workers
```

Take the IDs output from the commands and put them into `.env`. (or with CI: `RECFLARE_KV='{"RECFLARE_MATCH_PRESENCE":"<id>","RECFLARE_PLAYER_SETTINGS":"<id>"}'`)

The secrets store holds the shared `JWT_SECRET` HS256 signing key — every worker
binds it so tokens signed by `auth` verify everywhere. Record its id in `.env` as
`RECFLARE_SECRETS_STORE`, then set the key value once (all workers share it):

```bash
wrangler secrets-store secret create <store-id> --name JWT_SECRET --scopes workers --remote
```

Then apply the schema. `just migrate` will set up the database and populate it with data. This runs non-interactively, so be careful!

```bash
just migrate                 # migrate every worker that owns migrations
just migrate -F rooms        # or scope to one worker
```

### R2 and Durable Objects

You only have to create the buckets:

```bash
wrangler r2 bucket create recflare-cdn
wrangler r2 bucket create recflare-img
```

### Durable Objects

Nothing manual to do here. The object is created manually.

**Run the development microservices:**

> ⚠️ **Note:** This runs, but the name-server document still advertises the deployed
> hosts, not your local instances — so service discovery won't resolve locally.
> You can still call each service directly; each Wrangler instance runs on its own
> port. Maybe we can get this working somehow. @todo

```bash
just dev
```

**Deploy all workers:**

This will deploy all workers to respective endpoints (*.example.com)

Deploying requires `wrangler` to be authenticated against your Cloudflare
account (`wrangler login`, or `CLOUDFLARE_API_TOKEN` / `CLOUDFLARE_ACCOUNT_ID`
in the environment).

It requires the storage to be set up above, otherwise, deployments may fail.

You can always re-run it as often as you wish.

```bash
just deploy # for all services
just deploy -F rooms # for a single microservice
```

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

Yes, that's the point. Just set your custom domain and deploy it.

### Is there an admin panel?

Not yet. But there could be.

### Can I copy this project and modify it?

Yes, see the [LICENSE](LICENSE).

I would love if you contributed your changes back.

### Why a monorepo?

The services share types, auth logic, and tooling, so keeping them in one repo
keeps those in sync: `pnpm` workspaces share dependencies, `@repo/` packages
share code, Turborepo runs build/test/lint with a single cached task graph, and
cross-service changes land in one atomic commit.
