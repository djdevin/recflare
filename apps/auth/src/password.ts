/**
 * Password hashing for /connect/token credential login and
 * /account/me/changepassword. PBKDF2-SHA256 with a random per-password salt,
 * stored as `salt:hash` (both base64). The raw password is never persisted.
 */
const ITERATIONS = 100_000

const b64 = (bytes: Uint8Array): string => btoa(String.fromCharCode(...bytes))
const fromB64 = (s: string): Uint8Array => Uint8Array.from(atob(s), (ch) => ch.charCodeAt(0))

async function deriveBits(password: string, salt: Uint8Array): Promise<Uint8Array> {
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
