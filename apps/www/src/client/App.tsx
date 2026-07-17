import { useCallback, useEffect, useState, type ReactNode } from 'react'

/** The self-account shape returned by the www BFF (`/api/me`, `/api/login`, …). */
interface SelfAccount {
	accountId: number
	username: string
	displayName: string
	email: string | null
	/** Whether this session may use admin controls (from the token's role claim). */
	isAdmin?: boolean
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

/** Minimal history-based router: current pathname + a navigate() that pushes state. */
function useRouter() {
	const [path, setPath] = useState(() => window.location.pathname)
	useEffect(() => {
		const onPop = () => setPath(window.location.pathname)
		window.addEventListener('popstate', onPop)
		return () => window.removeEventListener('popstate', onPop)
	}, [])
	const navigate = useCallback((to: string) => {
		if (to !== window.location.pathname) {
			window.history.pushState(null, '', to)
			window.scrollTo(0, 0)
		}
		setPath(to)
	}, [])
	return { path, navigate }
}

type Navigate = (to: string) => void

/** An in-app link that routes client-side instead of doing a full page load. */
function Link({
	to,
	navigate,
	className,
	children,
}: {
	to: string
	navigate: Navigate
	className?: string
	children: ReactNode
}) {
	return (
		<a
			href={to}
			className={className}
			onClick={(e) => {
				e.preventDefault()
				navigate(to)
			}}
		>
			{children}
		</a>
	)
}

export function App() {
	// undefined = still checking the session; null = signed out.
	const [account, setAccount] = useState<SelfAccount | null | undefined>(undefined)
	const { path, navigate } = useRouter()

	useEffect(() => {
		api<SelfAccount>('/api/me')
			.then((me) => setAccount(me))
			.catch(() => setAccount(null))
	}, [])

	const logout = useCallback(async () => {
		await api('/api/logout', {})
		setAccount(null)
		navigate('/')
	}, [navigate])

	return (
		<>
			<NavBar account={account} path={path} navigate={navigate} onLogout={logout} />
			{path === '/login' ? (
				<LoginPage account={account} navigate={navigate} onAuthed={setAccount} />
			) : path === '/account' ? (
				<AccountPage account={account} navigate={navigate} onChange={setAccount} />
			) : (
				<HomePage />
			)}
		</>
	)
}

/** Top nav: brand → home, plus a sign-in / my-account link for the session. */
function NavBar({
	account,
	path,
	navigate,
	onLogout,
}: {
	account: SelfAccount | null | undefined
	path: string
	navigate: Navigate
	onLogout: () => void
}) {
	return (
		<header className="nav">
			<Link to="/" navigate={navigate} className="brand">
				RecFlare
			</Link>
			<nav className="nav-links">
				{account === undefined ? null : account ? (
					<>
						<Link to="/account" navigate={navigate} className={path === '/account' ? 'active' : ''}>
							My account
						</Link>
						<button className="linkish" onClick={onLogout}>
							Sign out
						</button>
					</>
				) : (
					<Link to="/login" navigate={navigate} className={path === '/login' ? 'active' : ''}>
						Sign in
					</Link>
				)}
			</nav>
		</header>
	)
}

/** Public homepage: a slideshow of recent public photos. */
function HomePage() {
	return (
		<main className="shell wide">
			<Slideshow />
		</main>
	)
}

/** A recent public image plus who took it and where. */
interface Slide {
	url: string
	username: string
	roomName: string | null
}

function Slideshow() {
	const [slides, setSlides] = useState<Slide[] | null>(null)
	const [error, setError] = useState('')
	const [idx, setIdx] = useState(0)

	useEffect(() => {
		api<{ images: Slide[] }>('/api/slideshow')
			.then((d) => setSlides(d.images))
			.catch((e) => setError(e instanceof Error ? e.message : String(e)))
	}, [])

	useEffect(() => {
		if (!slides || slides.length < 2) return
		const t = setInterval(() => setIdx((i) => (i + 1) % slides.length), 5000)
		return () => clearInterval(t)
	}, [slides])

	if (error) return <p className="error">Couldn’t load the slideshow: {error}</p>
	if (!slides) return <p className="muted">Loading…</p>
	if (slides.length === 0) return <p className="muted">No photos yet.</p>

	const slide = slides[idx]
	const step = (delta: number) => setIdx((i) => (i + delta + slides.length) % slides.length)

	return (
		<div className="slideshow">
			<div className="slide-stage">
				<img src={slide.url} alt={`Photo by ${slide.username}`} />
				{slides.length > 1 && (
					<>
						<button className="slide-nav prev" onClick={() => step(-1)} aria-label="Previous photo">
							‹
						</button>
						<button className="slide-nav next" onClick={() => step(1)} aria-label="Next photo">
							›
						</button>
					</>
				)}
			</div>
			<div className="slide-meta">
				<div>
					<span className="big">@{slide.username}</span>
					{slide.roomName && <span className="muted"> · {slide.roomName}</span>}
				</div>
				<div className="muted">
					{idx + 1} / {slides.length}
				</div>
			</div>
		</div>
	)
}

/** The sign-in page. Redirects to the account page once a session exists. */
function LoginPage({
	account,
	navigate,
	onAuthed,
}: {
	account: SelfAccount | null | undefined
	navigate: Navigate
	onAuthed: (a: SelfAccount) => void
}) {
	useEffect(() => {
		if (account) navigate('/account')
	}, [account, navigate])

	return (
		<main className="shell">
			<section className="card">
				<h2>Sign in</h2>
				<LoginForm
					onAuthed={(a) => {
						onAuthed(a)
						navigate('/account')
					}}
				/>
			</section>
		</main>
	)
}

/** The signed-in account page. Redirects to sign-in when there's no session. */
function AccountPage({
	account,
	navigate,
	onChange,
}: {
	account: SelfAccount | null | undefined
	navigate: Navigate
	onChange: (a: SelfAccount) => void
}) {
	useEffect(() => {
		if (account === null) navigate('/login')
	}, [account, navigate])

	if (!account) {
		return (
			<main className="shell">
				<p className="muted">{account === undefined ? 'Loading…' : 'Redirecting…'}</p>
			</main>
		)
	}

	return (
		<main className="shell wide">
			<h1>My account</h1>
			<Dashboard account={account} onChange={onChange} />
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

// Manual web signups are disabled for now, so only sign-in is exposed (accounts are
// created via the game/platform, not the website). To bring signups back, restore a
// SignupForm calling POST /api/signup and re-enable that endpoint in www.app.ts.
function LoginForm({ onAuthed }: { onAuthed: (a: SelfAccount) => void }) {
	const [username, setUsername] = useState('')
	const [password, setPassword] = useState('')
	const { pending, error, run } = useAction()

	return (
		<form
			onSubmit={(e) => {
				e.preventDefault()
				void run(async () => {
					const { account } = await api<{ account: SelfAccount }>('/api/login', {
						username,
						password,
					})
					onAuthed(account)
					return ''
				})
			}}
		>
			<label>
				Username
				<input
					type="text"
					value={username}
					autoComplete="username"
					onChange={(e) => setUsername(e.target.value)}
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
}: {
	account: SelfAccount
	onChange: (a: SelfAccount) => void
}) {
	// The dashboard sections, shown one at a time via the left tab rail. Admin-only
	// sections are appended when the session carries an admin role.
	const sections = [
		{ id: 'email', label: 'Email', render: () => <EmailForm account={account} onChange={onChange} /> },
		{ id: 'password', label: 'Password', render: () => <PasswordForm /> },
		...(account.isAdmin
			? [
					{ id: 'maintenance', label: 'Server maintenance', render: () => <MaintenanceForm /> },
					{ id: 'coach', label: 'Broadcast message', render: () => <CoachMessageForm /> },
				]
			: []),
	]
	const [active, setActive] = useState(sections[0].id)
	const current = sections.find((s) => s.id === active) ?? sections[0]

	return (
		<>
			<section className="card">
				<div className="muted">Signed in as</div>
				<div className="big">
					{account.displayName || account.username}{' '}
					<span className="muted">#{account.accountId}</span>
				</div>
				<div className="muted">@{account.username}</div>
				<div className="muted">{account.email ?? 'no email set'}</div>
			</section>
			<div className="workspace">
				<nav className="vtabs">
					{sections.map((s) => (
						<button
							key={s.id}
							className={s.id === active ? 'active' : ''}
							onClick={() => setActive(s.id)}
						>
							{s.label}
						</button>
					))}
				</nav>
				<div className="panel">{current.render()}</div>
			</div>
		</>
	)
}

/** Admin-only: send a coach/system message to every online player. */
function CoachMessageForm() {
	const [message, setMessage] = useState('')
	const { pending, error, done, run } = useAction()

	return (
		<section className="card">
			<h2>Broadcast message</h2>
			<p className="muted">
				Send a message from the Coach to every connected player. Players who aren&apos;t online
				won&apos;t receive it.
			</p>
			<form
				onSubmit={(e) => {
					e.preventDefault()
					void run(async () => {
						const { sent } = await api<{ sent?: number }>('/api/coach-message', {
							messageContent: message,
						})
						setMessage('')
						return `Sent to ${sent ?? 0} online player${sent === 1 ? '' : 's'}.`
					})
				}}
			>
				<label>
					Message
					<textarea
						value={message}
						rows={3}
						onChange={(e) => setMessage(e.target.value)}
						required
					/>
				</label>
				{error && <p className="error">{error}</p>}
				{done && <p className="ok">{done}</p>}
				<button type="submit" disabled={pending}>
					{pending ? 'Sending…' : 'Send to all online'}
				</button>
			</form>
		</section>
	)
}

/** Admin-only: broadcast a server-maintenance countdown to every connected client. */
function MaintenanceForm() {
	const [minutes, setMinutes] = useState('5')
	const { pending, error, done, run } = useAction()

	return (
		<section className="card">
			<h2>Server maintenance</h2>
			<p className="muted">
				Broadcast a maintenance countdown to every connected client. Enter how many minutes until
				maintenance starts (0 = now).
			</p>
			<form
				onSubmit={(e) => {
					e.preventDefault()
					void run(async () => {
						const { connections } = await api<{ connections?: number }>('/api/maintenance', {
							startsInMinutes: Number(minutes),
						})
						return `Notified ${connections ?? 0} connected client${connections === 1 ? '' : 's'}.`
					})
				}}
			>
				<label>
					Starts in (minutes)
					<input
						type="number"
						min="0"
						step="1"
						value={minutes}
						onChange={(e) => setMinutes(e.target.value)}
						required
					/>
				</label>
				{error && <p className="error">{error}</p>}
				{done && <p className="ok">{done}</p>}
				<button type="submit" disabled={pending}>
					{pending ? 'Broadcasting…' : 'Broadcast maintenance'}
				</button>
			</form>
		</section>
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
