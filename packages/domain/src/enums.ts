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

/** A room's (or image's) visibility, matching the client's `RoomAccessibility`. */
export enum Accessibility {
	Private = 0,
	Public = 1,
	Unlisted = 2,
}

/**
 * A room-role tier (the `Role` byte on a room's `Roles` entries). Named tiers we
 * reference by value today — the owner (max byte) and co-owner.
 */
export enum Role {
	CoOwner = 30,
	Owner = 255,
}
