# chat

Chat worker served at `chat.rec.djdevin.net`.

- `GET /` — service status `{ "service": "chat", "status": "ok" }`.
- `GET /thread` — chat threads. No DB binding yet, so returns `[]` (matching the
  C# `ChatController.Get`).

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
