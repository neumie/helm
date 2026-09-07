import { randomUUID } from 'node:crypto'
import { request } from 'node:http'
import { basename } from 'node:path'
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent'
import { RemoteAdmission } from '../../src/remote/admission.js'
import { type RemoteEnrollmentFile, readRemoteEnrollment } from '../../src/remote/private-file.js'
import {
	REMOTE_BODY_LIMIT,
	REMOTE_PROTOCOL,
	type RemoteCommand,
	type RemoteReceipt,
	type RemoteSnapshot,
	remoteHostExchangeSchema,
	remoteQuestionSchema,
} from '../../src/remote/protocol.js'
import {
	QUESTION_ANSWER,
	QUESTION_CLOSED,
	QUESTION_OPEN,
	QUESTION_RECEIPT,
} from '../helm-ask-user-question/remote-answers.js'

/** Opt-in TUI adapter. No factory-time socket, file discovery or process control. */
export default function helmRemoteBridge(pi: ExtensionAPI) {
	let stop: (() => void) | undefined
	let publish: ((message: unknown, key?: string) => void) | undefined
	let changed: (() => void) | undefined
	let setQuestion: ((value: unknown, closed?: boolean) => void) | undefined
	let setWaiting: ((waiting: boolean) => void) | undefined

	function disconnect() {
		stop?.()
		stop = undefined
		publish = undefined
		changed = undefined
		setQuestion = undefined
		setWaiting = undefined
	}

	pi.registerCommand('helm-remote-connect', {
		description: 'Explicitly enroll this terminal in the isolated Helm Remote proof host',
		handler: async (path, ctx) => {
			if (ctx.mode !== 'tui' || process.env.PI_SUBAGENT_CHILD === '1') {
				ctx.ui.notify('Remote control is available only for an ordinary TUI session', 'warning')
				return
			}
			if (stop) {
				ctx.ui.notify('Already enrolled. Disconnect before enrolling again.', 'warning')
				return
			}
			try {
				const enrollment = readRemoteEnrollment(path.trim())
				const runtime = connect(pi, ctx, enrollment)
				stop = runtime.stop
				publish = runtime.publish
				changed = runtime.changed
				setQuestion = runtime.setQuestion
				setWaiting = runtime.setWaiting
				ctx.ui.notify('Remote enrollment started. The terminal remains in control.', 'info')
			} catch {
				ctx.ui.notify('Remote enrollment refused. Check the private enrollment file.', 'error')
			}
		},
	})
	pi.registerCommand('helm-remote-disconnect', {
		description: 'Stop Remote access without stopping Pi',
		handler: async (_args, ctx) => {
			disconnect()
			ctx.ui.notify('Remote disconnected', 'info')
		},
	})
	pi.on('session_shutdown', disconnect)
	// Every conversation navigation invalidates the captured command target.
	pi.on('session_tree', disconnect)
	pi.on('session_before_switch', disconnect)
	pi.on('session_before_fork', disconnect)
	pi.on('session_before_tree', disconnect)
	pi.on('message_start', event => publish?.(event.message, 'current'))
	pi.on('message_update', event => publish?.(event.message, 'current'))
	pi.on('message_end', event => publish?.(event.message))
	pi.on('agent_start', () => changed?.())
	pi.on('agent_settled', () => changed?.())
	pi.on('model_select', () => changed?.())
	pi.on('ui_prompt_start', () => setWaiting?.(true))
	pi.on('ui_prompt_end', () => setWaiting?.(false))
	const removeOpen = pi.events.on(QUESTION_OPEN, value => setQuestion?.(value))
	const removeClosed = pi.events.on(QUESTION_CLOSED, value => setQuestion?.(value, true))
	pi.on('session_shutdown', () => {
		removeOpen()
		removeClosed()
	})
}

