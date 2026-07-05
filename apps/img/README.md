# img

Image-delivery worker served on the `img` subdomain.

Images are stored as objects in the **`recflare-img` R2 bucket** and streamed back by
key:

- `GET /` — service status `{ "service": "img", "status": "ok" }`.
- `GET /<key>` — streams the matching R2 object (e.g.
  `GET /DefaultProfileImage.jpg`). The key may contain slashes for nested
  objects. Content-Type comes from the object's stored HTTP metadata. Supports
  conditional requests via `If-None-Match` (returns `304`). Missing keys fall
  back to the bundled `static/DefaultProfileImage.jpg` asset (served `200` via
  the `ASSETS` binding), so clients always get a valid image. The fallback also
  honours `?sig=p1` and returns a `Content-Signature` header.
- `GET /<key>?sig=p1` — same, but the response body is RSA-SHA1 signed and the
  signature returned in a `Content-Signature: key-id=KEY:RSA:p1.rec.net; data=<base64>`
  header. The client uses this to verify image integrity. Signing buffers the
  whole object.

The bucket is bound in the Worker as `env.IMAGES` (see `wrangler.jsonc`).

## Response signing key

`?sig=p1` signs with the RSA-2048 key in `env.IMG_SIGNING_KEY` (PKCS8 DER,
base64). `wrangler.jsonc` ships an **insecure dev key** for local dev / tests;
in production override it with a real secret:

```sh
wrangler secret put IMG_SIGNING_KEY   # paste base64 PKCS8 DER of the private key
```

The matching public key must be published wherever the client looks up
`KEY:RSA:p1.rec.net` so it can verify responses. Generate a keypair with:

```sh
node -e "const{generateKeyPairSync}=require('crypto');const{publicKey,privateKey}=generateKeyPairSync('rsa',{modulusLength:2048});console.log('PRIVATE',privateKey.export({type:'pkcs8',format:'der'}).toString('base64'));console.log('PUBLIC',publicKey.export({type:'spki',format:'der'}).toString('base64'))"
```

## One-time bucket setup

```sh
wrangler r2 bucket create recflare-img
```

## Seeding / uploading images

A starter image lives in `static/` so it can be uploaded to R2:

```sh
wrangler r2 object put recflare-img/DefaultProfileImage.jpg \
  --file=apps/img/static/DefaultProfileImage.jpg \
  --content-type=image/jpeg --remote
```

(Drop `--remote` to write to the local dev bucket used by `pnpm dev`.)

## Development

```sh
pnpm dev    # run locally
pnpm test   # run tests
```
