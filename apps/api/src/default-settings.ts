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
	['Recroom.OOBE', '77'],
	[
		'SplitTestAssignedSegments',
		'1|{"SplitTesting+PhotonMaxDatagrams_2021_01_11":"Off","SplitTesting+Curated_Rooms_2020_08_06":"Off","SplitTesting+RoomRecommendationsType_2020_08_14":"Aug14MinVisitors35000"}',
	],
	['PlayerSessionCount', '13'],
	['TUTORIAL_COMPLETE_MASK', '11'],
	['BACKPACK_FAVORITE_TOOL', '1'],
	['VoiceChat', '2'],
	['VRAUTOSPRINT', '1'],
	['VR_MOVEMENT_MODE', '0'],
	['COMFORT_SPRINT', '0'],
	['COMFORT_WALK', '0'],
	['COMFORT_VEHICLES', '0'],
	['COMFORT_FLY', '0'],
	['COMFORT_ROTATE', '0'],
	['COMFORT_FORCES', '0'],
	['COMFORT_FALL', '0'],
	['COMFORT_TELEPORT', '0'],
	['ROTATE_IN_PLACE_ENABLED', '1'],
	['ROTATION_INCREMENT', '2'],
	['CONTINUOUS_ROTATION_MODE', '1'],
	['DONT_LOCK_TOOLS_TO_HAND', '0'],
	['QualitySettings', '2'],
	['TeleportBuffer', '0'],
	['IgnoreBuffer', '1'],
	['FIRST_TIME_IN_FLAGS', '0'],
	['ShowRoomCenter', '1'],
	['USER_TRACKING', '1'],
	['STABILIZE_HANDS', '0'],
	['MakerPen_SnappingMode', '2'],
	['Recroom.ChallengeMap', '17'],
	['VoiceFilter2', '1'],
	['SFX_VOLUME_PERCENT_PREF', '1'],
]

export function defaultSettings(playerId: number): PlayerSetting[] {
	return DEFAULTS.map(([Key, Value]) => ({ PlayerId: playerId, Key, Value }))
}
