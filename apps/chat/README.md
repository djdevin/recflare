# chat

Chat worker served on the `chat` subdomain.

- `GET /` — service status `{ "service": "chat", "status": "ok" }`.
- `GET /thread` — chat threads. No DB binding yet, so returns `[]`.

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
