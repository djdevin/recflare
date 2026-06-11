# econ

Economy Worker served at `econ.rec.djdevin.net`. Hosts the avatar/economy
endpoints the game client calls on the `econ` service (distinct from the main
`api` worker). DB-backed data is stubbed for now — no bindings yet.

## Endpoints

- `GET /api/avatar/v1/defaultunlocked` — default-unlocked avatar items. Returns
  an empty array until there's a DB binding.

## TODO before production

- Wire a DB binding for the default-unlocked item set.
