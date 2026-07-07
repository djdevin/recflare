/**
 * Minimal HS256 JWT validation.
 *
 * The signing key is supplied by the caller from the shared `JWT_SECRET` Secrets
 * Store binding (see context.ts) - the same key the `auth` worker signs with.
 */

function base64urlToBytes(input: string): Uint8Array {
	const padded = input.replace(/-/g, '+').replace(/_/g, '/')
	const binary = atob(padded + '='.repeat((4 - (padded.length % 4)) % 4))
	const bytes = new Uint8Array(binary.length)
	for (let i = 0; i < binary.length; i++) {
		bytes[i] = binary.charCodeAt(i)
	}
	return bytes
}

/**
 * Validate an HS256 token and return its `sub` (account id) claim, or `null`
 * when the token is malformed, has a bad signature, or is expired.
 */
export async function validateAndGetAccountId(
	token: string,
	secret: string
): Promise<string | null> {
	const parts = token.split('.')
	if (parts.length !== 3) return null
	const [header, payload, signature] = parts

	const key = await crypto.subtle.importKey(
		'raw',
		new TextEncoder().encode(secret),
		{ name: 'HMAC', hash: 'SHA-256' },
		false,
		['verify']
	)
	const valid = await crypto.subtle.verify(
		'HMAC',
		key,
		base64urlToBytes(signature),
		new TextEncoder().encode(`${header}.${payload}`)
	)
	if (!valid) return null

	let claims: { sub?: string; exp?: number }
	try {
		claims = JSON.parse(new TextDecoder().decode(base64urlToBytes(payload)))
	} catch {
		return null
	}

	if (typeof claims.exp === 'number' && claims.exp < Math.floor(Date.now() / 1000)) {
		return null
	}

	return claims.sub ?? null
}
