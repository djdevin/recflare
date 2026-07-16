/**
 * Password hashing for the `admin` CLI. This is a deliberate copy of the canonical
 * implementation in `@repo/domain` (packages/domain/src/password.ts), which the auth
 * worker uses to verify logins. It's duplicated rather than imported because
 * `@repo/tools` cannot depend on a workspace package (every package depends on
 * `@repo/tools` for its scripts, so importing one back would be a dependency cycle).
 *
 * The format MUST stay identical to the canonical version or a password set by the
 * CLI won't verify at login — `password.spec.ts` round-trips a hash to catch drift.
 * PBKDF2-SHA256, random 16-byte salt, stored as `salt:hash` (both base64).
 */
const ITERATIONS = 100_000

const b64 = (bytes: Uint8Array): string => btoa(String.fromCharCode(...bytes))
const fromB64 = (s: string): Uint8Array<ArrayBuffer> =>
	Uint8Array.from(atob(s), (ch) => ch.charCodeAt(0))

async function deriveBits(password: string, salt: Uint8Array<ArrayBuffer>): Promise<Uint8Array> {
	const keyMaterial = await crypto.subtle.importKey(
		'raw',
		new TextEncoder().encode(password),
		'PBKDF2',
		false,
		['deriveBits']
	)
	const bits = await crypto.subtle.deriveBits(
		{ name: 'PBKDF2', salt, iterations: ITERATIONS, hash: 'SHA-256' },
		keyMaterial,
		256
	)
	return new Uint8Array(bits)
}

/** Hash a password into a `salt:hash` string (both base64). */
export async function hashPassword(password: string): Promise<string> {
	const salt = crypto.getRandomValues(new Uint8Array(16))
	return `${b64(salt)}:${b64(await deriveBits(password, salt))}`
}

/** Verify a password against a stored `salt:hash`. */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
	const [saltB64, hashB64] = stored.split(':')
	if (!saltB64 || !hashB64) return false
	const actual = b64(await deriveBits(password, fromB64(saltB64)))
	return actual === hashB64
}
