import { validateAndGetAccountId } from '@repo/jwt'

import type { Context } from 'hono'
import type { App } from './context'

/**
 * Resolve the account id from a Bearer token, mirroring the repeated
 * auth-header check. Returns `null` when the header is missing,
 * the token is invalid, or the `sub` claim isn't an integer.
 */
export async function authedId(c: Context<App>): Promise<number | null> {
	const authHeader = c.req.header('Authorization') ?? ''
	if (!authHeader.toLowerCase().startsWith('bearer ')) return null

	const token = authHeader.slice('Bearer '.length)
	const accountId = await validateAndGetAccountId(token, await c.env.JWT_SECRET.get())
	if (!accountId) return null

	const id = Number.parseInt(accountId, 10)
	return Number.isNaN(id) ? null : id
}

/** Results.Unauthorized() equivalent — 401 with empty body. */
export function unauthorized(c: Context<App>) {
	return c.body(null, 401)
}

/** Reads the `Ids` form field into a list of integer ids. */
export async function parseFormIds(c: Context<App>): Promise<number[]> {
	const body = await c.req.parseBody().catch(() => ({}) as Record<string, unknown>)
	const ids = body.Ids
	if (typeof ids !== 'string') return []
	return ids
		.split(',')
		.map((s) => Number.parseInt(s.trim(), 10))
		.filter((n) => !Number.isNaN(n))
}

/** Read integer ids from repeated/comma-separated `id` query params. The 2023
 * client passes these to the bulk GET endpoints (e.g. `?id=1&id=2`). */
export function queryIds(c: Context<App>): number[] {
	return (
		c.req
			.queries('id')
			?.flatMap((v) => v.split(','))
			.map((s) => Number.parseInt(s.trim(), 10))
			.filter((n) => !Number.isNaN(n)) ?? []
	)
}
