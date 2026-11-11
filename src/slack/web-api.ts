// Slack Web API client that speaks the web/desktop client's dialect: form POST with the `token` in
// the body and the `d` session cookie in a header, a browser-like User-Agent, and no Helm or Jakub
// identity in any header. Honours rate limits (Retry-After / `ratelimited`) per method, maps Slack
// `ok:false` errors to typed errors, and refuses to send the token anywhere but slack.com (a
// loopback override exists only for tests). The token and cookie never appear in logs or errors.

/** Default endpoint; overridable only with a loopback URL (tests). */
const SLACK_API_URL = 'https://slack.com/api/'
/** A plausible desktop User-Agent so the request looks like the client's own. */
const USER_AGENT =
	'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Slack/4.0 Chrome/128.0.0.0 Electron/32.0.0 Safari/537.36'

export type SlackFetch = (url: string, init: RequestInit) => Promise<Response>

export interface SlackClientOptions {
	fetch?: SlackFetch
	/**
	 * Test-only loopback override (a fake Slack server). Only a loopback (`127.0.0.1`/`localhost`)
	 * `http://` URL is accepted; anything else falls back to slack.com. Never sourced from the
	 * process environment — see the constructor — so an agent-controlled env cannot redirect the token.
	 */
	apiUrl?: string
	now?: () => number
}

export interface SlackSessionCreds {
	token: string
	cookie: string
}

/** A Slack API error (`ok:false`), carrying the machine `code` (never any secret). */
export class SlackApiError extends Error {
	constructor(
		readonly code: string,
		readonly method: string,
	) {
		super(`Slack ${method} failed: ${code}`)
		this.name = 'SlackApiError'
	}
}

/** The request never reached Slack, or returned a non-JSON / non-2xx response. */
export class SlackTransportError extends Error {
	constructor(message: string) {
		super(message)
		this.name = 'SlackTransportError'
	}
}

/** Slack said `ratelimited`; `retryAfterMs` is honoured before the next call to that method. */
export class SlackRateLimitError extends SlackApiError {
	constructor(
		method: string,
		readonly retryAfterMs: number,
	) {
		super('ratelimited', method)
		this.name = 'SlackRateLimitError'
	}
}

/** Only a loopback override is honoured, so a token can never be sent to another host. */
function resolveApiUrl(apiUrl: string | undefined): string {
	if (!apiUrl) return SLACK_API_URL
	let url: URL
	try {
		url = new URL(apiUrl)
	} catch {
		return SLACK_API_URL
	}
	const loopback = url.hostname === '127.0.0.1' || url.hostname === 'localhost' || url.hostname === '[::1]'
	if (!loopback || url.protocol !== 'http:') return SLACK_API_URL
	return url.href.endsWith('/') ? url.href : `${url.href}/`
}

export class SlackClient {
	private readonly apiUrl: string
	private readonly doFetch: SlackFetch
	private readonly now: () => number
	/** Per-method epoch-ms until which calls are blocked by a prior rate limit. */
	private readonly blockedUntil = new Map<string, number>()

	constructor(
		private readonly creds: SlackSessionCreds,
		options: SlackClientOptions = {},
	) {
		// The loopback override is ONLY the explicit `apiUrl` option (test injection). It is never
		// read from the process environment: the `helm slack` CLI runs with an agent-controlled env,
		// and an env-driven override to a loopback server the agent binds would exfiltrate the token
		// and cookie. With no option, the token only ever goes to slack.com.
		this.apiUrl = resolveApiUrl(options.apiUrl)
		this.doFetch = options.fetch ?? ((url, init) => fetch(url, init))
		this.now = options.now ?? (() => Date.now())
	}

	/** Ms until `method` may be called again (0 when not rate-limited). */
	rateLimitRemaining(method: string): number {
		const until = this.blockedUntil.get(method)
		return until ? Math.max(0, until - this.now()) : 0
	}

	/**
	 * One API call. `params` becomes the form body with the token appended. Throws SlackApiError on
	 * `ok:false`, SlackRateLimitError on 429/ratelimited (and records the per-method backoff),
	 * SlackTransportError on a network/JSON failure. The generic T is the caller's response shape.
	 */
	async call<T>(method: string, params: Record<string, string | number | boolean | undefined> = {}): Promise<T> {
		const remaining = this.rateLimitRemaining(method)
		if (remaining > 0) throw new SlackRateLimitError(method, remaining)

		const body = new URLSearchParams()
		for (const [key, value] of Object.entries(params)) {
			if (value !== undefined) body.set(key, String(value))
		}
		body.set('token', this.creds.token)

		let response: Response
		try {
			response = await this.doFetch(`${this.apiUrl}${method}`, {
				method: 'POST',
				headers: {
					'Content-Type': 'application/x-www-form-urlencoded; charset=utf-8',
					Cookie: `d=${this.creds.cookie}`,
					'User-Agent': USER_AGENT,
				},
				body: body.toString(),
			})
		} catch (error) {
			throw new SlackTransportError(`Could not reach Slack (${error instanceof Error ? error.name : 'network error'})`)
		}

		if (response.status === 429) {
			const retryAfterMs = this.recordRetryAfter(method, response)
			throw new SlackRateLimitError(method, retryAfterMs)
		}
		if (!response.ok) throw new SlackTransportError(`Slack ${method} returned HTTP ${response.status}`)

		let payload: { ok?: boolean; error?: string } & Record<string, unknown>
		try {
			payload = (await response.json()) as typeof payload
		} catch {
			throw new SlackTransportError(`Slack ${method} returned a non-JSON response`)
		}
		if (payload.ok === false) {
			const code = typeof payload.error === 'string' ? payload.error : 'unknown_error'
			if (code === 'ratelimited') throw new SlackRateLimitError(method, this.recordRetryAfter(method, response))
			throw new SlackApiError(code, method)
		}
		return payload as T
	}

	private recordRetryAfter(method: string, response: Response): number {
		const header = response.headers.get('retry-after')
		const seconds = header ? Number.parseInt(header, 10) : Number.NaN
		const ms = Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : 60_000
		this.blockedUntil.set(method, this.now() + ms)
		return ms
	}
}
