import { describe, expect, it } from 'vitest'

import { hashPassword, verifyPassword } from './password'

describe('password hashing', () => {
	it('produces a base64 salt:hash pair', async () => {
		const stored = await hashPassword('hunter2')
		const [salt, hash] = stored.split(':')
		expect(salt).toMatch(/^[A-Za-z0-9+/]+=*$/)
		expect(hash).toMatch(/^[A-Za-z0-9+/]+=*$/)
	})

	it('round-trips a password it hashed', async () => {
		const stored = await hashPassword('correct horse')
		expect(await verifyPassword('correct horse', stored)).toBe(true)
		expect(await verifyPassword('wrong horse', stored)).toBe(false)
	})

	// Golden vector: a `salt:hash` computed with the canonical parameters (PBKDF2-
	// SHA256, 100k iterations, 256-bit). If this stops verifying, the CLI's hashing
	// has drifted from @repo/domain and CLI-set passwords would fail at login.
	it('verifies a hash produced with the canonical parameters', async () => {
		const stored = 'BwcHBwcHBwcHBwcHBwcHBw==:QVZpoT+KgLqdTSvH1SI33TYsRXA/zkepPPmNBUZ8RyE='
		expect(await verifyPassword('correct horse', stored)).toBe(true)
		expect(await verifyPassword('nope', stored)).toBe(false)
	})
})
