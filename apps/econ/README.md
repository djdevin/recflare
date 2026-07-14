# econ

Economy Worker served on the `econ` subdomain. Hosts the avatar/economy
endpoints the game client calls on the `econ` service (distinct from the main
`api` worker). DB-backed data is stubbed for now — no bindings yet.

## Endpoints

- `GET /api/avatar/v1/defaultunlocked` — default-unlocked avatar items, served
  from the bundled `static/default-avatar-items.json` catalog.
- `GET /api/avatar/v1/defaultbaseavataritems` — default base avatar items. Reads
  the same source file as `defaultunlocked`, so it returns the identical
  catalog.
- `GET /api/avatar/v4/items` — `[Authorize]`. The player's avatar items: the
  items they've bought (from `buyItem`, in the `inventory` table) prepended to
  the default catalog. A player who has bought nothing gets just the catalog.
- `GET /api/avatar/v2` — `[Authorize]`. The player's avatar. No DB binding yet,
  so it returns the default `{ OutfitSelections, FaceFeatures, SkinColor,
HairColor }` seeded for a new player.
- `GET /econ/customAvatarItems/v1/owned` — the player's owned custom avatar
  items. No auth; returns `{ items: [] }` with no DB binding.
  The client requests this when custom-item creation is allowed, so a missing
  route here shows up as "Failed to download unlocked avatar items".
- `GET /api/objectives/v1/myprogress` — objectives progress. No auth (serves a
  static JSON file verbatim); returns the bundled
  `static/my-progress.json` default for all players until a DB binding exists.
- `GET /api/avatar/v3/saved` — `[Authorize]`. Saved outfits; `[]` without a DB.
- `GET /api/avatar/v2/gifts` — `[Authorize]`. The player's unopened gift boxes
  (from their purchases), out of the shared `received_gift` table; `[]` when
  they have none.
- `POST /api/avatar/v2/gifts/consume` — open a box (form body `Id=<n>&UnlockedLevel=<n>`,
  posted with a trailing slash). Deletes the box scoped to the caller; the item was
  already granted at purchase, so this is cosmetic. Always answers an empty `200`, even
  for a missing/already-opened box, so a fire-and-forget re-open never errors. Also
  served by the `api` worker (the client may call either host).
- `POST /api/storefronts/v2/buyItem` — `[Authorize]`. Buy a storefront item.
  Looks the item up in `static/storefronts/sf{StorefrontType}.json`, confirms the
  client's `RequestedPrice` still matches, debits the buyer atomically, grants the
  item into the `inventory` table, and returns a gift box. `409` on a stale price,
  `404` on an unknown item, `400` on insufficient balance.
- `GET /api/equipment/v2/getUnlocked` — unlocked equipment; `[]` (no auth).
- `POST /api/settings/v2/set` — `[Authorize]`. Persist settings; 200 ack only.
- `GET /api/consumables/v2/getUnlocked` — `[Authorize]`. `[]` without a DB.
- `GET /api/storefronts/v4/balance/2` — `[Authorize]`. Token balance; `[]`.
- `GET /api/storefronts/v3/giftdropstore/3` — gift-drop storefront, served from
  the bundled `static/storefronts-v3-giftdropstore-3.json`.
- `GET /api/storefronts/v1/adcarouselitem` — storefront ad-carousel items,
  served from the bundled `static/ad-carousel-items.json` (one placeholder
  banner until real promo data exists).
- `GET /api/challenge/v2/getCurrent` — current weekly challenge, served from the
  bundled `static/weekly-challenge.json`.
- `GET /api/gamerewards/v1/pending` — pending rewards; `[]`.
- `GET /api/roomkeys/v1/mine` — the player's room keys; `[]`.
- `POST /api/CampusCard/v1/UpdateAndGetSubscription` — subscription lookup;
  `{ subscription: null, platformAccountSubscribedPlayerId: null }`.
- Stubbed: `GET /api/roomconsumables/v1/roomConsumable/room/:id`
  and `GET /api/roomcurrencies/v1/currencies` both return `[]`.

These economy routes are also served by the `api` worker; they're
duplicated here because the client calls them on the `econ` host.

## TODO before production

- Gifting to another player (`buyItem` with a `Gift` block) grants the item and
  box to the recipient, but there's no notification and no consumable/currency
  gift-drops yet — `buyItem` only grants avatar items.
