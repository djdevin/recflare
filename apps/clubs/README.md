# clubs

Clubs Worker served at `clubs.rec.djdevin.net`. A Hono app ported from the C#
`ClubsController`.

## Behavior

- `GET /club/home/me` — returns 404. The C# source returned `Results.NotFound()`
  unconditionally; there's nothing to hydrate yet.

## TODO before production

- Implement club home once clubs have a backing store (DB binding).
