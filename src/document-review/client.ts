import { createConnection } from 'node:net'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { z } from 'zod'
import type { ZodType } from 'zod'
import { readPrivateJson } from './private-state.js'
import {
	REVIEW_WIRE_BYTES,
	connectedSchema,
	connectionSchema,
	discoverySchema,
	helloSchema,
	responseSchema,
	viewResultSchema,
} from './protocol.js'
import type { ReviewCommand, ReviewConnection, ReviewEnvelope, ReviewHello, ReviewViewResult } from './protocol.js'
import { REVIEW_HOST_RESTARTING, REVIEW_RETRY_LATER, UNCERTAIN_REVIEW_FAILURE } from './refusal.js'

export const defaultReviewRoot = () => join(homedir(), '.helm', 'document-review')
export const MALFORMED_REVIEW_RESPONSE = 'Review response is malformed or oversized. No command will be replayed.'
export const LOST_REVIEW_RESPONSE = 'Review response was lost. Check delivery; do not replay uncertain feedback.'
export const UNREACHABLE_REVIEW_HOST =
	'Could not reach the review connection. Start an updated Helm desktop, then reconnect explicitly.'
/**
 * Why one call failed, for callers that may wait through a Helm restart. `lost`: the host closed the connection
 * before a whole answer arrived (it quit or crashed mid-command). `unreachable`: nothing listens on the socket (Helm
 * is not running, or still starting). `restarting`: the host answered that it is quitting and keeps this connection.
 * `refused`: any other answer the host gave. The message stays what it always was.
 */
export type ReviewCallFailure =
	| 'lost'
	| 'unreachable'
	| 'restarting'
	| 'refused'
	| 'timeout'
	| 'cancelled'
	| 'malformed'
export class ReviewCallError extends Error {
	override readonly name = 'ReviewCallError'
	constructor(
		message: string,
		readonly failure: ReviewCallFailure,
	) {
		super(message)
	}
}
export const reviewCallFailure = (error: unknown): ReviewCallFailure | null =>
	error instanceof ReviewCallError ? error.failure : null

export async function callReview<T>(
	authority: { socket: string; epoch: string; token: string; id?: string; owner?: string },
	command: ReviewCommand,
	schema: ZodType<T>,
	signal?: AbortSignal,
): Promise<T> {
	const frame: ReviewEnvelope = {
		epoch: authority.epoch,
		token: authority.token,
		command,
		...(authority.id ? { id: authority.id, owner: authority.owner } : {}),
	}
	const bytes = Buffer.from(`${JSON.stringify(frame)}\n`)
	if (bytes.length > REVIEW_WIRE_BYTES) throw new Error('Review command exceeds its byte limit.')
	if (signal?.aborted) throw new Error('Review operation cancelled.')
	return new Promise<T>((resolve, reject) => {
		const socket = createConnection(authority.socket)
		const chunks: Buffer[] = []
		let count = 0
		let settled = false
		const finish = (error?: Error, value?: T) => {
			if (settled) return
			settled = true
			clearTimeout(timer)
			signal?.removeEventListener('abort', cancelled)
			socket.destroy()
			if (error) reject(error)
			else resolve(value as T)
		}
		let connected = false
		const cancelled = () =>
			finish(new ReviewCallError('Review operation cancelled. Check delivery before sending again.', 'cancelled'))
		const timer = setTimeout(
			() =>
				finish(
					new ReviewCallError(
						'Review operation timed out. Check delivery; do not replay an uncertain command.',
						'timeout',
					),
				),
			command.action === 'next'
				? command.timeoutMs + 2000
				: command.action === 'view'
					? 30000
					: command.action === 'open'
						? 15000
						: 5000,
		)
		signal?.addEventListener('abort', cancelled, { once: true })
		socket.once('connect', () => {
			connected = true
			socket.write(bytes)
		})
		// Before the connection exists nothing was sent: the host is not there. After it, the command may have run.
		socket.once('error', () =>
			finish(
				connected
					? new ReviewCallError(LOST_REVIEW_RESPONSE, 'lost')
					: new ReviewCallError(UNREACHABLE_REVIEW_HOST, 'unreachable'),
			),
		)
		socket.once('close', () => {
			if (!settled) finish(new ReviewCallError(LOST_REVIEW_RESPONSE, 'lost'))
		})
		socket.on('data', chunk => {
			count += chunk.length
			if (count > REVIEW_WIRE_BYTES) {
				finish(new ReviewCallError('Review response exceeds its byte limit.', 'malformed'))
				return
			}
			chunks.push(chunk)
			if (!chunk.includes(10)) return
			try {
				const bytes = Buffer.concat(chunks, count)
				if (bytes.indexOf(10) !== bytes.length - 1) throw new Error('Invalid framing')
				const response = responseSchema.parse(
					JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, -1))),
				)
				if ('error' in response) {
					finish(
						new ReviewCallError(
							response.error,
							response.error.startsWith(REVIEW_HOST_RESTARTING) || response.error.startsWith(REVIEW_RETRY_LATER)
								? 'restarting'
								: 'refused',
						),
					)
					return
				}
				finish(undefined, schema.parse(response.data))
			} catch {
				finish(new ReviewCallError(MALFORMED_REVIEW_RESPONSE, 'malformed'))
			}
		})
	})
}
/** How long a caller command waits for a restarting Helm to come back before it gives up with concrete advice. */
export const REVIEW_RECONNECT_MS = 15 * 60 * 1000
/** A restart can only interrupt a command in these ways; anything else is a real answer. */
const RESTART_FAILURES: ReadonlySet<ReviewCallFailure> = new Set(['lost', 'unreachable', 'restarting'])
export class ReviewReconnectTimeout extends Error {
	override readonly name = 'ReviewReconnectTimeout'
}
/**
 * One caller command that survives a Helm restart (S13). It is only for commands the host makes safe to resend
 * with the SAME connection: `next` (an offered but unconfirmed feedback is offered again, never another one), `ack`
 * (confirming twice is a no-op) and `reply` (an identical report is deduplicated, also across a restart). The host
 * keeps the connection on disk, so after it is back the same handle works. Waits about a second between tries
 * until `until` (a wall-clock time); `onWait` runs once, on the first interruption. Never used for `open`/`connect`.
 */
