// The `helm-viewer:` protocol, Electron-free (docs/plans/helm-open/spec.md, Renderer isolation and Main process):
// the URL-blocking predicate, Range parsing, the per-view token table and the request handler are pure and take
// their file reads as injected functions, so `node --test` covers them. `viewer-session.ts` wires them into one
// window's in-memory Electron session.
import { randomBytes } from 'node:crypto'
import { VIEWER_CSP, VIEWER_FILE_CSP } from './viewer-csp'

export const VIEWER_SCHEME = 'helm-viewer'
export const VIEWER_HOST = 'app'
export const VIEWER_ORIGIN = `${VIEWER_SCHEME}://${VIEWER_HOST}`
export const VIEWER_INDEX_URL = `${VIEWER_ORIGIN}/index.html`

/** Registered once, before `ready`, in main.ts; any later scheme joins the same array. */
export const VIEWER_SCHEME_PRIVILEGES = {
	standard: true,
	secure: true,
	supportFetchAPI: true,
	stream: true,
	bypassCSP: false,
	allowServiceWorkers: false,
	corsEnabled: false,
} as const

/**
 * Whether a viewer window's session may make a request at all. An allow-list, not a deny-list: only the viewer's
 * own origin and the in-page `blob:`/`data:` URLs pass (plus DevTools' own pages); http(s), ws(s), ftp, file and
 * every scheme nobody thought of are cancelled.
 */
export function viewerRequestAllowed(url: string): boolean {
	let parsed: URL
	try {
		parsed = new URL(url)
	} catch {
		return false
	}
	if (parsed.protocol === `${VIEWER_SCHEME}:`)
		return parsed.host === VIEWER_HOST && !parsed.username && !parsed.password
	return parsed.protocol === 'blob:' || parsed.protocol === 'data:' || parsed.protocol === 'devtools:'
}

/** Largest single response the file route sends; a longer range is clamped (a short 206 is valid HTTP). */
export const VIEWER_RANGE_CAP = 64 * 1024 * 1024

export type RangeChoice = { kind: 'full' } | { kind: 'partial'; start: number; end: number } | { kind: 'unsatisfiable' }

/**
 * One `bytes=` range against a resource of `size` bytes: `a-b`, `a-` or `-n`. A malformed or multi-range header
 * is ignored (the whole body is sent, which HTTP allows); a range starting past the end is 416; the end is clamped
 * to the last byte and the length to `cap`.
 */
export function parseRange(header: string | null, size: number, cap = VIEWER_RANGE_CAP): RangeChoice {
	if (header === null) return { kind: 'full' }
	const match = /^\s*bytes\s*=\s*(\d*)\s*-\s*(\d*)\s*$/i.exec(header)
	if (!match) return { kind: 'full' }
	const [, first = '', last = ''] = match
	if (!first && !last) return { kind: 'full' }
	if (first.length > 15 || last.length > 15) return { kind: 'unsatisfiable' }
	let start: number
	let end: number
	if (!first) {
		const suffix = Number(last)
		if (suffix === 0 || size === 0) return { kind: 'unsatisfiable' }
		start = Math.max(0, size - suffix)
		end = size - 1
	} else {
		start = Number(first)
		end = last ? Number(last) : size - 1
		if (last && end < start) return { kind: 'full' }
		if (start >= size) return { kind: 'unsatisfiable' }
		end = Math.min(end, size - 1)
	}
	end = Math.min(end, start + cap - 1)
	return { kind: 'partial', start, end }
}

/** The bytes one token serves: admitted, pinned, read on demand. */
export interface ViewerFileSource {
	size: number
	/** Throws `ViewerSourceChanged` when the pinned file no longer has its admitted identity. */
	read(offset: number, length: number): Promise<Uint8Array>
	close(): Promise<void> | void
}
export class ViewerSourceChanged extends Error {
	override readonly name = 'ViewerSourceChanged'
}

