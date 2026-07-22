import type { Handler, MiddlewareHandler } from 'hono'

/**
 * Zod 4 encodes `z.int()` as `{ type: 'integer', minimum: -9007199254740991, maximum:
 * 9007199254740991 }` — the safe-integer range. That is accurate, but Scalar (and most
 * spec viewers) derive the displayed example from `minimum` when a schema carries no
 * `example` of its own, so every integer field in the docs rendered as
 * `-9007199254740991`.
 *
 * The bounds are left alone; we just supply a neutral placeholder so the viewer has
 * something better to show.
 */
const PLACEHOLDER_INTEGER = 12345

/** Recursively add a placeholder example to integer schemas that lack one. */
function addIntegerExamples(node: unknown): void {
	if (Array.isArray(node)) {
		for (const item of node) addIntegerExamples(item)
		return
	}
	if (node === null || typeof node !== 'object') return

	const obj = node as Record<string, unknown>
	if (obj.type === 'integer' && obj.example === undefined && obj.examples === undefined) {
		// Don't contradict a schema that really is narrow (`z.int().max(10)`, an enum-ish
		// range) — the placeholder only goes in where it's a legal value.
		const min = obj.minimum
		const max = obj.maximum
		const tooLow = typeof min === 'number' && PLACEHOLDER_INTEGER < min
		const tooHigh = typeof max === 'number' && PLACEHOLDER_INTEGER > max
		if (!tooLow && !tooHigh) obj.example = PLACEHOLDER_INTEGER
	}
	for (const value of Object.values(obj)) addIntegerExamples(value)
}

/**
 * Wrap `openAPIRouteHandler(...)` so the generated document gets example values for its
 * integer fields. Purely cosmetic — nothing about the documented shapes changes.
 *
 * ```ts
 * app.get('/openapi.json', describeRoute({ hide: true }), withCleanSpec(openAPIRouteHandler(app, { ... })))
 * ```
 */
export function withCleanSpec(handler: Handler | MiddlewareHandler): Handler {
	return async (c, next) => {
		const res = await (handler as Handler)(c, next)
		if (!(res instanceof Response)) return res as never
		const spec: unknown = await res.json()
		addIntegerExamples(spec)
		return c.json(spec as Record<string, unknown>)
	}
}
