/**
 * Service-discovery map: service label → subdomain. The game client fetches the
 * generated `{ label: "https://<subdomain>.<domain>" }` document from `/`.
 *
 * The base domain is injected at deploy time via the `DOMAIN` var (see
 * `run-wrangler-deploy`), so the real domain never lives in a versioned file.
 */
const SERVICE_SUBDOMAINS = {
	Accounts: 'accounts',
	AI: 'ai',
	API: 'api',
	Auth: 'auth',
	BugReporting: 'bugreporting',
	Cards: 'cards',
	CDN: 'cdn',
	Chat: 'chat',
	Clubs: 'clubs',
	CMS: 'cms',
	Commerce: 'commerce',
	Data: 'data',
	DataCollection: 'datacollection',
	Discovery: 'discovery',
	Econ: 'econ',
	GameLogs: 'gamelogs',
	Geo: 'geo',
	Images: 'img',
	Leaderboard: 'leaderboard',
	Link: 'link',
	Lists: 'lists',
	Matchmaking: 'match',
	Moderation: 'moderation',
	Notifications: 'notify',
	PlatformNotifications: 'platformnotifications',
	PlayerSettings: 'playersettings',
	RoomComments: 'roomcomments',
	RoomieIntegrations: 'roomieintegrations',
	Rooms: 'rooms',
	Storage: 'storage',
	Strings: 'strings',
	StringsCDN: 'strings-cdn',
	Studio: 'studio',
	Thorn: 'thorn',
	Videos: 'videos',
	WWW: 'www',
} as const

/** Builds the endpoints document for `domain`, e.g. `rec.example.com`. */
export function buildEndpoints(domain: string): Record<string, string> {
	return Object.fromEntries(
		Object.entries(SERVICE_SUBDOMAINS).map(([label, sub]) => [label, `https://${sub}.${domain}`])
	)
}