interface TokenEntry {
	source: ViewerFileSource
	revoked: boolean
	reads: number
	closed: boolean
}

/**
 * One view's file tokens. A token is 256 random bits, reachable only through that view's own session handler, and
 * dies with `revoke`: a revoked token answers 404 at once, and its descriptor closes when the last read in flight
 * finishes. A view holds very few (its current revision), so the table is bounded.
 */
export class ViewerFileTokens {
	static readonly LIMIT = 8
	private readonly entries = new Map<string, TokenEntry>()
	private disposed = false

	issue(source: ViewerFileSource): string {
		if (this.disposed) {
			void source.close()
			throw new Error('This view is closed.')
		}
		const live = [...this.entries.values()].filter(entry => !entry.revoked).length
		if (live >= ViewerFileTokens.LIMIT) {
			void source.close()
			throw new Error('Too many open file tokens for one view.')
		}
		const token = randomBytes(32).toString('base64url')
		this.entries.set(token, { source, revoked: false, reads: 0, closed: false })
		return token
	}
	/** Live tokens (for tests and accounting). */
	get size(): number {
		return [...this.entries.values()].filter(entry => !entry.revoked).length
	}
	has(token: string): boolean {
		const entry = this.entries.get(token)
		return Boolean(entry && !entry.revoked)
	}
	/** Serve a read while holding the descriptor open; a revoked or unknown token reads as null. */
	async read(token: string, use: (source: ViewerFileSource) => Promise<Response>): Promise<Response | null> {
		const entry = this.entries.get(token)
		if (!entry || entry.revoked) return null
		entry.reads++
		try {
			return await use(entry.source)
		} finally {
			entry.reads--
			if (entry.revoked) await this.close(token, entry)
		}
	}
	async revoke(token: string): Promise<void> {
		const entry = this.entries.get(token)
		if (!entry || entry.revoked) return
		entry.revoked = true
		if (entry.reads === 0) await this.close(token, entry)
	}
	async revokeAll(): Promise<void> {
		this.disposed = true
		await Promise.all([...this.entries.keys()].map(token => this.revoke(token)))
	}
	private async close(token: string, entry: TokenEntry) {
		if (entry.closed) return
		entry.closed = true
		this.entries.delete(token)
		try {
			await entry.source.close()
		} catch {
			// Closing a descriptor that is already gone is fine.
		}
	}
}

export const viewerFileUrl = (token: string) => `${VIEWER_ORIGIN}/file/${token}`

const MIME: Readonly<Record<string, string>> = {
	'.html': 'text/html; charset=utf-8',
	'.js': 'text/javascript; charset=utf-8',
	'.mjs': 'text/javascript; charset=utf-8',
	'.css': 'text/css; charset=utf-8',
	'.json': 'application/json',
	'.map': 'application/json',
	'.wasm': 'application/wasm',
	'.woff2': 'font/woff2',
	'.woff': 'font/woff',
	'.ttf': 'font/ttf',
	'.png': 'image/png',
	'.svg': 'image/svg+xml',
	'.bcmap': 'application/octet-stream',
	'.pfb': 'application/octet-stream',
}
/** Exact MIME type of a bundled asset, or null when the handler does not serve that kind of file. */
export function assetMime(path: string): string | null {
	const dot = path.lastIndexOf('.')
	return dot < 0 ? null : (MIME[path.slice(dot).toLowerCase()] ?? null)
}

const SEGMENT = /^[A-Za-z0-9_][A-Za-z0-9._-]*$/
/** `assets/…` path segments, or null for anything that could leave `dist/viewer/assets/`. */
export function assetPath(pathname: string): string | null {
	if (!pathname.startsWith('/assets/')) return null
	const rest = pathname.slice('/assets/'.length)
	if (!rest || rest.length > 256) return null
	const segments = rest.split('/')
	if (segments.length > 4 || !segments.every(segment => SEGMENT.test(segment) && !segment.includes('..'))) return null
	return segments.join('/')
}

