/**
 * Domain enums — the numeric codes the Rec Room client encodes into the room /
 * room-instance JSON we store in D1. Single source of truth so workers reference
 * a name instead of re-hardcoding the integer. Regular (not `const`) enums, since
 * the tsconfig sets `isolatedModules` (which disallows `const enum` across files).
 */

/** The kind of a room instance (live session), matching the client's `RoomInstanceType`. */
export enum RoomInstanceType {
	Public = 0,
	Private = 1,
	Dormroom = 2,
	Event = 3,
	Meetup = 4,
	Clubhouse = 5,
}

/**
 * The `Type` byte on a messaging `Message` — how the client dispatches a message it
 * receives (a game invite renders the join prompt, a text message the chat bubble, …).
 * Distinct from the notify hub's {@link NotificationType}: a message is delivered *as*
 * a `MessageReceived` (NotificationType 2) notification whose payload is a `Message`,
 * and this enum is that inner `Message.Type`. Mirrors the reference's `MessageType`.
 */
export enum MessageType {
	GameInvite = 0,
	GameInviteDeclined = 1,
	GameJoinFailed = 2,
	PartyActivitySwitch = 3,
	FriendInvite = 4,
	VoteToKick = 5,
	GameInviteV2 = 6,
	PartyActivitySwitchV2 = 7,
	RequestGameInvite = 10,
	RequestGameInviteDeclined = 11,
	FriendStatusOnline = 20,
	TextMessage = 30,
	FriendRequestAccepted = 40,
	PlayerCheer = 50,
	PlayerCheerAnonymous = 51,
	RoomCoOwnerAdded = 60,
	RoomCoOwnerRemoved = 61,
	RoomCoOwnerInvited = 62,
	CreatorPublishedNewRoom = 70,
	PlayerAttendingEvent = 80,
	PlayerEventInvitation = 81,
	DeprecatedGroupInvitation = 90,
	DeprecatedPlayerJoinedGroup = 91,
	CoachMessage = 100,
	NewRoomComments = 110,
	PartyUpRequest = 120,
	FriendIntroduction = 130,
	ClubMemberInvited = 200,
	ClubModeratorInvited = 201,
	ClubCoownerInvited = 202,
	VirtualClubAnnouncementRoomPublished = 100000,
	VirtualClubAnnouncementInventionPublished = 100001,
	VirtualClubAnnouncementGeneric = 100002,
	VirtualClubAnnouncementPlayerEventPublished = 100003,
	VirtualClubAnnouncementClub = 100004,
	VirtualClubAnnouncementPlayer = 100005,
	VirtualClubAnnouncementCode = 100006,
	VirtualClubAnnouncementPhoto = 100007,
	VirtualRoomNotification = 100008,
}

/** A room's (or image's) visibility, matching the client's `RoomAccessibility`. */
export enum Accessibility {
	Private = 0,
	Public = 1,
	Unlisted = 2,
}

/**
 * A room-role tier (the `Role` byte on a room's `Roles` entries), matching the
 * client's values. Host and Moderator are limited-permission helper tiers; CoOwner
 * and Creator are the owner-level tiers that may manage the room (see
 * {@link canManageRoom}). Creator is the room's owner (its `CreatorAccountId`) —
 * the max byte.
 */
export enum Role {
	Host = 10,
	Moderator = 20,
	CoOwner = 30,
	Creator = 255,
}
