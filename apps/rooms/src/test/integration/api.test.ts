import { SELF } from 'cloudflare:test'
import { describe, expect, it } from 'vitest'

import '../../rooms.app'

const ORIGIN = 'https://rooms.rec.djdevin.net'

describe('rooms endpoints', () => {
	it('GET / reports service status', async () => {
		const res = await SELF.fetch(`${ORIGIN}/`)
		expect(res.status).toBe(200)
		expect(await res.json()).toEqual({ service: 'rooms', status: 'ok' })
	})

	it('GET /rooms/1 returns the dorm room (ignoring include/unityAsset params)', async () => {
		const res = await SELF.fetch(
			`${ORIGIN}/rooms/1?include=1325&unityAssetTarget=0&unityAssetVersion=1`
		)
		expect(res.status).toBe(200)
		const body = (await res.json()) as {
			RoomId: number
			Name: string
			IsDorm: boolean
			Stats: object
		}
		expect(body).toMatchObject({ RoomId: 1, Name: 'DormRoom', IsDorm: true })
		expect(body).toHaveProperty('Stats')
		const subRooms = (body as unknown as { SubRooms: Array<{ UnitySceneId: string }> }).SubRooms
		expect(subRooms[0].UnitySceneId).toBe('76d98498-60a1-430c-ab76-b54a29b7a163')
	})

	it('GET /rooms/:id synthesizes a generic room for other ids', async () => {
		const res = await SELF.fetch(`${ORIGIN}/rooms/42`)
		expect(res.status).toBe(200)
		const body = (await res.json()) as { RoomId: number; Name: string; IsDorm: boolean }
		expect(body).toMatchObject({ RoomId: 42, Name: 'Room42', IsDorm: false })
	})

	it('GET /rooms?id=1 returns the matching room', async () => {
		const res = await SELF.fetch(`${ORIGIN}/rooms?id=1`)
		expect(res.status).toBe(200)
		expect(await res.json()).toMatchObject({ RoomId: 1, Name: 'DormRoom' })
	})

	it('GET /rooms with no id or name returns 400', async () => {
		const res = await SELF.fetch(`${ORIGIN}/rooms`)
		expect(res.status).toBe(400)
	})

	it('GET /roomserver/photon_access_token returns permissions + instance id', async () => {
		const res = await SELF.fetch(`${ORIGIN}/roomserver/photon_access_token`)
		expect(res.status).toBe(200)
		const body = (await res.json()) as { Permissions: unknown[]; RoomInstanceId: number }
		expect(body.Permissions.length).toBeGreaterThan(0)
		expect(body.RoomInstanceId).toBe(1)
	})

	it('GET /rooms/bulk?id= returns an array; ?name= returns []', async () => {
		const byId = await SELF.fetch(`${ORIGIN}/rooms/bulk?id=1,2`)
		expect(byId.status).toBe(200)
		expect(((await byId.json()) as unknown[]).length).toBe(2)
		const byName = await SELF.fetch(`${ORIGIN}/rooms/bulk?name=RecCenter`)
		expect(byName.status).toBe(200)
		expect(await byName.json()).toEqual([])
	})

	it('GET /photon_access_token (bare) also returns permissions', async () => {
		const res = await SELF.fetch(`${ORIGIN}/photon_access_token`)
		expect(res.status).toBe(200)
		const body = (await res.json()) as { Permissions: unknown[]; RoomInstanceId: number }
		expect(body.Permissions.length).toBeGreaterThan(0)
		expect(body.RoomInstanceId).toBe(1)
	})

	it('GET /roomserver/rooms/createdby/me returns the owned rooms array', async () => {
		const res = await SELF.fetch(`${ORIGIN}/roomserver/rooms/createdby/me`)
		expect(res.status).toBe(200)
		const body = (await res.json()) as Array<{ RoomId: number }>
		expect(Array.isArray(body)).toBe(true)
		expect(body[0]).toMatchObject({ RoomId: 1, Name: 'DormRoom' })
	})
})
