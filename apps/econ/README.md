# econ

Economy Worker served on the `econ` subdomain (`econ.recflare.net`). Hosts the
avatar/economy endpoints the game client calls on the `econ` service (distinct from the
main `api` worker, which also serves many of them — the client may call either host).

Balances, inventory, consumables, saved outfits, avatars and gift boxes are D1-backed;
storefront catalogs are static assets (`static/storefronts/sf{N}.json`) served via the
ASSETS binding. Several routes are still empty-list stubs.

## Routes

`✓` = auth-gated (validates the Bearer JWT from the `auth` worker; empty-body 401 when
missing/invalid).

| Method   | Path                                                 | Auth | Description                             |
| -------- | ---------------------------------------------------- | ---- | --------------------------------------- |
| GET      | `/api/avatar/v1/defaultunlocked`                     |      | Default-unlocked avatar items (static)  |
| GET      | `/api/avatar/v1/defaultbaseavataritems`              |      | Default base avatar items (stub `[]`)   |
| GET      | `/api/avatar/v4/items`                               | ✓    | Owned items + the default catalog       |
| GET      | `/econ/customAvatarItems/v1/owned`                   | ✓    | Owned custom avatar items (stub)        |
| GET      | `/api/objectives/v1/myprogress`                      |      | Objectives progress (static)            |
| GET/POST | `/api/objectives/v1/cleargroup`                      |      | Clear an objectives group (no-op `[]`)  |
| GET      | `/api/avatar/v2`                                     | ✓    | The player's own avatar                 |
| POST     | `/api/avatar/v2/set`                                 | ✓    | Save the player's avatar                |
| GET      | `/api/checklist/v1/current`                          | ✓    | NUX checklist (stub `[]`)               |
| GET      | `/api/itemWishlists/v1/wishlist/me`                  | ✓    | Item wishlist (stub `[]`)               |
| GET      | `/api/avatar/v3/saved`                               | ✓    | Saved outfits                           |
| POST     | `/api/avatar/v3/saved/set`                           | ✓    | Save an outfit into a slot              |
| GET      | `/api/avatar/v2/gifts`                               | ✓    | Pending (unopened) gift boxes           |
| POST     | `/api/avatar/v2/gifts/consume`                       |      | Open a gift box → success envelope      |
| GET      | `/api/avatar/v2/:id`                                 |      | Another player's avatar (render subset) |
| GET      | `/api/equipment/v2/getUnlocked`                      |      | Unlocked equipment (stub `[]`)          |
| GET      | `/api/roomconsumables/v1/roomConsumable/room/:id`    |      | Room consumables (stub `[]`)            |
| GET      | `/api/roomconsumables/v1/roomConsumable/room/:id/me` |      | Caller's room consumables (stub `[]`)   |
| GET      | `/api/roomcurrencies/v1/currencies`                  |      | Room currencies (stub `[]`)             |
| GET      | `/api/roomcurrencies/v1/getAllBalances`              |      | Room balances (stub `[]`)               |
| POST     | `/api/settings/v2/set`                               | ✓    | Persist settings (accept-and-ack)       |
| GET      | `/api/consumables/v2/getUnlocked`                    | ✓    | Unlocked consumables                    |
| POST     | `/api/consumables/v1/consume`                        | ✓    | Consume an owned consumable             |
| GET      | `/api/storefronts/v4/balance/:currencyType`          | ✓    | Currency balance                        |
| GET      | `/api/storefronts/v3/giftdropstore/:id`              |      | Gift-drop storefront catalog            |
| POST     | `/api/storefronts/v2/buyItem`                        | ✓    | Buy a storefront item                   |
| GET      | `/api/storefronts/v1/adcarouselitems`                |      | Ad-carousel items (static)              |
| GET      | `/api/challenge/v2/getCurrent`                       |      | Current weekly challenge (static)       |
| POST     | `/api/challenge/v2/updateProgress`                   |      | Report challenge progress (stub)        |
| GET      | `/api/gamerewards/v1/pending`                        |      | Pending game rewards (stub `[]`)        |
| POST     | `/api/gamerewards/v1/request`                        |      | Request a game reward (stub `[]`)       |
| GET      | `/api/roomkeys/v1/mine`                              |      | The player's room keys (stub `[]`)      |
| GET      | `/api/roomkeys/v1/room`                              |      | Room keys for a room (stub `[]`)        |
| POST     | `/api/CampusCard/v1/UpdateAndGetSubscription`        |      | Subscription lookup (both null)         |
| GET      | `/openapi.json`                                      |      | Generated OpenAPI 3.1 spec (see below)  |