export interface ViewerHandlerDependencies {
	/** `index.html` or a validated `assets/…` path under `dist/viewer`; null when it does not exist. */
	readAsset(path: string): Promise<Uint8Array | null>
	tokens: ViewerFileTokens
}

const baseHeaders = (contentType: string, csp: string): Record<string, string> => ({
	'Content-Type': contentType,
	'Content-Security-Policy': csp,
	'X-Content-Type-Options': 'nosniff',
	'Cache-Control': 'no-store',
	'Cross-Origin-Resource-Policy': 'same-origin',
	'Referrer-Policy': 'no-referrer',
})
const plain = (status: number, text: string) =>
	new Response(text, { status, headers: baseHeaders('text/plain; charset=utf-8', VIEWER_CSP) })
const body = (bytes: Uint8Array) => bytes as unknown as BodyInit

/**
 * Answers one request on a view's session. Only GET/HEAD to helm-viewer://app: the page, its bundled assets and
 * that view's own file tokens. Every response carries the CSP header (workers included); file bytes get an inert
 * type plus a sandbox CSP and are never served as script.
 */
export async function handleViewerRequest(request: Request, deps: ViewerHandlerDependencies): Promise<Response> {
	let url: URL
	try {
		url = new URL(request.url)
	} catch {
		return plain(400, 'Bad request')
	}
	if (url.protocol !== `${VIEWER_SCHEME}:` || url.host !== VIEWER_HOST || url.username || url.password)
		return plain(404, 'Not found')
	if (request.method !== 'GET' && request.method !== 'HEAD') return plain(405, 'Method not allowed')
	const head = request.method === 'HEAD'
	const path = url.pathname
	if (path === '/' || path === '/index.html') {
		const bytes = await deps.readAsset('index.html')
		if (!bytes) return plain(404, 'Not found')
		return new Response(head ? null : body(bytes), {
			status: 200,
			headers: baseHeaders(MIME['.html'] as string, VIEWER_CSP),
		})
	}
	const asset = assetPath(path)
	if (asset) {
		const mime = assetMime(asset)
		if (!mime) return plain(404, 'Not found')
		const bytes = await deps.readAsset(`assets/${asset}`)
		if (!bytes) return plain(404, 'Not found')
		return new Response(head ? null : body(bytes), { status: 200, headers: baseHeaders(mime, VIEWER_CSP) })
	}
	const file = /^\/file\/([A-Za-z0-9_-]{43})$/.exec(path)
	if (file?.[1]) {
		const answered = await deps.tokens.read(file[1], async source => {
			const range = parseRange(request.headers.get('range'), source.size)
			const headers = { ...baseHeaders('application/octet-stream', VIEWER_FILE_CSP), 'Accept-Ranges': 'bytes' }
			if (range.kind === 'unsatisfiable')
				return new Response(null, { status: 416, headers: { ...headers, 'Content-Range': `bytes */${source.size}` } })
			const start = range.kind === 'partial' ? range.start : 0
			const length = range.kind === 'partial' ? range.end - range.start + 1 : source.size
			if (length > VIEWER_RANGE_CAP && range.kind === 'full') return plain(413, 'Use a range for this file')
			let bytes: Uint8Array
			try {
				bytes = head ? new Uint8Array(0) : await source.read(start, length)
			} catch (error) {
				if (error instanceof ViewerSourceChanged) return plain(409, 'The file changed; it is being read again')
				return plain(500, 'The file could not be read')
			}
			const sized = { ...headers, 'Content-Length': String(length) }
			if (range.kind === 'partial')
				return new Response(head ? null : body(bytes), {
					status: 206,
					headers: { ...sized, 'Content-Range': `bytes ${range.start}-${range.end}/${source.size}` },
				})
			return new Response(head ? null : body(bytes), { status: 200, headers: sized })
		})
		return answered ?? plain(404, 'Not found')
	}
	return plain(404, 'Not found')
}
