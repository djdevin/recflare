import { useCallback, useEffect, useRef, useState } from 'react'

import {
	DISCORD_INVITE,
	DOWNLOAD_URL,
	LICENSE_URL,
	QUEST_DOWNLOAD_URL,
	SOURCE_REPO,
} from '../links'

import type { ReactNode } from 'react'

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
 * Site config from the BFF (`/api/config`). `signupEnabled` is false when the operator
 * has no Turnstile keypair configured — web signup runs behind that bot check, so
 * without it the endpoint is closed and the UI must not offer the form.
 */
interface SiteConfig {
	signupEnabled: boolean
	turnstileSiteKey: string | null
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
	// undefined until the config lands. Signup is treated as closed until told otherwise,
	// so a slow (or failed) config fetch can't flash a form the server would refuse.
	const [config, setConfig] = useState<SiteConfig | undefined>(undefined)
	const { path, navigate } = useRouter()

	useEffect(() => {
		api<SelfAccount>('/api/me')
			.then((me) => setAccount(me))
			.catch(() => setAccount(null))
		api<SiteConfig>('/api/config')
			.then((c) => setConfig(c))
			.catch(() => setConfig({ signupEnabled: false, turnstileSiteKey: null }))
	}, [])

	const logout = useCallback(async () => {
		await api('/api/logout', {})
		setAccount(null)
		navigate('/')
	}, [navigate])

	return (
		<>
			<NavBar account={account} path={path} navigate={navigate} onLogout={logout} />
			{path === '/login' || path === '/signup' ? (
				// One page, two doors. `/signup` exists so the homepage's create-account link
				// lands on that tab instead of dropping people on sign-in to find it — and so
				// the URL is linkable. Unknown paths fall back to index.html (see the assets
				// config in wrangler.jsonc), so a cold load of /signup reaches the SPA.
				<LoginPage
					account={account}
					config={config}
					initialTab={path === '/signup' ? 'signup' : 'login'}
					navigate={navigate}
					onAuthed={setAccount}
				/>
			) : path === '/account' ? (
				<AccountPage account={account} navigate={navigate} onChange={setAccount} />
			) : (
				<HomePage account={account} config={config} navigate={navigate} />
			)}
			<SiteFooter />
		</>
	)
}

