# clubs

Clubs Worker served on the `clubs` subdomain. A Hono app for clubs.

## Behavior

- `GET /club/home/me` — returns 404 unconditionally; there's nothing to hydrate
  yet.

## TODO before production

- Implement club home once clubs have a backing store (DB binding).
