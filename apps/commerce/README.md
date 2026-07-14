# commerce

A Cloudflare Workers application using Hono

## Endpoints

- `GET /purchase/v1/hasspentmoney` — whether the player has ever spent money;
  `false`.
- `GET /api/catalog/v1/all` — the purchasable SKU catalog (token packs, special
  offers), served from the bundled `static/catalog-v1-all.json`. The client's
  `?onlyAvailableSkus=true` is accepted and ignored: the bundled catalog already
  contains only available SKUs.

## Development

### Run in dev mode

```sh
pnpm dev
```

### Run tests

```sh
pnpm test
```

### Deploy

```sh
pnpm turbo deploy
```
