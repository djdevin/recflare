/**
 * Offline verification of a Steam `platform_auth` ticket, Worker-native.
 *
 * A Steam login posts `platform_auth = {"Ticket":"<hex>","AppId":"471710"}`. The
 * ticket's ownership section is signed by Steam's "System" RSA key (RSA-SHA1), so
 * we can verify it OFFLINE — no publisher Web API key, no network — and trust the
 * SteamID64 it carries. The auth worker binds/authorizes accounts against THAT
 * SteamID rather than the unauthenticated client-supplied `platform_id` field, so
 * only the Steam user who owns the account can log into it.
 *
 * The byte layout and signed-region boundaries follow DoctorMcKay's steam-appticket
 * (github.com/DoctorMcKay/node-steam-appticket). We reimplement the parse + verify
 * here because that package reads its key via `fs` and verifies via `node:crypto`,
 * neither of which is available in workerd — we use `crypto.subtle` instead.
 */

/**
 * Steam "System" public RSA key (SPKI DER, base64), from @doctormckay/steam-crypto's
 * `system.pem`. Steam signs every app-ownership ticket with the matching private key.
 */
const STEAM_SYSTEM_PUBLIC_KEY_SPKI =
	'MIGdMA0GCSqGSIb3DQEBAQUAA4GLADCBhwKBgQDf7BrWLBBmLBc1OhSwfFkRf53T' +
	'2Ct64+AVzRkeRuh7h3SiGEYxqQMUeYKO6UWiSRKpI2hzic9pobFhRr3Bvr/WARvY' +
	'gdTckPv+T1JzZsuVcNfFjrocejN1oWI0Rrtgt4Bo+hOneoo3S57G9F1fOpn5nsQ6' +
	'6WOiu4gZKODnFMBCiQIBEQ=='

let cachedKey: Promise<CryptoKey> | null = null
function steamPublicKey(): Promise<CryptoKey> {
	cachedKey ??= crypto.subtle.importKey(
		'spki',
		Uint8Array.from(atob(STEAM_SYSTEM_PUBLIC_KEY_SPKI), (ch) => ch.charCodeAt(0)),
		{ name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-1' },
		false,
		['verify']
	)
	return cachedKey
}

/** Decode a hex string to bytes, or null when it isn't valid hex. */
function hexToBytes(hex: string): Uint8Array | null {
	if (hex.length === 0 || hex.length % 2 !== 0 || /[^0-9a-fA-F]/.test(hex)) return null
	const out = new Uint8Array(hex.length / 2)
	for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16)
	return out
}

/** Little-endian cursor over a ticket buffer. */
class Reader {
	private pos = 0
	constructor(private readonly view: DataView) {}
	get offset(): number {
		return this.pos
	}
	skip(n: number): void {
		this.pos += n
	}
	u16(): number {
		const v = this.view.getUint16(this.pos, true)
		this.pos += 2
		return v
	}
	u32(): number {
		const v = this.view.getUint32(this.pos, true)
		this.pos += 4
		return v
	}
	u64(): bigint {
		const v = this.view.getBigUint64(this.pos, true)
		this.pos += 8
		return v
	}
}

/** Parsed fields plus the byte range covered by the RSA signature. */
export interface SteamTicket {
	steamId: string
	appId: number
	/** Ownership-ticket expiry, ms since epoch (0 when absent). */
	expiresAt: number
	/** Signed region `[start, end)` and the 128-byte signature over it. */
	signedStart: number
	signedEnd: number
	signature: Uint8Array
}

/**
 * Parse a Steam app/session ticket into its fields WITHOUT verifying the signature.
 * Returns null when the buffer isn't a well-formed, signed ticket.
 */
export function parseSteamTicket(buf: Uint8Array): SteamTicket | null {
	const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)
	const r = new Reader(view)
	const limit = buf.byteLength
	try {
		const initialLength = r.u32()
		if (initialLength === 20) {
			// Full ticket: GC token + session header precede the ownership ticket.
			r.skip(8) // gcToken
			r.skip(8) // steamID (read from the ownership section below instead)
			r.u32() // tokenGenerated
			if (r.u32() !== 24) return null // session header length
			r.skip(8) // unknown1, unknown2
			r.u32() // session external IP
			r.skip(4) // filler
			r.u32() // client connection time
			r.u32() // client connection count
			if (r.u32() + r.offset !== limit) return null // ownership-section length check
		} else {
			r.skip(-4) // bare ownership ticket — rewind the length we just read
		}

		const ownershipTicketOffset = r.offset
		const ownershipTicketLength = r.u32() // includes itself
		if (
			ownershipTicketOffset + ownershipTicketLength !== limit &&
			ownershipTicketOffset + ownershipTicketLength + 128 !== limit
		) {
			return null
		}

		r.u32() // version
		const steamId = r.u64().toString()
		const appId = r.u32()
		r.u32() // ownership external IP
		r.u32() // ownership internal IP
		r.u32() // flags
		r.u32() // generated
		const expiresAt = r.u32() * 1000

		const licenseCount = r.u16()
		for (let i = 0; i < licenseCount; i++) r.u32()
		const dlcCount = r.u16()
		for (let i = 0; i < dlcCount; i++) {
			r.u32() // dlc appID
			const dlcLicenseCount = r.u16()
			for (let j = 0; j < dlcLicenseCount; j++) r.u32()
		}
		r.u16() // reserved

		if (r.offset + 128 !== limit) return null // require a signature
		return {
			steamId,
			appId,
			expiresAt,
			signedStart: ownershipTicketOffset,
			signedEnd: ownershipTicketOffset + ownershipTicketLength,
			signature: buf.subarray(r.offset, r.offset + 128),
		}
	} catch {
		return null // ran off the end / malformed
	}
}

/** Verify a parsed ticket's ownership signature against Steam's System public key. */
export async function verifySteamTicketSignature(
	buf: Uint8Array,
	ticket: SteamTicket
): Promise<boolean> {
	return crypto.subtle.verify(
		'RSASSA-PKCS1-v1_5',
		await steamPublicKey(),
		ticket.signature,
		buf.subarray(ticket.signedStart, ticket.signedEnd)
	)
}

/** The trustworthy identity proven by a verified Steam ticket. */
export interface VerifiedSteamIdentity {
	steamId: string
	appId: number
}

/**
 * Verify a Steam `platform_auth` payload and return the SteamID64 it proves, or
 * null when the payload is missing/malformed, expired, or its signature doesn't
 * verify. Only ever returns a SteamID that Steam itself signed. `now` (ms since
 * epoch, defaulting to the current time) is the instant expiry is checked against;
 * it's a parameter so tests can pin it to a captured ticket's validity window.
 */
export async function verifySteamTicket(
	platformAuth: string,
	now: number = Date.now()
): Promise<VerifiedSteamIdentity | null> {
	let ticketHex: string
	try {
		const parsed = JSON.parse(platformAuth) as { Ticket?: unknown }
		if (typeof parsed.Ticket !== 'string') return null
		ticketHex = parsed.Ticket
	} catch {
		return null
	}

	const buf = hexToBytes(ticketHex)
	if (!buf) return null
	const ticket = parseSteamTicket(buf)
	if (!ticket) return null
	if (ticket.expiresAt !== 0 && ticket.expiresAt < now) return null // expired
	if (!(await verifySteamTicketSignature(buf, ticket))) return null

	return { steamId: ticket.steamId, appId: ticket.appId }
}
