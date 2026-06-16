/**
 * Default player settings seeded on a player's first read. Based on the C#
 * `PlayerSettingsController.GetPlayerSettings`, but the onboarding/progress flags
 * are reset to a *fresh* player — the C# values were copied from an already-
 * onboarded account, which made new accounts skip Orientation (the client saw
 * OOBE/tutorials as complete and warped them to the dorm within seconds).
 * Ordered; written to KV the first time a player has no stored settings.
 */
export const DEFAULT_SETTINGS: Array<{ Key: string; Value: string }> = [
	// 0 = no OOBE steps done, so the new-user Orientation flow runs.
	{ Key: 'Recroom.OOBE', Value: '0' },
	{
		Key: 'SplitTestAssignedSegments',
		Value:
			'1|{"SplitTesting+PhotonMaxDatagrams_2021_01_11":"Off","SplitTesting+Curated_Rooms_2020_08_06":"Off","SplitTesting+RoomRecommendationsType_2020_08_14":"Aug14MinVisitors35000"}',
	},
	{ Key: 'PlayerSessionCount', Value: '0' },
	// 0 = no tutorials completed (fresh player).
	{ Key: 'TUTORIAL_COMPLETE_MASK', Value: '0' },
	{ Key: 'BACKPACK_FAVORITE_TOOL', Value: '1' },
	{ Key: 'VoiceChat', Value: '2' },
	{ Key: 'VRAUTOSPRINT', Value: '1' },
	{ Key: 'VR_MOVEMENT_MODE', Value: '0' },
	{ Key: 'COMFORT_SPRINT', Value: '0' },
	{ Key: 'COMFORT_WALK', Value: '0' },
	{ Key: 'COMFORT_VEHICLES', Value: '0' },
	{ Key: 'COMFORT_FLY', Value: '0' },
	{ Key: 'COMFORT_ROTATE', Value: '0' },
	{ Key: 'COMFORT_FORCES', Value: '0' },
	{ Key: 'COMFORT_FALL', Value: '0' },
	{ Key: 'COMFORT_TELEPORT', Value: '0' },
	{ Key: 'ROTATE_IN_PLACE_ENABLED', Value: '1' },
	{ Key: 'ROTATION_INCREMENT', Value: '2' },
	{ Key: 'CONTINUOUS_ROTATION_MODE', Value: '1' },
	{ Key: 'DONT_LOCK_TOOLS_TO_HAND', Value: '0' },
	{ Key: 'QualitySettings', Value: '2' },
	{ Key: 'TeleportBuffer', Value: '0' },
	{ Key: 'IgnoreBuffer', Value: '1' },
	{ Key: 'FIRST_TIME_IN_FLAGS', Value: '0' },
	{ Key: 'ShowRoomCenter', Value: '1' },
	{ Key: 'USER_TRACKING', Value: '1' },
	{ Key: 'STABILIZE_HANDS', Value: '0' },
	{ Key: 'MakerPen_SnappingMode', Value: '2' },
	{ Key: 'Recroom.ChallengeMap', Value: '17' },
	{ Key: 'VoiceFilter2', Value: '1' },
	{ Key: 'SFX_VOLUME_PERCENT_PREF', Value: '1' },
]
