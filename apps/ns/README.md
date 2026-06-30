# ns

Name-server / service-discovery worker served on the `ns` subdomain.

`GET /` returns the endpoints document the game client fetches on startup to
discover every service host (Accounts, API, Auth, Econ, Matchmaking,
Notifications, …).

Each host is built at runtime from the `DOMAIN` var (the base domain) plus the
service → subdomain map in `src/endpoints.ts`. `DOMAIN` is injected at deploy
time from the repo-root `env.json` (see `run-wrangler-deploy`) and defaults to
`rec.example.com` in `wrangler.jsonc` for local dev.

## Updating endpoints

- To change the base domain, edit `domain` in `env.json` and redeploy.
- To add or rename a service host, edit the map in `src/endpoints.ts`.
