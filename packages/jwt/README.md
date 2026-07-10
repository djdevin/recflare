# jwt

Shared HS256 JWT helpers for the recflare workers. Single source of truth for
token validation and generation, so the same signing/verification code isn't
re-copied per worker.

`auth` signs tokens (`generateToken`); every worker validates the incoming
Bearer token (`validateAndGetAccountId`). Both take the signing key from the
shared `JWT_SECRET` binding (see each worker's `context.ts`).
