# Deploying

These are the instructions for deploying the RecFlare infrastructure to Cloudflare.

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

## Deploy or upgrade all workers

This will deploy or upgrade all workers to respective endpoints (*.example.com)

It will additionally run any necessary DB migrations.

Deploying requires `wrangler` to be authenticated against your Cloudflare
account (`wrangler login`, or `CLOUDFLARE_API_TOKEN` / `CLOUDFLARE_ACCOUNT_ID`
in the environment).

It requires the storage to be set up above, otherwise, deployments may fail.

You can always re-run it as often as you wish. DB migrations will only run once.

```bash
just install # Makes sure dependencies are up to date
just migrate # Runs DB migrations
just deploy # Deploy code
```

Optionally if you know there was only a change to a single service, you can use `just [migrate|deploy] -F econ` for example to only deploy the `econ` microservice.

## Tuning your server

A few gameplay/policy values are knobs rather than hardcoded constants, and they live in
the same `.env` you already created. `.env.example` carries each one commented out, set to
its built-in default: copy the lines you want to change into your `.env`, uncomment them,
edit the value, then re-deploy the worker that reads them.

| `.env` variable                         | Read by | Default | What it does                                                   |
| --------------------------------------- | ------- | ------- | -------------------------------------------------------------- |
| `RECFLARE_MAX_ACCOUNTS_PER_PLATFORM_ID` | `auth`  | `3`     | Accounts one Steam-verified identity may create. `0` disables. |
| `RECFLARE_MAX_ACCOUNTS_PER_IP`          | `auth`  | `3`     | Accounts one signup IP may create. `0` disables.               |
| `RECFLARE_STARTING_TOKENS`              | `econ`  | `10000` | RecCenterTokens a new player is granted.                       |

Then deploy just the worker that reads it:

```bash
just deploy -F auth
```

A line you leave out of `.env` keeps its default, so only copy over what you actually want
to change — and deleting a line you'd set restores the default on the next deploy. The same
`.env` feeds `just dev`, so a knob is configured once and behaves the same locally as it
does deployed.

Adding a knob of your own takes no changes to the deploy tooling. Every `RECFLARE_*` in
`.env` is handed to the workers as a variable under its unprefixed name — `RECFLARE_STARTING_TOKENS`
arrives as `STARTING_TOKENS` — so a new one only needs declaring in that worker's
`src/context.ts` and reading in its code. Every worker receives every knob and ignores the
ones it doesn't read, which is also how two services can share a value. (The domain and the
resource ids above are the exception: those configure the deploy itself and are never
passed to a worker.)

Both account caps are enforced on signup only, never on login — an existing account always
stays reachable no matter how many its owner has accumulated. The per-IP cap is the coarse
one: households, NAT and shared campus/mobile networks put many legitimate players behind a
single address, so raise it (or set it to `0`) if real players report being locked out.

> **Don't set these as Worker variables in the Cloudflare dashboard.** A deploy replaces a
> worker's variables wholesale, so a dashboard-set value is wiped by your next
> `just deploy`. `.env` is the durable place. Real secrets don't belong there either — they
> go in the Cloudflare Secrets Store, like the shared `JWT_SECRET` above.

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
