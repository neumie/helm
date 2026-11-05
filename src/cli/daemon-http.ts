// Thin HTTP client the `helm` CLI uses to talk to the RUNNING daemon. Side-effect free
// (src/cli/helm.ts dispatches on import, so shared helpers live here). The daemon is the
// single owner of the DB; no CLI command opens it. Every response is the daemon's
// `{ data } | { error }` envelope, parsed as text first (src/util/daemon-response.ts).

import { parseDaemonEnvelope } from '../util/daemon-response.js'

export const DEFAULT_DAEMON_URL = 'http://localhost:7474'

/**
 * Daemon base URL: explicit url ?? $HELM_URL ?? $VIGIL_URL (legacy compat) ??
 * localhost:7474, trailing slashes stripped. No config file is read.
 */
export function daemonBaseUrl(url: string | undefined, env: NodeJS.ProcessEnv = process.env): string {
	return (url ?? env.HELM_URL ?? env.VIGIL_URL ?? DEFAULT_DAEMON_URL).replace(/\/+$/, '')
}

/** {@link daemonBaseUrl} with the url taken from a `--url <baseUrl>` argument. */
export function resolveBaseUrl(args: string[], env: NodeJS.ProcessEnv = process.env): string {
	const index = args.indexOf('--url')
	let url: string | undefined
	if (index !== -1) {
		url = args[index + 1]
		if (!url || url.startsWith('--')) throw new Error('Missing value for --url')
	}
	return daemonBaseUrl(url, env)
}

/** The request never reached the daemon (connection refused, DNS, reset before a response). */
export class DaemonUnreachableError extends Error {
	constructor(
		readonly baseUrl: string,
		cause: unknown,
	) {
		super(
			`Could not reach the Helm daemon at ${baseUrl} — is it running? Start it with \`helm start\`, or set --url / $HELM_URL. (${cause instanceof Error ? cause.message : cause})`,
		)
		this.name = 'DaemonUnreachableError'
	}
}

/** The daemon answered with an error envelope or a non-2xx status. */
export class DaemonHttpError extends Error {
	constructor(
		readonly status: number,
		message: string,
	) {
		super(message)
		this.name = 'DaemonHttpError'
	}
}

export type DaemonMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'

export interface DaemonRequestOptions {
	/** JSON body (sent with Content-Type: application/json); omitted when undefined. */
	body?: unknown
	/** Tests inject a fake; defaults to the global fetch at call time. */
	fetch?: typeof fetch
	/** Aborts the request; an abort rejects with the fetch AbortError, never as unreachable. */
	signal?: AbortSignal
}

/** One request to the running daemon; unwraps its `{ data | error }` envelope. */
export async function requestDaemon<T>(
	method: DaemonMethod,
	baseUrl: string,
	path: string,
	options: DaemonRequestOptions = {},
): Promise<T> {
	const doFetch = options.fetch ?? globalThis.fetch
	const init: RequestInit = { method }
	if (options.body !== undefined) {
		init.headers = { 'Content-Type': 'application/json' }
		init.body = JSON.stringify(options.body)
	}
	if (options.signal) init.signal = options.signal
	let res: Response
	try {
		res = await doFetch(`${baseUrl}${path}`, init)
	} catch (err) {
		if (options.signal?.aborted) throw err
		throw new DaemonUnreachableError(baseUrl, err)
	}
	const json = parseDaemonEnvelope(res.status, await res.text()) as { data?: T; error?: unknown }
	if (!res.ok)
		throw new DaemonHttpError(
			res.status,
			typeof json.error === 'string' ? json.error : `Request failed: HTTP ${res.status}`,
		)
	return json.data as T
}

/** POST a JSON payload to the running daemon and unwrap its `{ data | error }` envelope. */
export function postToDaemon<T>(
	baseUrl: string,
	path: string,
	payload: unknown,
	options: Omit<DaemonRequestOptions, 'body'> = {},
): Promise<T> {
	return requestDaemon<T>('POST', baseUrl, path, { ...options, body: payload })
}

/** GET from the running daemon and unwrap its `{ data | error }` envelope. */
export function getFromDaemon<T>(
	baseUrl: string,
	path: string,
	options: Omit<DaemonRequestOptions, 'body'> = {},
): Promise<T> {
	return requestDaemon<T>('GET', baseUrl, path, options)
}
