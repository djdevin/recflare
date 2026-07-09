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
3. None of them had unit tests, so servers are constantly buggy.
4. "Upgrading the server" is not sustainable plan for growth.
5. This was fun (sort of). The goal was to build a project that everyone could use. No gatekeeping or viruses.

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

See [SERVICES.md](SERVICES.md)

## Deploying

Want to run it yourself? See [DEPLOYING.md](DEPLOYING.md)

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
