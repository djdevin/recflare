# ns

Name-server / service-discovery worker served at `ns.rec.djdevin.net`.

`GET /` returns the endpoints document the game client fetches on startup to
discover every service host (Accounts, API, Auth, Econ, Matchmaking,
Notifications, …).

The document is served from `static/endpoints.json` (a snapshot downloaded from
the live host). **It will be generated dynamically eventually** — e.g. per
environment / from the deployed routes — at which point the static file goes
away.

## Updating the snapshot

```sh
curl -sS https://rec.djdevin.net/ -o apps/ns/static/endpoints.json
```

(Bundled at build time, so a redeploy is required for changes to take effect.)
