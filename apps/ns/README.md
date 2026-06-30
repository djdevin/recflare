# ns

Name-server / service-discovery worker served on the `ns` subdomain.

`GET /` returns the endpoints document the game client fetches on startup to
discover every service host (Accounts, API, Auth, Econ, Matchmaking,
Notifications, …).

The document is served from `static/endpoints.json`, whose hosts are generated
from the repo-root `env.json` by `runx sync` — every entry is derived from the
configured base `domain`.

## Updating endpoints

Change `domain` in `env.json` (or edit the host map in `static/endpoints.json`),
then regenerate:

```sh
just sync
```

(Bundled at build time, so a redeploy is required for changes to take effect.)
