import * as readline from 'node:readline'

import { Command } from '@commander-js/extra-typings'
import Table from 'cli-table3'

import { getRepoRoot } from '../path'
import { hashPassword } from '../password'

/**
 * Operator-facing admin tools for the shared `recflare` D1 database. Each command
 * shells out to `wrangler d1 execute recflare` — no running worker or auth token
 * needed — defaulting to the local dev database and targeting the deployed one only
 * with `--remote`. Password hashing comes from @repo/domain, the same code the auth
 * worker uses, so a hash set here always verifies at login.
 *
 *   runx admin set-password    --account 1 [--remote]
 *   runx admin clear-password  --username alice [--remote]
 *   runx admin lookup          --username alice [--remote]
 *   runx admin grant-developer --account 1 [--revoke] [--remote]
 */

/** The one shared database every D1-backed worker binds. */
const DB_NAME = 'recflare'

interface D1ExecResult {
	results: Array<Record<string, unknown>>
	success: boolean
	meta: { changes?: number; rows_read?: number }
}

/** Escape a value for embedding inside a single-quoted SQL string literal. */
const sqlStr = (s: string): string => s.replace(/'/g, "''")

/**
 * Resolve the account selector into a SQL WHERE fragment. Exactly one of
 * `--account` / `--username` must be given. Account ids are validated numeric;
 * usernames match the indexed, case-insensitive `username_lower` generated column.
 */
function whereClause(account?: string, username?: string): { where: string; label: string } {
	if ((account == null) === (username == null)) {
		throw new Error('provide exactly one of --account or --username')
	}
	if (account != null) {
		if (!/^\d+$/.test(account)) throw new Error('--account must be a numeric account id')
		return { where: `account_id = ${account}`, label: `account ${account}` }
	}
	return {
		where: `username_lower = '${sqlStr(username!.toLowerCase())}'`,
		label: `username "${username}"`,
	}
}

/** The deployed D1's real id, from the environment or the gitignored root .env. */
async function getRemoteD1Id(): Promise<string> {
	if (process.env.RECFLARE_D1) return process.env.RECFLARE_D1
	const envPath = path.join(getRepoRoot(), '.env')
	if (await fs.pathExists(envPath)) {
		const content = await fs.readFile(envPath, 'utf8')
		const m = content.match(/^\s*RECFLARE_D1\s*=\s*(.+?)\s*$/m)
		if (m) return m[1].replace(/^["']|["']$/g, '')
	}
	throw new Error('RECFLARE_D1 is not set — add the recflare D1 id to .env (see .env.example)')
}

/**
 * Run a SQL statement against the shared database via wrangler. Runs from the auth
 * worker's directory (it owns the accounts schema and binds the DB). For `--remote`
 * the committed wrangler.jsonc's "local" database_id placeholder is spliced with the
 * real id into a gitignored generated config — exactly like run-wrangler-migrate.
 */
async function execSql(sql: string, remote: boolean): Promise<D1ExecResult> {
	const authDir = path.join(getRepoRoot(), 'apps', 'auth')
	cd(authDir)

	const args = ['d1', 'execute', DB_NAME, '--command', sql, '--json']
	let cleanup: (() => Promise<void>) | undefined

	if (remote) {
		const id = await getRemoteD1Id()
		const src = await fs.readFile(path.join(authDir, 'wrangler.jsonc'), 'utf8')
		const generated = src.replace(/("database_id"\s*:\s*")[^"]*(")/, `$1${id}$2`)
		const genPath = path.join(authDir, 'wrangler.generated.jsonc')
		await fs.writeFile(genPath, generated)
		cleanup = () => fs.remove(genPath)
		args.push('--config', 'wrangler.generated.jsonc', '--remote')
	} else {
		args.push('--local')
	}

	try {
		// Via `pnpm exec` so wrangler resolves from the auth worker's node_modules
		// (it isn't a dependency of @repo/tools, so it's not on this process's PATH).
		const out = await $`pnpm exec wrangler ${args}`.quiet()
		// wrangler --json prints a one-element array of results to stdout.
		const start = out.stdout.indexOf('[')
		if (start === -1) throw new Error(`unexpected d1 execute output:\n${out.stdout}`)
		const parsed = JSON.parse(out.stdout.slice(start)) as D1ExecResult[]
		const first = parsed[0]
		if (!first) throw new Error(`empty d1 execute result:\n${out.stdout}`)
		return first
	} finally {
		if (cleanup) await cleanup()
	}
}

/** Prompt for a line of input without echoing what's typed (for passwords). */
function promptHidden(query: string): Promise<string> {
	return new Promise((resolve) => {
		const rl = readline.createInterface({
			input: process.stdin,
			output: process.stdout,
			terminal: true,
		})
		// Mute the echo of typed characters; write the prompt ourselves.
		;(rl as unknown as { _writeToOutput: (s: string) => void })._writeToOutput = () => {}
		process.stdout.write(query)
		rl.question('', (answer) => {
			process.stdout.write('\n')
			rl.close()
			resolve(answer)
		})
	})
}

/**
 * Get the new password: from `--password`, else from piped stdin (for scripting),
 * else prompted interactively (hidden, entered twice and compared).
 */
async function resolvePassword(flag?: string): Promise<string> {
	if (flag != null && flag !== '') return flag
	if (!process.stdin.isTTY) {
		const chunks: Buffer[] = []
		for await (const chunk of process.stdin) chunks.push(chunk as Buffer)
		const piped = Buffer.concat(chunks).toString('utf8').replace(/\r?\n$/, '')
		if (piped === '') throw new Error('no password provided on stdin')
		return piped
	}
	const first = await promptHidden('New password: ')
	if (first === '') throw new Error('password must not be empty')
	const second = await promptHidden('Confirm password: ')
	if (first !== second) throw new Error('passwords did not match')
	return first
}

/** A short, loud label for which database a command is about to touch. */
const target = (remote: boolean): string =>
	remote ? chalk.red(`${DB_NAME} (remote)`) : chalk.cyan(`${DB_NAME} (local)`)

/** Resolve the --local/--remote target flags. Local is the default. */
function resolveRemote(opts: { local?: boolean; remote?: boolean }): boolean {
	if (opts.local && opts.remote) throw new Error('pass at most one of --local / --remote')
	return opts.remote === true
}

/**
 * Fail when a WHERE-scoped UPDATE matched no row (i.e. no such account). Relies on
 * the statement's `RETURNING account_id` — wrangler's `--json` meta doesn't reliably
 * carry a `changes` count, but the returned rows always reflect what actually matched.
 */
function assertMatched(res: D1ExecResult, label: string): void {
	if (res.results.length < 1) throw new Error(`no account found for ${label}`)
}

const setPassword = new Command('set-password')
	.description("Set (or replace) an account's login password")
	.option('--account <id>', 'Account id to target')
	.option('--username <name>', 'Username to target (case-insensitive)')
	.option('--password <password>', 'The new password (omit to be prompted, or pipe via stdin)')
	.option('--local', 'Target the local dev database (the default).', false)
	.option('--remote', 'Target the deployed database instead of the local dev database.', false)
	.action(async (opts) => {
		const { where, label } = whereClause(opts.account, opts.username)
		const remote = resolveRemote(opts)
		const password = await resolvePassword(opts.password)
		const hash = await hashPassword(password)
		const sql = `UPDATE account SET data = json_set(data, '$.passwordHash', '${sqlStr(hash)}') WHERE ${where} RETURNING account_id`
		console.log(`Setting password for ${label} on ${target(remote)}`)
		assertMatched(await execSql(sql, remote), label)
		console.log(chalk.green(`✓ password set for ${label}`))
	})

const clearPassword = new Command('clear-password')
	.description("Remove an account's password so it has no login credential")
	.option('--account <id>', 'Account id to target')
	.option('--username <name>', 'Username to target (case-insensitive)')
	.option('--local', 'Target the local dev database (the default).', false)
	.option('--remote', 'Target the deployed database instead of the local dev database.', false)
	.action(async (opts) => {
		const { where, label } = whereClause(opts.account, opts.username)
		const remote = resolveRemote(opts)
		const sql = `UPDATE account SET data = json_remove(data, '$.passwordHash') WHERE ${where} RETURNING account_id`
		console.log(`Clearing password for ${label} on ${target(remote)}`)
		assertMatched(await execSql(sql, remote), label)
		console.log(chalk.green(`✓ password cleared for ${label}`))
	})

/**
 * Build a `grant-<role>` command that toggles a boolean role flag on the account
 * blob. `jsonKey` is the account field (e.g. `isDeveloper`) — a fixed literal, not
 * user input. Both the /role/:role lookup and the token's `role` claim read it.
 */
function grantRoleCommand(name: string, jsonKey: string, roleLabel: string) {
	return new Command(name)
		.description(`Grant (or, with --revoke, remove) the ${roleLabel} role on an account`)
		.option('--account <id>', 'Account id to target')
		.option('--username <name>', 'Username to target (case-insensitive)')
		.option('--revoke', `Remove the ${roleLabel} role instead of granting it`, false)
		.option('--local', 'Target the local dev database (the default).', false)
		.option('--remote', 'Target the deployed database instead of the local dev database.', false)
		.action(async (opts) => {
			const { where, label } = whereClause(opts.account, opts.username)
			const remote = resolveRemote(opts)
			const value = opts.revoke ? 'false' : 'true'
			const sql = `UPDATE account SET data = json_set(data, '$.${jsonKey}', json('${value}')) WHERE ${where} RETURNING account_id`
			const verb = opts.revoke ? 'Revoking' : 'Granting'
			console.log(`${verb} ${roleLabel} role for ${label} on ${target(remote)}`)
			assertMatched(await execSql(sql, remote), label)
			console.log(
				chalk.green(`✓ ${roleLabel} role ${opts.revoke ? 'revoked' : 'granted'} for ${label}`)
			)
		})
}

const grantDeveloper = grantRoleCommand('grant-developer', 'isDeveloper', 'developer')
const grantModerator = grantRoleCommand('grant-moderator', 'isModerator', 'moderator')

const lookup = new Command('lookup')
	.description('Print an account by id or username')
	.option('--account <id>', 'Account id to look up')
	.option('--username <name>', 'Username to look up (case-insensitive)')
	.option('--local', 'Target the local dev database (the default).', false)
	.option('--remote', 'Target the deployed database instead of the local dev database.', false)
	.action(async (opts) => {
		const { where, label } = whereClause(opts.account, opts.username)
		const remote = resolveRemote(opts)
		const sql = `SELECT
			json_extract(data, '$.accountId') AS accountId,
			json_extract(data, '$.username') AS username,
			json_extract(data, '$.platform') AS platform,
			json_extract(data, '$.platformId') AS platformId,
			json_extract(data, '$.createdAt') AS createdAt,
			json_extract(data, '$.lastLoginTime') AS lastLoginTime,
			(json_extract(data, '$.passwordHash') IS NOT NULL) AS hasPassword,
			(json_extract(data, '$.isDeveloper') = 1) AS isDeveloper,
			(json_extract(data, '$.isModerator') = 1) AS isModerator
			FROM account WHERE ${where}`
		const res = await execSql(sql, remote)
		const row = res.results[0]
		if (!row) {
			console.log(chalk.yellow(`no account found for ${label} on ${target(remote)}`))
			return
		}
		const asText = (v: unknown): string =>
			v == null ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v as number | string | boolean)
		const boolKeys = new Set(['hasPassword', 'isDeveloper', 'isModerator'])
		const table = new Table()
		for (const [key, value] of Object.entries(row)) {
			const shown = boolKeys.has(key) ? (value === 1 ? 'yes' : 'no') : asText(value)
			table.push({ [key]: shown })
		}
		console.log(table.toString())
	})

export const adminCmd = new Command('admin')
	.description('Operator tools for accounts on the shared recflare D1 database')
	.addCommand(setPassword)
	.addCommand(clearPassword)
	.addCommand(grantDeveloper)
	.addCommand(grantModerator)
	.addCommand(lookup)
	.addHelpText(
		'after',
		`
Select an account with --account <id> or --username <name>.
Target --local (default) or --remote (production; needs RECFLARE_D1 in .env).
Add --help to any subcommand for its options, e.g. \`runx admin set-password --help\`.

Examples:
  $ runx admin set-password --account 1               # prompts, hidden
  $ echo "s3cret" | runx admin set-password --account 1
  $ runx admin clear-password --username alice
  $ runx admin grant-developer --account 1 [--revoke]
  $ runx admin grant-moderator --username alice --remote
  $ runx admin lookup --username alice --remote`
	)
