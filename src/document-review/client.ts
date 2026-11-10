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
import { UNCERTAIN_REVIEW_FAILURE } from './refusal.js'

export const defaultReviewRoot = () => join(homedir(), '.helm', 'document-review')
export const MALFORMED_REVIEW_RESPONSE = 'Review response is malformed or oversized. No command will be replayed.'

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
		const cancelled = () => finish(new Error('Review operation cancelled. Check delivery before sending again.'))
		const timer = setTimeout(
			() => finish(new Error('Review operation timed out. Check delivery; do not replay an uncertain command.')),
			command.action === 'next'
				? command.timeoutMs + 2000
				: command.action === 'view'
					? 30000
					: command.action === 'open'
						? 15000
						: 5000,
		)
		signal?.addEventListener('abort', cancelled, { once: true })
		socket.once('connect', () => socket.write(bytes))
		socket.once('error', () =>
			finish(
				new Error('Could not reach the review connection. Start an updated Helm desktop, then reconnect explicitly.'),
			),
		)
		socket.once('close', () => {
			if (!settled) finish(new Error('Review response was lost. Check delivery; do not replay uncertain feedback.'))
		})
		socket.on('data', chunk => {
			count += chunk.length
			if (count > REVIEW_WIRE_BYTES) {
				finish(new Error('Review response exceeds its byte limit.'))
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
					finish(new Error(response.error))
					return
				}
				finish(undefined, schema.parse(response.data))
			} catch {
				finish(new Error(MALFORMED_REVIEW_RESPONSE))
			}
		})
	})
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
