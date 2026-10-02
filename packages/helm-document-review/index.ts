import { resolve } from 'node:path'
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent'
import { Type } from 'typebox'
import { LiveReviewCaller } from '../../src/document-review/live-caller.js'

/** An opt-in surface of the existing Pi runtime. No factory-time IO or automatic enrollment. */
export default function helmDocumentReview(pi: ExtensionAPI) {
	let context: ExtensionContext | null = null
	let lifecycle = 0
	let navigationFenced = false
	let opening = false
	let caller: LiveReviewCaller | null = null
	let activated = false
	let failedTurn = false
	let completedText = ''
	let previewText = ''
	const clear = () => {
		lifecycle++
		const old = caller
		caller = null
		activated = false
		failedTurn = false
		completedText = ''
		previewText = ''
		if (old) void old.dispose()
	}
	const fence = () => {
		navigationFenced = true
		clear()
	}
	pi.on('session_start', (_event, ctx) => {
		clear()
		context = ctx
		navigationFenced = false
	})
	pi.on('session_before_switch', fence)
	pi.on('session_before_fork', fence)
	pi.on('session_before_tree', fence)
	// Actual successful tree settlement, not idle/timer/unchanged UUID guessing.
	pi.on('session_tree', (_event, ctx) => {
		clear()
		context = ctx
		navigationFenced = false
	})
	pi.on('session_shutdown', () => {
		fence()
		context = null
	})

	async function open(file: string, ctx: ExtensionContext): Promise<string> {
		if (ctx.mode !== 'tui')
			throw new Error(
				'Native review connects only an existing ordinary Pi terminal. Use the CLI wait path in other modes.',
			)
		if (navigationFenced || !context || opening)
			throw new Error('Review admission is fenced by navigation or an existing open request.')
		const id = ctx.sessionManager.getSessionId()
		if (context.sessionManager.getSessionId() !== id) throw new Error('The current Pi conversation changed.')
		if (caller?.feedback) throw new Error('Wait for the active review feedback to settle before changing documents.')
		opening = true
		const token = lifecycle
		const current = () =>
			lifecycle === token && !navigationFenced && context !== null && context.sessionManager.getSessionId() === id
		try {
			const previous = caller
			caller = null
			if (previous) await previous.dispose()
			if (!current()) throw new Error('Pi lifecycle changed before opening.')
			const next = await LiveReviewCaller.connect(ctx.cwd, resolve(ctx.cwd, file), {
				current,
				dispatch: feedback => {
					if (!current()) throw new Error('Pi lifecycle changed before feedback dispatch.')
					activated = false
					failedTurn = false
					completedText = ''
					previewText = ''
					pi.sendUserMessage(feedback.prompt, { deliverAs: 'followUp', expandPromptTemplates: false })
				},
				unavailable: () => {
					if (current()) {
						caller = null
						activated = false
						ctx.ui.notify(
							'Helm review disconnected. Inspect outstanding feedback before reconnecting; nothing was replayed.',
							'warning',
						)
					}
				},
			})
			if (!current()) {
				await next.dispose()
				throw new Error('Pi lifecycle changed while opening.')
			}
			caller = next
			next.start()
			return next.connectionFile
		} finally {
			opening = false
		}
	}
	pi.registerTool({
		name: 'helm_review',
		label: 'Helm Markdown review',
		description:
			'Open a repository Markdown file in Helm and connect THIS running Pi conversation. Selection feedback becomes a follow-up in this same session; no agent is launched. The original tools/permissions/context stay unchanged. Disconnect closes only the review connection. Do not use the spawning/resume flags of another CLI.',
		parameters: Type.Object({
			action: Type.Union([Type.Literal('open'), Type.Literal('status'), Type.Literal('disconnect')]),
			file: Type.Optional(Type.String({ minLength: 1, maxLength: 2048 })),
		}),
		async execute(_id, params, _signal, _update, ctx) {
			if (params.action === 'disconnect') {
				clear()
				return { content: [{ type: 'text', text: 'Disconnected from Helm; Pi remains running.' }], details: undefined }
			}
			if (params.action === 'status')
				return {
					content: [
						{
							type: 'text',
							text: caller
								? 'This Pi session has a Helm review connection; feedback uses native follow-up delivery.'
								: 'This Pi session is not connected to Helm.',
						},
					],
					details: undefined,
				}
			if (!params.file) throw new Error('Choose a repository Markdown file.')
			const connection = await open(params.file, ctx)
			return {
				content: [
					{
						type: 'text',
						text: 'Opened in Helm and connected to this exact running Pi session. Continue normally; review feedback will arrive here. Replies are projected only for observed review turns.',
					},
				],
				details: { connection },
			}
		},
	})
	pi.registerCommand('helm-review', {
		description: 'Open Markdown in Helm and connect this session; /helm-review disconnect closes only the connection',
		async handler(args, ctx) {
			if (args.trim() === 'disconnect') {
				clear()
				ctx.ui.notify('Disconnected from Helm review.', 'info')
				return
			}
			if (!args.trim()) {
				ctx.ui.notify('Usage: /helm-review path/to/spec.md', 'info')
				return
			}
			try {
				await open(args.trim(), ctx)
				ctx.ui.notify('Document open in Helm. Feedback stays in this Pi session.', 'info')
			} catch {
				ctx.ui.notify(
					'Helm review unavailable. Check the updated desktop, repository, and lifecycle; no agent was started.',
					'warning',
				)
			}
		},
	})
	pi.on('before_agent_start', event => {
		if (!caller?.feedback || event.prompt !== caller.feedback.prompt) return
		activated = true
		caller.publish('working', '')
	})
	const shortened = (value: string, omitted = false) => {
		if (value.length <= 64000 && !omitted) return value
		let end = Math.min(value.length, 63900)
		const unit = value.charCodeAt(end - 1)
		if (unit >= 0xd800 && unit <= 0xdbff) end--
		return `${value.slice(0, end)}\n\n[Reply shortened in Helm. Read the original terminal for the complete response.]`
	}
	const text = (message: { role: string; content?: unknown }) => {
		if (message.role !== 'assistant' || !Array.isArray(message.content)) return null
		let result = ''
		for (const part of message.content.slice(0, 128)) {
			if (part?.type !== 'text' || typeof part.text !== 'string') continue
			result += part.text.slice(0, Math.max(0, 64001 - result.length))
			if (result.length > 64000) break
		}
		return shortened(result, message.content.length > 128)
	}
	pi.on('message_update', event => {
		const owner = caller
		if (!activated || !owner?.feedback) return
		const next = text(event.message)
		if (next === null || !activated || caller !== owner) return
		previewText = next
		owner.publish('working', shortened(`${completedText}${previewText}`))
	})
	pi.on('message_end', event => {
		const owner = caller
		if (!activated || !owner?.feedback) return
		const message = event.message
		const next = text(message)
		if (next === null || !activated || caller !== owner) return
		if (message.role === 'assistant') failedTurn = message.stopReason === 'error' || message.stopReason === 'aborted'
		completedText = shortened(`${completedText}${completedText ? '\n\n' : ''}${next}`)
		previewText = ''
		owner.publish('working', completedText)
	})
	pi.on('agent_settled', () => {
		// An unrelated original turn may settle before its queued follow-up begins.
		if (!activated || !caller?.feedback) return
		caller.publish(failedTurn ? 'error' : 'complete', completedText)
		activated = false
	})
}
