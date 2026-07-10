import { describe, expect, test } from 'vitest'

import {
	parseSteamTicket,
	verifySteamTicket,
	verifySteamTicketSignature,
} from '../../steam-ticket'

// A real Steam session ticket captured from a live login: ownership section signed
// by Steam, steamID64 76561197962463211, appID 471710 (Rec Room on Steam).
const TICKET_HEX =
	'14000000D6BCAD355A77A1C1EB872100010010012522516A1800000001000000020000005FD1B15ADC400B3B069BB24D80010000B20000003200000004000000EB872100010010019E3207002239346C2101A8C00000000008CE4B6A887D676A0100DF97010000000000596381B1BB1AA2197EF13223E62CCE95AAEC0BB48EF50FF74AE88A4D50CF17BEF363A35307C917E3B4173B54B293D3BD8A270DF25C7713E4FB5AF170FBC531DBE76D86DF1BBE8F7EE91D2A357AA7AAEDBFA4A0E5BC6F1F541C98C5C682E685357722CB82C70BEB6F4152A2CD142541BF130CFD6601D75B1418BE58E5B3DA2CCE'

const hex = (s: string) => Uint8Array.from(s.match(/../g)!.map((b) => Number.parseInt(b, 16)))

describe('steam-ticket', () => {
	test('parses the ticket fields', () => {
		const t = parseSteamTicket(hex(TICKET_HEX))
		expect(t).not.toBeNull()
		expect(t!.steamId).toBe('76561197962463211')
		expect(t!.appId).toBe(471710)
		expect(t!.signature).toHaveLength(128)
	})

	test('verifies the Steam-signed ownership signature (real key, WebCrypto)', async () => {
		const buf = hex(TICKET_HEX)
		const t = parseSteamTicket(buf)!
		expect(await verifySteamTicketSignature(buf, t)).toBe(true)
	})

	test('rejects a ticket whose signed bytes were tampered with', async () => {
		const buf = hex(TICKET_HEX)
		const t = parseSteamTicket(buf)!
		buf[t.signedStart + 4] ^= 0xff // flip a byte inside the signed region
		expect(await verifySteamTicketSignature(buf, t)).toBe(false)
	})

	test('verifySteamTicket returns the proven identity for a valid, unexpired ticket', async () => {
		const { expiresAt } = parseSteamTicket(hex(TICKET_HEX))!
		const payload = JSON.stringify({ Ticket: TICKET_HEX, AppId: '471710' })
		// Pin `now` to just inside the ticket's validity window so the test is durable.
		expect(await verifySteamTicket(payload, expiresAt - 1000)).toEqual({
			steamId: '76561197962463211',
			appId: 471710,
		})
	})

	test('verifySteamTicket rejects an expired ticket', async () => {
		const { expiresAt } = parseSteamTicket(hex(TICKET_HEX))!
		const payload = JSON.stringify({ Ticket: TICKET_HEX, AppId: '471710' })
		expect(await verifySteamTicket(payload, expiresAt + 1000)).toBeNull()
	})

	test('verifySteamTicket returns null for malformed payloads', async () => {
		expect(await verifySteamTicket('not json')).toBeNull()
		expect(await verifySteamTicket('{}')).toBeNull()
		expect(await verifySteamTicket(JSON.stringify({ Ticket: 'zzzz' }))).toBeNull()
		expect(await verifySteamTicket(JSON.stringify({ Ticket: '1400' }))).toBeNull()
	})
})
