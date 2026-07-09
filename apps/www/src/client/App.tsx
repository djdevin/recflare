import { useCallback, useEffect, useState } from 'react'

/** The self-account shape returned by the accounts worker (`GET /account/me`). */
interface SelfAccount {
	accountId: number
	username: string
	displayName: string
	email: string | null
}

/**
 * Call a www BFF endpoint. GET when no body is given, else POST JSON. Throws with
 * the upstream error message (auth uses `error`/`error_description`, the account
 * mutations use `error`) so callers can surface it.
 */
async function api<T = unknown>(path: string, body?: unknown): Promise<T> {
	const res = await fetch(path, {
		method: body === undefined ? 'GET' : 'POST',
		headers: body === undefined ? undefined : { 'content-type': 'application/json' },
		body: body === undefined ? undefined : JSON.stringify(body),
	})
	const data = (await res.json().catch(() => ({}))) as Record<string, unknown>
	if (!res.ok) {
		const message =
			(typeof data.error === 'string' && data.error) ||
			(typeof data.error_description === 'string' && data.error_description) ||
			`Request failed (${res.status})`
		throw new Error(message)
	}
	return data as T
}

export function App() {
	// undefined = still checking the session; null = signed out.
	const [account, setAccount] = useState<SelfAccount | null | undefined>(undefined)

	useEffect(() => {
		api<{ accountId: number } & SelfAccount>('/api/me')
			.then((me) => setAccount(me))
			.catch(() => setAccount(null))
	}, [])

	const logout = useCallback(async () => {
		await api('/api/logout', {})
		setAccount(null)
	}, [])

	return (
		<main className="shell">
			<h1>Recflare Accounts</h1>
			{account === undefined ? (
				<p className="muted">Loading…</p>
			) : account ? (
				<Dashboard account={account} onChange={setAccount} onLogout={logout} />
			) : (
				<AuthForms onAuthed={setAccount} />
			)}
		</main>
	)
}

/** Small hook wrapping a submit handler with pending/error/success state. */
function useAction() {
	const [pending, setPending] = useState(false)
	const [error, setError] = useState('')
	const [done, setDone] = useState('')

	const run = useCallback(async (fn: () => Promise<string>) => {
		setPending(true)
		setError('')
		setDone('')
		try {
			setDone(await fn())
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err))
		} finally {
			setPending(false)
		}
	}, [])

	return { pending, error, done, run }
}

function AuthForms({ onAuthed }: { onAuthed: (a: SelfAccount) => void }) {
	const [tab, setTab] = useState<'signup' | 'login'>('signup')
	return (
		<section className="card">
			<div className="tabs">
				<button className={tab === 'signup' ? 'active' : ''} onClick={() => setTab('signup')}>
					Create account
				</button>
				<button className={tab === 'login' ? 'active' : ''} onClick={() => setTab('login')}>
					Sign in
				</button>
			</div>
			{tab === 'signup' ? <SignupForm onAuthed={onAuthed} /> : <LoginForm onAuthed={onAuthed} />}
		</section>
	)
}

function SignupForm({ onAuthed }: { onAuthed: (a: SelfAccount) => void }) {
	const [password, setPassword] = useState('')
	const { pending, error, run } = useAction()

	return (
		<form
			onSubmit={(e) => {
				e.preventDefault()
				void run(async () => {
					const { account } = await api<{ account: SelfAccount }>('/api/signup', { password })
					onAuthed(account)
					return ''
				})
			}}
		>
			<p className="muted">
				A new account id is assigned automatically. Choose a password to sign in later.
			</p>
			<label>
				Password
				<input
					type="password"
					value={password}
					autoComplete="new-password"
					onChange={(e) => setPassword(e.target.value)}
					required
				/>
			</label>
			{error && <p className="error">{error}</p>}
			<button type="submit" disabled={pending}>
				{pending ? 'Creating…' : 'Create account'}
			</button>
		</form>
	)
}

