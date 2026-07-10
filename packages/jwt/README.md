# jwt

Shared HS256 JWT helpers for the recflare workers. Single source of truth for
token validation and generation, so the same signing/verification code isn't
re-copied per worker.

`auth` signs tokens (`generateToken`); every worker validates a request and
resolves the caller's integer account id (`validateAndGetAccountId`, which takes
the whole `Request` so how auth is carried can change in one place). Both take
the signing key from the shared `JWT_SECRET` binding (see each worker's
`context.ts`).
