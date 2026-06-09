/**
 * Minimal HS256 JWT generation, mirroring the C# `JwtTokenService.GenerateToken`.
 *
 * No real signing-key binding yet — uses a placeholder dev secret. Swap this for
 * a secret binding (e.g. `c.env.JWT_SECRET`) before this is used for anything real.
 */
const DEV_SECRET = 'dev-insecure-signing-key-change-me'

/** Token lifetime in seconds (matches `expires_in` in the C# response). */
export const TOKEN_TTL_SECONDS = 3600

function base64url(input: ArrayBuffer | string): string {
	const bytes =
		typeof input === 'string' ? new TextEncoder().encode(input) : new Uint8Array(input)
	let binary = ''
	for (const byte of bytes) {
		binary += String.fromCharCode(byte)
	}
	return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

export async function generateToken(
	accountId: string,
	platformId: string,
	platform: string,
	secret: string = DEV_SECRET
): Promise<string> {
	const now = Math.floor(Date.now() / 1000)
	const header = { alg: 'HS256', typ: 'JWT' }
	const payload = {
		sub: accountId,
		platform_id: platformId,
		platform,
		iat: now,
		exp: now + TOKEN_TTL_SECONDS,
	}

	const signingInput = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(payload))}`

	const key = await crypto.subtle.importKey(
		'raw',
		new TextEncoder().encode(secret),
		{ name: 'HMAC', hash: 'SHA-256' },
		false,
		['sign']
	)
	const signature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(signingInput))

	return `${signingInput}.${base64url(signature)}`
}