function LoginForm({ onAuthed }: { onAuthed: (a: SelfAccount) => void }) {
	const [accountId, setAccountId] = useState('')
	const [password, setPassword] = useState('')
	const { pending, error, run } = useAction()

	return (
		<form
			onSubmit={(e) => {
				e.preventDefault()
				void run(async () => {
					const { account } = await api<{ account: SelfAccount }>('/api/login', {
						accountId,
						password,
					})
					onAuthed(account)
					return ''
				})
			}}
		>
			<label>
				Account id
				<input
					type="text"
					inputMode="numeric"
					value={accountId}
					autoComplete="username"
					onChange={(e) => setAccountId(e.target.value)}
					required
				/>
			</label>
			<label>
				Password
				<input
					type="password"
					value={password}
					autoComplete="current-password"
					onChange={(e) => setPassword(e.target.value)}
					required
				/>
			</label>
			{error && <p className="error">{error}</p>}
			<button type="submit" disabled={pending}>
				{pending ? 'Signing in…' : 'Sign in'}
			</button>
		</form>
	)
}

function Dashboard({
	account,
	onChange,
	onLogout,
}: {
	account: SelfAccount
	onChange: (a: SelfAccount) => void
	onLogout: () => void
}) {
	return (
		<>
			<section className="card">
				<div className="row">
					<div>
						<div className="muted">Signed in as</div>
						<div className="big">
							{account.displayName || account.username}{' '}
							<span className="muted">#{account.accountId}</span>
						</div>
						<div className="muted">{account.email ?? 'no email set'}</div>
					</div>
					<button className="ghost" onClick={onLogout}>
						Sign out
					</button>
				</div>
			</section>
			<EmailForm account={account} onChange={onChange} />
			<PasswordForm />
		</>
	)
}

function EmailForm({
	account,
	onChange,
}: {
	account: SelfAccount
	onChange: (a: SelfAccount) => void
}) {
	const [email, setEmail] = useState(account.email ?? '')
	const { pending, error, done, run } = useAction()

	return (
		<section className="card">
			<h2>Email</h2>
			<form
				onSubmit={(e) => {
					e.preventDefault()
					void run(async () => {
						await api('/api/email', { email })
						onChange({ ...account, email })
						return 'Email saved.'
					})
				}}
			>
				<label>
					Email address
					<input
						type="email"
						value={email}
						autoComplete="email"
						onChange={(e) => setEmail(e.target.value)}
						required
					/>
				</label>
				{error && <p className="error">{error}</p>}
				{done && <p className="ok">{done}</p>}
				<button type="submit" disabled={pending}>
					{pending ? 'Saving…' : 'Save email'}
				</button>
			</form>
		</section>
	)
}

function PasswordForm() {
	const [oldPassword, setOldPassword] = useState('')
	const [newPassword, setNewPassword] = useState('')
	const { pending, error, done, run } = useAction()

	return (
		<section className="card">
			<h2>Password</h2>
			<form
				onSubmit={(e) => {
					e.preventDefault()
					void run(async () => {
						await api('/api/password', { oldPassword, newPassword })
						setOldPassword('')
						setNewPassword('')
						return 'Password changed.'
					})
				}}
			>
				<label>
					Current password
					<input
						type="password"
						value={oldPassword}
						autoComplete="current-password"
						onChange={(e) => setOldPassword(e.target.value)}
						required
					/>
				</label>
				<label>
					New password
					<input
						type="password"
						value={newPassword}
						autoComplete="new-password"
						onChange={(e) => setNewPassword(e.target.value)}
						required
					/>
				</label>
				{error && <p className="error">{error}</p>}
				{done && <p className="ok">{done}</p>}
				<button type="submit" disabled={pending}>
					{pending ? 'Updating…' : 'Change password'}
				</button>
			</form>
		</section>
	)
}
