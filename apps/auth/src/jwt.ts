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
	const bytes = typeof input === 'string' ? new TextEncoder().encode(input) : new Uint8Array(input)
	let binary = ''
	for (const byte of bytes) {
		binary += String.fromCharCode(byte)
	}
	return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/** Scopes the C# `JwtTokenService` stamps onto every token (as a claim array). */
const TOKEN_SCOPES = [
	'profile',
	'rn',
	'rn.accounts',
	'rn.accounts.gc',
	'rn.api',
	'rn.chat',
	'rn.clubs',
	'rn.commerce',
	'rn.match.read',
	'rn.match.write',
	'rn.notify',
	'rn.rooms',
	'rn.storage',
	'offline_access',
]

/** Roles the C# grants — the client needs `gameClient` to operate. */
const TOKEN_ROLES = ['gameClient', 'developer', 'moderator']

export async function generateToken(
	accountId: string,
	platformId: string,
	platform: string,
	secret: string = DEV_SECRET
): Promise<string> {
	const now = Math.floor(Date.now() / 1000)
	const header = { alg: 'HS256', typ: 'JWT' }
	// Mirror the claim set produced by the C# `JwtTokenService.GenerateToken`.
	// The client reads `role`/`scope` (and expects a well-formed iss/aud) to
	// authorize itself; a token with only `sub` is rejected before login finishes.
	const payload = {
		iss: 'https://auth.lapis.codes',
		aud: 'https://auth.lapis.codes/resources',
		nbf: now,
		iat: now,
		exp: now + TOKEN_TTL_SECONDS,
		auth_time: now,
		amr: 'cached_login',
		client_id: 'recroom',
		sub: accountId,
		idp: 'local',
		platform,
		platform_id: platformId,
		'rn.ver': '20210129',
		'rn.plat': '0',
		role: TOKEN_ROLES,
		scope: TOKEN_SCOPES,
		jti: crypto.randomUUID().replace(/-/g, '').toUpperCase(),
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