export async function callReviewThroughRestart<T>(
	authority: { socket: string; epoch: string; token: string; id?: string; owner?: string },
	command:
		| Extract<ReviewCommand, { action: 'next' | 'ack' | 'reply' }>
		| (() => Promise<Extract<ReviewCommand, { action: 'next' | 'ack' | 'reply' }>>),
	schema: ZodType<T>,
	options: { until: number; signal?: AbortSignal; onWait?: (failure: ReviewCallFailure) => void; pauseMs?: number },
): Promise<T> {
	let waited = false
	for (;;) {
		try {
			// A factory runs on every try, so it can learn the host's features again after a restart.
			const value = typeof command === 'function' ? await command() : command
			const now = Date.now()
			// A read never asks the host for longer than the time that is left.
			const sent =
				value.action === 'next'
					? { ...value, timeoutMs: Math.max(1, Math.min(value.timeoutMs, options.until - now)) }
					: value
			return await callReview(authority, sent, schema, options.signal)
		} catch (error) {
			const failure = reviewCallFailure(error)
			if (!failure || !RESTART_FAILURES.has(failure)) throw error
			if (options.signal?.aborted) throw error
			if (!waited) {
				waited = true
				options.onWait?.(failure)
			}
			if (Date.now() >= options.until) throw new ReviewReconnectTimeout((error as Error).message)
			await new Promise<void>(done => {
				const timer = setTimeout(done, Math.min(options.pauseMs ?? 1000, Math.max(0, options.until - Date.now())))
				options.signal?.addEventListener(
					'abort',
					() => {
						clearTimeout(timer)
						done()
					},
					{ once: true },
				)
			})
			if (options.signal?.aborted) throw new ReviewCallError('Review operation cancelled.', 'cancelled')
		}
	}
}
async function readDiscovery(root: string) {
	const discovery = discoverySchema.parse(await readPrivateJson(join(root, 'discovery.json')))
	if (dirname(discovery.socket) !== resolve(root))
		throw new Error('Review discovery points outside its private directory.')
	return discovery
}
export async function connectReview(
	command: Extract<ReviewCommand, { action: 'connect' }>,
	root = defaultReviewRoot(),
	signal?: AbortSignal,
) {
	return callReview(await readDiscovery(root), command, connectedSchema, signal)
}
/** A protocol-1 host: it has no `hello` and no plain viewing. */
export const REVIEW_V1: ReviewHello = { protocol: 1, features: [] }
/**
 * Learn the host's protocol. Only an answer that is exactly the old generic failure, or malformed, means a version 1
 * host; any other failure (desktop not running, a definite refusal) is thrown as it is. The version is never
 * inferred from a failed `view` or `connect`.
 */
export async function helloReview(root = defaultReviewRoot(), signal?: AbortSignal): Promise<ReviewHello> {
	const discovery = await readDiscovery(root)
	try {
		return await callReview(discovery, { action: 'hello' }, helloSchema, signal)
	} catch (error) {
		const message = error instanceof Error ? error.message : ''
		if (message === UNCERTAIN_REVIEW_FAILURE || message === MALFORMED_REVIEW_RESPONSE) return REVIEW_V1
		throw error
	}
}
/** Show files read-only in the desktop (protocol 2). Per-file refusals come back in the result, never thrown. */
export async function viewReview(
	files: string[],
	root = defaultReviewRoot(),
	signal?: AbortSignal,
): Promise<ReviewViewResult> {
	return callReview(await readDiscovery(root), { action: 'view', files }, viewResultSchema, signal)
}
export async function loadReviewConnection(file: string): Promise<ReviewConnection> {
	const descriptor = connectionSchema.parse(await readPrivateJson(file))
	if (dirname(descriptor.socket) !== dirname(resolve(file)))
		throw new Error('Review connection points outside its private directory.')
	return descriptor
}
export async function reviewHostStatus(root = defaultReviewRoot()) {
	const discovery = await readDiscovery(root)
	return callReview(
		discovery,
		{ action: 'status' },
		z.object({ version: z.literal(1), epoch: z.string().uuid(), available: z.boolean() }).strict(),
	)
}