The app runs with `strict: false`, so trailing-slash variants match (the client posts
`/gifts/consume/` with a trailing slash).

## API documentation

`GET /openapi.json` serves a spec generated from `describeRoute` blocks alongside each
handler, with the schemas in `src/openapi.ts`. **Descriptive, not enforced** — same
rationale as the `auth`/`accounts`/`match` workers. A test asserts every route appears
in the spec, so adding one without documenting it fails.

## Purchases (`buyItem`)

The core flow. The client posts the storefront/item ids, the currency, and the
`RequestedPrice` it rendered; the handler:

1. looks the item up in `static/storefronts/sf{StorefrontType}.json`;
2. rejects a stale price (`409`) — this stops a stale or tampered client buying at a
   price the catalog no longer offers;
3. debits the buyer **atomically** (`400` on insufficient balance);
4. grants the drop — an avatar item into the `inventory` table (own-once), a consumable
   into the `consumable` table (each buy stacks a new instance); currency/xp drops
   aren't granted yet;
5. returns a **gift box** and pushes a `StorefrontBalanceUpdate` over the socket.

Two things are easy to get wrong:

- **`Balance` in the response is the _change_ applied** (the negated price), not the
  resulting total. The client reads its new total from `GET /balance/:type`.
- **Ownership is persisted at purchase**, not when the box is opened. Opening a box
  (`/gifts/consume`) just deletes it — the item was already granted. So the grant never
  waits on the cosmetic "open it" moment.

A `Gift` block routes the item (and box) to another player, but the caller always pays.
A self-buy or anonymous gift is attributed to the "Coach" system account (id 1).

## Consume envelopes

Both consume routes (`/gifts/consume`, `/consumables/consume`) always answer HTTP 200
with `{ error: "", success: true, value: null }` — even for a missing or already-gone
target. A captured real consume returns this envelope, not an empty body: the client
parses it to finish the action, so a bare 200 reads as a failure and the item never
finishes unlocking. Deletes are scoped to the caller, so an unauthenticated or
mismatched call is a harmless no-op (opening _another_ player's box is a 403).

## Bindings

| Binding                      | Type           | Notes                                                    |
| ---------------------------- | -------------- | -------------------------------------------------------- |
| `DB`                         | D1             | Shared `recflare` database — balances, inventory, etc.   |
| `JWT_SECRET`                 | Secrets Store  | Shared HS256 signing key (see the `auth` README)         |
| `ASSETS`                     | static assets  | Serves `sf{N}.json` storefront catalogs                  |
| `RECFLARE_NOTIFICATIONS_HUB` | Durable Object | Cross-worker RPC to the `notify` worker's hub            |
| `STARTING_TOKENS`            | var            | Optional; new-player token grant (default in balance-db) |

Add a storefront by dropping a new `sfN.json` in `static/storefronts` — no code change.

## Known gaps

- Gifting to another player grants the item and box but does not notify the recipient.
- `buyItem` grants avatar-item and consumable drops; currency/xp drops aren't granted.
- Consumables are granted and listed but never spent by gameplay, so `Count` only grows.
- Several routes (room keys, wishlist, equipment, room consumables/currencies, game
  rewards) are empty-list stubs pending their own stores.
