# econ

Economy Worker served at `econ.rec.djdevin.net`. Hosts the avatar/economy
endpoints the game client calls on the `econ` service (distinct from the main
`api` worker). DB-backed data is stubbed for now — no bindings yet.

## Endpoints

- `GET /api/avatar/v1/defaultunlocked` — default-unlocked avatar items, served
  from the bundled `static/default-avatar-items.json` catalog.
- `GET /api/avatar/v1/defaultbaseavataritems` — default base avatar items. The C#
  reads the same source file as `defaultunlocked`, so it returns the identical
  catalog.
- `GET /api/avatar/v4/items` — `[Authorize]`. The player's avatar items: owned
  items concatenated with the default catalog. No DB binding yet, so owned is
  empty and this returns just the catalog.
- `GET /api/avatar/v2` — `[Authorize]`. The player's avatar. No DB binding yet,
  so it returns the default `{ OutfitSelections, FaceFeatures, SkinColor,
HairColor }` the C# seeds for a new player.
- `GET /econ/customAvatarItems/v1/owned` — the player's owned custom avatar
  items. No auth (matching the C#); returns `{ items: [] }` with no DB binding.
  The client requests this when custom-item creation is allowed, so a missing
  route here shows up as "Failed to download unlocked avatar items".
- `GET /api/objectives/v1/myprogress` — objectives progress. No auth (matching
  the C#, which serves a static JSON file verbatim); returns the bundled
  `static/my-progress.json` default for all players until a DB binding exists.
- `GET /api/avatar/v3/saved` — `[Authorize]`. Saved outfits; `[]` without a DB.
- `GET /api/avatar/v2/gifts` — `[Authorize]`. Pending gifts; `[]` without a DB.
- `GET /api/equipment/v2/getUnlocked` — unlocked equipment; `[]` (no auth).
- `POST /api/settings/v2/set` — `[Authorize]`. Persist settings; 200 ack only.
- `GET /api/consumables/v2/getUnlocked` — `[Authorize]`. `[]` without a DB.
- `GET /api/storefronts/v4/balance/2` — `[Authorize]`. Token balance; `[]`.
- `GET /api/storefronts/v3/giftdropstore/3` — gift-drop storefront, served from
  the bundled `static/storefronts-v3-giftdropstore-3.json`.
- `GET /api/challenge/v2/getCurrent` — current weekly challenge, served from the
  bundled `static/weekly-challenge.json` (the C#'s `JSON/weeklychallenge.json`).
- `GET /api/gamerewards/v1/pending` — pending rewards; `[]`.
- `GET /api/roomkeys/v1/mine` — the player's room keys; `[]`.
- `POST /api/CampusCard/v1/UpdateAndGetSubscription` — subscription lookup;
  `{ subscription: null, platformAccountSubscribedPlayerId: null }`.
- Not in CannedNet (stubbed): `GET /api/roomconsumables/v1/roomConsumable/room/:id`
  and `GET /api/roomcurrencies/v1/currencies` both return `[]`.

These EconController routes are also served by the `api` worker; they're
duplicated here because the client calls them on the `econ` host.

## TODO before production

- Wire a DB binding and prepend each player's owned `AvatarItems` to
  `/api/avatar/v4/items`.
