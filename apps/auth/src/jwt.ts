/**
 * Minimal HS256 JWT generation.
 *
 * The signing key is supplied by the caller from the `JWT_SECRET` binding
 * (a Cloudflare secret in deployed envs, `.dev.vars` locally) — see context.ts.
 */

/** Token lifetime in seconds (mirrored in the `expires_in` response field). */
export const TOKEN_TTL_SECONDS = 3600

function base64url(input: ArrayBuffer | string): string {
	const bytes = typeof input === 'string' ? new TextEncoder().encode(input) : new Uint8Array(input)
	let binary = ''
	for (const byte of bytes) {
		binary += String.fromCharCode(byte)
	}
	return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function base64urlToBytes(input: string): Uint8Array {
	const padded = input.replace(/-/g, '+').replace(/_/g, '/')
	const binary = atob(padded + '='.repeat((4 - (padded.length % 4)) % 4))
	const bytes = new Uint8Array(binary.length)
	for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
	return bytes
}

/**
 * Validate an HS256 token and return its `sub` (account id) claim, or `null` when
 * the token is malformed, has a bad signature, or is expired.
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
	if (typeof claims.exp === 'number' && claims.exp < Math.floor(Date.now() / 1000)) return null
	return claims.sub ?? null
}

/** Scopes stamped onto every token (as a claim array). */
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

/** Roles granted — the client needs `gameClient` to operate. */
const TOKEN_ROLES = ['gameClient', /* 'developer', 'moderator', 'junior'*/];

export async function generateToken(
	accountId: string,
	platformId: string,
	platform: string,
	secret: string
): Promise<string> {
	const now = Math.floor(Date.now() / 1000)
	const header = { alg: 'HS256', typ: 'JWT' }
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