function projectMessage(value: unknown, id: string): RemoteSnapshot['messages'][number] | null {
	if (!value || typeof value !== 'object') return null
	const message = value as { role?: string; content?: unknown }
	if (message.role !== 'user' && message.role !== 'assistant' && message.role !== 'toolResult') return null
	let text = ''
	let thinking = ''
	let truncated = false
	if (typeof message.content === 'string') {
		text = message.content.slice(0, 8192)
		truncated = message.content.length > 8192
	} else if (Array.isArray(message.content))
		for (const block of message.content.slice(0, 100)) {
			if (!block || typeof block !== 'object') continue
			if (block.type === 'text' && typeof block.text === 'string') {
				truncated ||= text.length + block.text.length > 8192
				text = (text + block.text.slice(0, 8192)).slice(0, 8192)
			}
			if (block.type === 'thinking' && typeof block.thinking === 'string') {
				truncated ||= thinking.length + block.thinking.length > 8192
				thinking = (thinking + block.thinking.slice(0, 8192)).slice(0, 8192)
			}
			if (block.type === 'toolCall' && typeof block.name === 'string')
				text = `${text}\nTool: ${block.name.slice(0, 100)}`.slice(0, 8192)
			if (block.type === 'image') text = `${text}\n[Image not included in this proof]`.slice(0, 8192)
		}
	return { id, role: message.role, text, thinking, truncated }
}

