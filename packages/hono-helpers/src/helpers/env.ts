/**
 * Read an integer worker var, falling back to `fallback` when it is unset or unusable.
 *
 * A var arrives as a number when it's declared in wrangler.jsonc `vars`, but as a string
 * when it's set anywhere else (the dashboard, `wrangler deploy --var`, `.dev.vars`), so
 * both have to be accepted — the same var is a different type depending on where the
 * operator set it.
 *
 * Anything that isn't a finite integer (an empty string, a typo, `3.5`) is treated as
 * unset rather than coerced: `Number.parseInt` would read `"3abc"` as 3 and `"3.9"` as 3,
 * which turns a typo into a silently wrong limit. Falling back to the documented default
 * is the safe failure here.
 */
export function intVar(value: unknown, fallback: number): number {
	if (typeof value === 'number') return Number.isInteger(value) ? value : fallback
	if (typeof value !== 'string' || value.trim() === '') return fallback
	const parsed = Number(value)
	return Number.isInteger(parsed) ? parsed : fallback
}
