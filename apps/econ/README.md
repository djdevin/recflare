# econ

Economy Worker served at `econ.rec.djdevin.net`. Hosts the avatar/economy
endpoints the game client calls on the `econ` service (distinct from the main
`api` worker). DB-backed data is stubbed for now — no bindings yet.

## Endpoints

- `GET /api/avatar/v1/defaultunlocked` — default-unlocked avatar items, served
  from the bundled `static/default-avatar-items.json` catalog.
- `GET /api/avatar/v4/items` — `[Authorize]`. The player's avatar items: owned
  items concatenated with the default catalog. No DB binding yet, so owned is
  empty and this returns just the catalog.
- `GET /api/avatar/v2` — `[Authorize]`. The player's avatar. No DB binding yet,
  so it returns the default `{ OutfitSelections, FaceFeatures, SkinColor,
  HairColor }` the C# seeds for a new player.

## TODO before production

- Wire a DB binding and prepend each player's owned `AvatarItems` to
  `/api/avatar/v4/items`.
