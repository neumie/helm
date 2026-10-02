import { createConnection } from 'node:net'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { z } from 'zod'
import type { ZodType } from 'zod'
import { readPrivateJson } from './private-state.js'
import { REVIEW_WIRE_BYTES, connectedSchema, connectionSchema, discoverySchema, responseSchema } from './protocol.js'
import type { ReviewCommand, ReviewConnection, ReviewEnvelope } from './protocol.js'

export const defaultReviewRoot = () => join(homedir(), '.helm', 'document-review')

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
			command.action === 'next' ? command.timeoutMs + 2000 : command.action === 'open' ? 15000 : 5000,
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
				finish(new Error('Review response is malformed or oversized. No command will be replayed.'))
			}
		})
	})
}
export async function connectReview(
	command: Extract<ReviewCommand, { action: 'connect' }>,
	root = defaultReviewRoot(),
	signal?: AbortSignal,
) {
	const discovery = discoverySchema.parse(await readPrivateJson(join(root, 'discovery.json')))
	if (dirname(discovery.socket) !== resolve(root))
		throw new Error('Review discovery points outside its private directory.')
	return callReview(discovery, command, connectedSchema, signal)
}
export async function loadReviewConnection(file: string): Promise<ReviewConnection> {
	const descriptor = connectionSchema.parse(await readPrivateJson(file))
	if (dirname(descriptor.socket) !== dirname(resolve(file)))
		throw new Error('Review connection points outside its private directory.')
	return descriptor
}
export async function reviewHostStatus(root = defaultReviewRoot()) {
	const discovery = discoverySchema.parse(await readPrivateJson(join(root, 'discovery.json')))
	if (dirname(discovery.socket) !== resolve(root))
		throw new Error('Review discovery points outside its private directory.')
	return callReview(
		discovery,
		{ action: 'status' },
		z.object({ version: z.literal(1), epoch: z.string().uuid(), available: z.boolean() }).strict(),
	)
}
