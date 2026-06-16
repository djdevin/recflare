/**
 * Default player settings, ported from the inline defaults in the C#
 * `GET /api/settings/v2`. The C# seeds these when a player has no stored settings.
 */
export interface PlayerSetting {
	PlayerId: number
	Key: string
	Value: string
}

const DEFAULTS: ReadonlyArray<readonly [key: string, value: string]> = [
]

export function defaultSettings(playerId: number): PlayerSetting[] {
	return DEFAULTS.map(([Key, Value]) => ({ PlayerId: playerId, Key, Value }))
}