function connect(pi: ExtensionAPI, ctx: ExtensionContext, enrollment: RemoteEnrollmentFile) {
	const target = {
		sessionId: ctx.sessionManager.getSessionId(),
		incarnation: randomUUID(),
		scopeId: enrollment.scopeId,
		generation: enrollment.generation,
	}
	const admission = new RemoteAdmission(target)
	let disposed = false
	let revision = 0
	let historyTruncated = false
	let question: RemoteSnapshot['question'] = null
	const questions = new Map<string, NonNullable<RemoteSnapshot['question']>>()
	let waiting = false
	let messages: RemoteSnapshot['messages'] = []
	let current: RemoteSnapshot['messages'][number] | null = null
	let receipts: RemoteReceipt[] = []
	let timer: ReturnType<typeof setTimeout> | undefined
	let activeRequest: ReturnType<typeof request> | undefined
	let lastEpoch: string | null = null
	let entry = ctx.sessionManager.getLeafId()
	for (let visits = 0; entry && visits < 200 && messages.length < 40; visits++) {
		const value = ctx.sessionManager.getEntry(entry)
		if (!value) break
		if (value.type === 'message') {
			const projected = projectMessage(value.message, value.id)
			if (projected) messages.unshift(projected)
		}
		entry = value.parentId
	}
	historyTruncated = entry !== null

	function publish(value: unknown, key?: string) {
		if (disposed) return
		const projected = projectMessage(value, key ?? randomUUID())
		if (!projected) return
		if (key) current = projected
		else {
			current = null
			messages.push(projected)
			if (messages.length > 40) {
				messages.shift()
				historyTruncated = true
			}
		}
		revision++
	}
	function snapshot(): RemoteSnapshot {
		if (current && messages.length >= 40) historyTruncated = true
		const visible = current ? [...messages, current].slice(-40) : [...messages]
		// Bound wire bytes, including JSON escaping, BEFORE the transport sees them.
		while (visible.length && Buffer.byteLength(JSON.stringify(visible)) > 160 * 1024) {
			visible.shift()
			historyTruncated = true
		}
		return {
			target,
			revision,
			label: (pi.getSessionName() ?? 'Pi session').slice(0, 160),
			workspace: basename(ctx.cwd).slice(0, 160),
			model: ctx.model ? `${ctx.model.provider}/${ctx.model.id}`.slice(0, 160) : null,
			activity: question || waiting ? 'waiting' : ctx.isIdle() ? 'idle' : 'working',
			capabilities: { prompt: !waiting && !question, interrupt: true, answer: question !== null },
			question,
			messages: visible,
			historyTruncated,
		}
	}
	function invoke(command: RemoteCommand): RemoteReceipt['status'] {
		if (command.operation.kind === 'prompt') {
			if (question || waiting) return 'rejected'
			pi.sendUserMessage(command.operation.text, {
				deliverAs: command.operation.delivery,
				expandPromptTemplates: false,
			})
			return 'dispatched' // Pi's public API returns void: NOT an acceptance receipt.
		}
		if (command.operation.kind === 'interrupt') {
			ctx.abort()
			return 'dispatched'
		}
		if (!question || question.requestId !== command.operation.requestId) return 'rejected'
		let status: RemoteReceipt['status'] = 'unknown'
		const remove = pi.events.on(QUESTION_RECEIPT, value => {
			const receipt = value as { commandId?: string; status?: string }
			if (receipt.commandId === command.commandId) status = receipt.status === 'answered' ? 'answered' : 'rejected'
		})
		try {
			pi.events.emit(QUESTION_ANSWER, {
				requestId: question.requestId,
				commandId: command.commandId,
				answers: command.operation.answers,
			})
		} finally {
			remove()
		}
		return status
	}
	async function tick() {
		if (disposed) return
		const sent = receipts
		try {
			const body = JSON.stringify({
				protocol: REMOTE_PROTOCOL,
				enrollmentId: enrollment.enrollmentId,
				snapshot: snapshot(),
				receipts: sent,
			})
			if (Buffer.byteLength(body) > REMOTE_BODY_LIMIT) throw new Error('snapshot_limit')
			const rawResponse = await new Promise<unknown>((resolve, reject) => {
				const req = request(
					{
						socketPath: enrollment.socketPath,
						path: '/exchange',
						method: 'POST',
						headers: {
							Authorization: `Bearer ${enrollment.capability}`,
							'X-Helm-Enrollment': enrollment.enrollmentId,
							'Content-Type': 'application/json',
							'Content-Length': Buffer.byteLength(body),
						},
					},
					res => {
						const chunks: Buffer[] = []
						let size = 0
						res.on('data', (chunk: Buffer) => {
							size += chunk.length
							if (size > REMOTE_BODY_LIMIT) {
								res.destroy()
								req.destroy(new Error('response_limit'))
							} else chunks.push(chunk)
						})
						res.on('error', reject)
						res.on('end', () => {
							if (res.statusCode !== 200) {
								if ([401, 403, 409].includes(res.statusCode ?? 0)) stop()
								reject(new Error('host_refused'))
								return
							}
							try {
								resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')))
							} catch {
								reject(new Error('invalid_response'))
							}
						})
					},
				)
				activeRequest = req
				req.on('error', reject)
				req.setTimeout(2000, () => req.destroy(new Error('timeout')))
				req.end(body)
			})
			if (disposed) return
			const response = remoteHostExchangeSchema.parse(rawResponse)
			// A changed host cannot silently inherit outstanding command authority.
			if (lastEpoch && lastEpoch !== response.hostEpoch) {
				stop()
				return
			}
			lastEpoch = response.hostEpoch
			receipts = receipts.filter(receipt => !sent.includes(receipt))
			for (const { command, expiresAt } of response.commands) {
				if (command.hostEpoch !== lastEpoch) continue
				receipts.push(admission.dispatch(command, () => (Date.now() >= expiresAt ? 'rejected' : invoke(command))))
			}
			receipts = receipts.slice(-32)
		} catch {
			/* A lost host only detaches observation. Never abort Pi or retry its prompts. */
		} finally {
			activeRequest = undefined
			if (!disposed) {
				timer = setTimeout(() => void tick(), 500)
				timer.unref()
			}
		}
	}
	function stop() {
		disposed = true
		admission.dispose()
		clearTimeout(timer)
		activeRequest?.destroy()
		messages = []
		receipts = []
		current = null
		question = null
		questions.clear()
	}
	void tick()
	return {
		stop,
		publish,
		changed: () => {
			if (!disposed) revision++
		},
		setWaiting(value: boolean) {
			if (!disposed) {
				waiting = value
				revision++
			}
		},
		setQuestion(value: unknown, closed = false) {
			if (disposed) return
			if (closed) {
				const id = (value as { requestId?: unknown } | null)?.requestId
				if (typeof id === 'string') questions.delete(id)
			} else {
				const parsed = remoteQuestionSchema.safeParse(value)
				if (parsed.success && questions.size < 8 && Buffer.byteLength(JSON.stringify(parsed.data)) <= 64 * 1024)
					questions.set(parsed.data.requestId, parsed.data)
			}
			question = [...questions.values()].at(-1) ?? null
			revision++
		},
	}
}