/** Footer: where to go next, plus the affiliation disclaimer. */
function SiteFooter() {
	return (
		<footer className="footer">
			<span>
				<a href={LICENSE_URL} target="_blank" rel="noreferrer">
					MIT licensed
				</a>{' '}
				— made by fans, not affiliated with Rec Room Inc.
			</span>
			<nav>
				{/* A real navigation, not a client-side route: /privacy is rendered by the
				    Worker (see src/privacy.ts) so it reads without JavaScript. */}
				<a href="/privacy">Privacy</a>
				<a href={DISCORD_INVITE} target="_blank" rel="noreferrer">
					Discord
				</a>
				<a href={SOURCE_REPO} target="_blank" rel="noreferrer">
					GitHub
				</a>
			</nav>
		</footer>
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
				<a href={DISCORD_INVITE} target="_blank" rel="noreferrer">
					Discord
				</a>
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

/** A recent public image plus who took it and where. */
interface Slide {
	url: string
	username: string
	roomName: string | null
}

/** Loads the public photo feed once. `slides === null` means still in flight. */
function useSlideshow() {
	const [slides, setSlides] = useState<Slide[] | null>(null)
	const [error, setError] = useState('')

	useEffect(() => {
		api<{ images: Slide[] }>('/api/slideshow')
			.then((d) => setSlides(d.images))
			.catch((e) => setError(e instanceof Error ? e.message : String(e)))
	}, [])

	return { slides, error }
}

/**
 * Public homepage. The stage leads: photos players actually took, with the way in
 * on top of them. Everything about how the thing is built sits below, for whoever
 * scrolls looking for it.
 */
function HomePage({
	account,
	config,
	navigate,
}: {
	account: SelfAccount | null | undefined
	config: SiteConfig | undefined
	navigate: Navigate
}) {
	const feed = useSlideshow()

	// The signup offer only makes sense to a signed-out visitor when the server would
	// actually take one. `account === undefined` is still-checking, so it shows nothing
	// rather than offering an account to someone who already has one.
	const offerSignup = account === null && config?.signupEnabled === true

	return (
		<main>
			<Stage slides={feed.slides} offerSignup={offerSignup} navigate={navigate} />
			<div className="shell home">
				<About slides={feed.slides} error={feed.error} />
			</div>
		</main>
	)
}

/**
 * The hero: the headline and the way in on the left, a rotating in-game photo on the
 * right. The photo is proof, never the payload — when the feed is slow or down the
 * frame holds its space and the left half reads the same, so "Play now!" is reachable
 * either way.
 */
function Stage({
	slides,
	offerSignup,
	navigate,
}: {
	slides: Slide[] | null
	offerSignup: boolean
	navigate: Navigate
}) {
	const [idx, setIdx] = useState(0)
	const count = slides?.length ?? 0

	// A timeout keyed on the current slide rather than one long-lived interval: steering
	// by hand re-arms it, so a photo you just picked gets its full six seconds.
	useEffect(() => {
		if (count < 2) return
		const t = setTimeout(() => setIdx((i) => (i + 1) % count), 6000)
		return () => clearTimeout(t)
	}, [count, idx])

	const slide = slides && slides.length > 0 ? slides[idx] : null
	const step = (by: number) => setIdx((i) => (i + by + count) % count)

	return (
		<section className="stage">
			<div className="stage-body">
				{/* Deliberately doesn't name the game: this is a fan project, so the
				    trademark stays out of the headline and appears lower down, in
				    plain nominative use next to the disclaimer. */}
				<h1 className="stage-title">
					Play like it&apos;s <em>2023</em>.
				</h1>
				<p className="stage-lede">
					The servers you remember, rebuilt and running — free, open source, and up right now.
				</p>
				<div className="stage-actions">
					<a className="cta" href={DOWNLOAD_URL} target="_blank" rel="noreferrer">
						Download for PC
					</a>
					<a className="cta" href={QUEST_DOWNLOAD_URL} target="_blank" rel="noreferrer">
						Download for Quest
					</a>
					<a className="cta discord" href={DISCORD_INVITE} target="_blank" rel="noreferrer">
						Join the Discord
					</a>
				</div>
				{/* A line rather than a fourth button: the download is the point of this page,
				    and launching the game makes an account by itself — signing up here is the
				    way in for someone who wants one first. Hidden entirely when signup is
				    closed, matching /login, which hides its create-account tab the same way. */}
				{offerSignup && (
					<p className="stage-alt">
						New here?{' '}
						<Link to="/signup" navigate={navigate}>
							Create an account
						</Link>
					</p>
				)}
			</div>
			<div className="stage-show">
				<div className="stage-frame">
					{slide && (
						<img
							className="stage-photo"
							key={slide.url}
							src={slide.url}
							alt={`Photo taken in game by ${slide.username}`}
						/>
					)}
				</div>
				{/* Always mounted, so the frame doesn't shift down when the feed lands. */}
				<div className="stage-foot">
					{slide && (
						<span className="credit">
							Photo by @{slide.username}
							{slide.roomName && ` in ${slide.roomName}`}
						</span>
					)}
					{/* Arrows and a count, not a dot per photo: the feed runs to SLIDESHOW_LIMIT
					    (130) images, and a dot each is both unusable and wide enough to shove
					    the headline's half of the split off the page. */}
					{count > 1 && (
						<span className="steer">
							<button onClick={() => step(-1)} aria-label="Previous photo">
								<Chevron />
							</button>
							<span className="count">
								{idx + 1} / {count}
							</span>
							<button onClick={() => step(1)} aria-label="Next photo">
								<Chevron next />
							</button>
						</span>
					)}
				</div>
			</div>
		</section>
	)
}

/** The slideshow's back/forward mark. Decorative — the buttons carry the label. */
function Chevron({ next }: { next?: boolean }) {
	return (
		<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" focusable="false">
			<path
				d={next ? 'M9 5l7 7-7 7' : 'M15 5l-7 7 7 7'}
				fill="none"
				stroke="currentColor"
				strokeWidth="2.2"
				strokeLinecap="round"
				strokeLinejoin="round"
			/>
		</svg>
	)
}

/** What RecFlare is, under the fold, for whoever wants it. */
function About({ slides, error }: { slides: Slide[] | null; error: string }) {
	// The feed answering is proof the server replied, so the indicator can't claim
	// the server is up when it isn't.
	const state = slides !== null ? 'online' : error ? 'down' : 'checking'

	return (
		<section className="about">
			<div>
				<h2 className="about-title">An open source rebuild of the 2023 servers</h2>
				<p className="about-lede">
					A free fan project, made by players who missed it. Aiming to be{' '}
					<strong>feature-complete</strong> and infinitely scalable —{' '}
					<strong>architected for the cloud</strong>, no gatekeeping, no basement server.
				</p>
			</div>
			<div className="about-side">
				<div className="about-links">
					<a className="cta ghost" href={SOURCE_REPO} target="_blank" rel="noreferrer">
						View the source
					</a>
				</div>
				<div className="status-block">
					<p className={`status ${state}`}>
						<span className="dot" />
						{state === 'online'
							? 'Servers are up'
							: state === 'down'
								? "Can't reach the servers"
								: 'Checking…'}
					</p>
					{/* Only when it's actually up: when it isn't, people want the status, not the joke. */}
					{state === 'online' && <p className="status-quip">The cloud never goes down, right?</p>}
				</div>
			</div>
		</section>
	)
}

/**
 * The sign-in page — sign in, plus create-account when the server says signup is open
 * (it needs a Turnstile keypair; see SiteConfig). Redirects to the account page once a
 * session exists, however it was obtained.
 */
function LoginPage({
	account,
	config,
	initialTab,
	navigate,
	onAuthed,
}: {
	account: SelfAccount | null | undefined
	config: SiteConfig | undefined
	initialTab: 'signup' | 'login'
	navigate: Navigate
	onAuthed: (a: SelfAccount) => void
}) {
	// The tab IS the route (`/login` vs `/signup`) rather than local state, so the two can
	// never disagree — switching tabs pushes history, and back goes back to the other one.
	const tab = initialTab

	useEffect(() => {
		if (account) navigate('/account')
	}, [account, navigate])

	const authed = (a: SelfAccount) => {
		onAuthed(a)
		navigate('/account')
	}

	const siteKey = config?.signupEnabled ? config.turnstileSiteKey : null

	return (
		<main className="shell">
			<section className="card">
				{siteKey && (
					<div className="tabs">
						<button className={tab === 'login' ? 'active' : ''} onClick={() => navigate('/login')}>
							Sign in
						</button>
						<button
							className={tab === 'signup' ? 'active' : ''}
							onClick={() => navigate('/signup')}
						>
							Create account
						</button>
					</div>
				)}
				{siteKey && tab === 'signup' ? (
					<>
						<h2>Create account</h2>
						<p className="muted">
							A username is assigned for you — you&apos;ll see it on your account page. Choose a
							password, and the two together sign you in here and in the game.
						</p>
						<SignupForm siteKey={siteKey} onAuthed={authed} />
					</>
				) : (
					<>
						<h2>Sign in</h2>
						<p className="muted">
							Use your username and password. Launching the game also creates an account, linked to
							your Steam ID — set a password on it and it signs in here too.
						</p>
						<LoginForm onAuthed={authed} />
						{/* The tabs above already offer this; the line under the button is where
						    someone who just found out they have no account is actually looking.
						    Gated on the same key, so it can't point at a door that isn't there. */}
						{siteKey && (
							<p className="muted swap">
								Don&apos;t have an account?{' '}
								<Link to="/signup" navigate={navigate}>
									Create one
								</Link>
							</p>
						)}
					</>
				)}
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

/**
 * Turnstile's browser API, as much of it as the signup widget uses. Loaded from
 * Cloudflare at runtime (see loadTurnstile) rather than bundled, so it isn't in
 * node_modules and has no types of its own.
 */
interface TurnstileApi {
	render: (
		el: HTMLElement,
		opts: {
			sitekey: string
			action?: string
			callback?: (token: string) => void
			'expired-callback'?: () => void
		}
	) => string | undefined
	reset: (widgetId?: string) => void
	remove: (widgetId?: string) => void
}

declare global {
	interface Window {
		turnstile?: TurnstileApi
	}
}

/**
 * Load Turnstile's script, once per page, resolving when `window.turnstile` is ready.
 * `render=explicit` stops it scanning the document for widgets: this is a SPA, so the
 * container mounts and unmounts with the form and we render into it ourselves.
 *
 * The promise is cached at module scope, so switching tabs back and forth reuses the
 * loaded script instead of appending another tag. A rejection is cached too — the retry
 * is a page reload, which is what the error message asks for.
 */
let turnstileScript: Promise<void> | null = null
function loadTurnstile(): Promise<void> {
	turnstileScript ??= new Promise<void>((resolve, reject) => {
		const el = document.createElement('script')
		el.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit'
		el.async = true
		el.defer = true
		el.onload = () => resolve()
		el.onerror = () => reject(new Error('load failed'))
		document.head.appendChild(el)
	})
	return turnstileScript
}

/**
 * Mount a Turnstile widget and hand back the token it produces. No token means no
 * submit: the BFF refuses a signup without one, so the form gates its button on it
 * rather than letting the request fail.
 *
 * `reset` re-arms the widget for another attempt — a token is single-use, so a rejected
 * signup can't be retried with the same one.
 */
function useTurnstile(siteKey: string) {
	const container = useRef<HTMLDivElement | null>(null)
	const widgetId = useRef<string | undefined>(undefined)
	const [token, setToken] = useState('')
	const [error, setError] = useState('')

	useEffect(() => {
		let live = true
		loadTurnstile()
			.then(() => {
				// StrictMode mounts twice, and the cleanup below removes the first widget; bail
				// if this effect is the stale one so we don't render into a detached container.
				if (!live || !container.current || !window.turnstile) return
				widgetId.current = window.turnstile.render(container.current, {
					sitekey: siteKey,
					// Marker Cloudflare uses to segment Turnstile integrations; carries no user data.
					action: 'turnstile-spin-v1',
					callback: (t) => setToken(t),
					// Tokens expire after a few minutes; drop ours so the button locks again and
					// Turnstile can hand us a fresh one.
					'expired-callback': () => setToken(''),
				})
			})
			.catch(() => {
				if (live) setError("Couldn't load the bot check — reload the page to try again.")
			})

		return () => {
			live = false
			if (widgetId.current) window.turnstile?.remove(widgetId.current)
			widgetId.current = undefined
		}
	}, [siteKey])

	const reset = useCallback(() => {
		setToken('')
		if (widgetId.current) window.turnstile?.reset(widgetId.current)
	}, [])

	return { container, token, error, reset }
}

/**
 * Create an account from the website: a password, plus a Turnstile token proving a human
 * filled the form. The username comes back auto-assigned from `auth` (players don't pick
 * one), and the session is live on success — so this lands on the account page, where the
 * username is shown.
 */
function SignupForm({
	siteKey,
	onAuthed,
}: {
	siteKey: string
	onAuthed: (a: SelfAccount) => void
}) {
	const [password, setPassword] = useState('')
	const [email, setEmail] = useState('')
	const { container, token, error: widgetError, reset } = useTurnstile(siteKey)
	const { pending, error, run } = useAction()

	return (
		<form
			onSubmit={(e) => {
				e.preventDefault()
				void run(async () => {
					try {
						const { account } = await api<{ account: SelfAccount }>('/api/signup', {
							password,
							email,
							turnstileToken: token,
						})
						onAuthed(account)
						return ''
					} catch (err) {
						// The token is spent either way, so re-arm the widget before they retry.
						reset()
						throw err
					}
				})
			}}
		>
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
			{/* Optional, and the button doesn't wait on it — but it's the only contact detail
			    an account has, so the hint says plainly what it's for rather than leaving it
			    to be guessed. `type="email"` gets the right keyboard on mobile and a free
			    format check; the worker re-checks it before the account is created. */}
			<label>
				Email <span className="optional">optional</span>
				<input
					type="email"
					value={email}
					autoComplete="email"
					onChange={(e) => setEmail(e.target.value)}
				/>
				<span className="hint">
					How you get back in if you forget your password — there&apos;s no other way to reach you.
					You can add it later on your account page.
				</span>
			</label>
			<div className="turnstile" ref={container} />
			{widgetError && <p className="error">{widgetError}</p>}
			{error && <p className="error">{error}</p>}
			<button type="submit" disabled={pending || token === ''}>
				{pending ? 'Creating…' : 'Create account'}
			</button>
		</form>
	)
}

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
		{
			id: 'email',
			label: 'Email',
			render: () => <EmailForm account={account} onChange={onChange} />,
		},
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
			<section className="card identity">
				<div className="muted">Signed in as</div>
				<div className="big">{account.displayName || account.username}</div>
				<div className="handle">
					@{account.username} · #{account.accountId} · {account.email ?? 'no email set'}
				</div>
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
