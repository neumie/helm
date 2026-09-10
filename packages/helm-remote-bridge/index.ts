import { randomUUID } from 'node:crypto'
import { request } from 'node:http'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent'
import { RemoteAdmission } from '../../src/remote/admission.js'
import {
	REMOTE_CONVERSATION_RESERVE,
	evictRemoteMessage,
	isRemoteConversationMessage,
	projectRemoteMessage as projectMessage,
	trimRemoteMessages,
} from '../../src/remote/message-projection.js'
import {
	type RemoteEnrollmentFile,
	readRemoteEnrollment,
	readRemoteRegistration,
	remoteEnrollmentFileSchema,
} from '../../src/remote/private-file.js'
import {
	REMOTE_BODY_LIMIT,
	REMOTE_PROTOCOL,
	type RemoteCommand,
	type RemoteReceipt,
	type RemoteSnapshot,
	remoteHostExchangeSchema,
	remoteQuestionSchema,
} from '../../src/remote/protocol.js'
import { TerminalMetadataObserver, createTerminalMetadataReader } from '../../src/remote/terminal-metadata.js'
import {
	QUESTION_ANSWER,
	QUESTION_CLOSED,
	QUESTION_OPEN,
	QUESTION_RECEIPT,
} from '../helm-ask-user-question/remote-answers.js'

// A refusal only, never an authority carrier. Pi replacement reloads extension
// modules/APIs in the same process; keep explicit manual/disconnect policy there
// without placing grants or policy in inheritable environment/session files.
const manualOnlyKey = Symbol.for('helm.remote.manual-only.v1')
const processPolicy = process as typeof process & { [manualOnlyKey]?: boolean }

/**
 * Opt-in TUI adapter. It discovers only the registration-only capability after a
 * real session_start; it never reads the operator control token or connects at
 * extension construction. Native navigation is fail-closed until lifecycle proof.
 */
export default function helmRemoteBridge(pi: ExtensionAPI) {
	type Availability = 'eligible' | 'retrying' | 'connected' | 'navigation-fenced' | 'disabled' | 'disposed'
	const automaticAllowed = process.env.HELM_REMOTE_DISABLE_AUTO !== '1'
	let selectedMode: 'automatic' | 'manual' = processPolicy[manualOnlyKey] ? 'manual' : 'automatic'
	let availability: Availability = 'eligible'
	let runtime: ReturnType<typeof connect> | undefined
	let retryTimer: ReturnType<typeof setTimeout> | undefined
	let current: ExtensionContext | undefined
	let lifecycle = 0
	let observedNavigations = 0
	let observedNavigationKind: 'tree' | 'switch' | 'fork' | undefined
	let registrationAttempt = 0
	let pendingEnrollment: RemoteEnrollmentFile | undefined
	let registrationAbort: AbortController | undefined
	let disposed = false
	// Dialogs belong to this Pi lifecycle, not an exchange connection. Retain no
	// completion callbacks, and cap the whole observation, not each network retry.
	const questions = new Map<string, NonNullable<RemoteSnapshot['question']>>()
	let waiting = false
	const observeAllowed = () => !disposed && current !== undefined && availability !== 'navigation-fenced'
	const clearDialogs = () => {
		questions.clear()
		waiting = false
	}
	const dialogs = () => ({ question: [...questions.values()].at(-1) ?? null, waiting })
	const removeQuestionOpen = pi.events.on(QUESTION_OPEN, value => {
		if (!observeAllowed()) return
		const parsed = remoteQuestionSchema.safeParse(value)
		if (!parsed.success) return
		const next = new Map(questions).set(parsed.data.requestId, parsed.data)
		if (next.size > 8 || Buffer.byteLength(JSON.stringify([...next.values()])) > 64 * 1024) return
		questions.set(parsed.data.requestId, parsed.data)
		runtime?.changed()
	})
	const removeQuestionClosed = pi.events.on(QUESTION_CLOSED, value => {
		if (!observeAllowed()) return
		const id = (value as { requestId?: unknown } | null)?.requestId
		if (typeof id === 'string') questions.delete(id)
		runtime?.changed()
	})

	const clearRuntime = () => {
		runtime?.stop()
		runtime = undefined
	}
	const clearRetry = () => {
		clearTimeout(retryTimer)
		retryTimer = undefined
	}
	const clearRegistration = () => {
		registrationAbort?.abort()
		registrationAbort = undefined
	}
	const disconnect = (disabled = false) => {
		clearRetry()
		clearRegistration()
		clearRuntime()
		pendingEnrollment = undefined
		if (disabled) {
			processPolicy[manualOnlyKey] = true
			selectedMode = 'manual'
			availability = 'disabled'
		}
	}
	const live = (ctx: ExtensionContext, token: number) =>
		!disposed &&
		availability !== 'disabled' &&
		availability !== 'navigation-fenced' &&
		current === ctx &&
		lifecycle === token
	const install = (ctx: ExtensionContext, enrollment: RemoteEnrollmentFile, token: number): boolean => {
		if (!live(ctx, token) || runtime) return false
		const next = connect(
			pi,
			ctx,
			enrollment,
			dialogs,
			(retryEnrollment: RemoteEnrollmentFile | undefined) => {
				if (runtime !== next) return
				runtime = undefined
				if (retryEnrollment) pendingEnrollment = retryEnrollment
				else pendingEnrollment = undefined
				if (live(ctx, token)) {
					registrationAttempt++
					scheduleRegistration(ctx, token)
				}
			},
			() => {
				// Only an observed successful exchange resets retry pressure. Issuing a
				// grant or receiving a 409 owner conflict never starts a new burst.
				if (runtime === next && live(ctx, token)) {
					registrationAttempt = 0
					pendingEnrollment = undefined
				}
			},
			() => runtime === next && live(ctx, token),
		)
		runtime = next
		availability = 'connected'
		return true
	}
	const registrationPath = () => join(homedir(), '.helm', 'remote', 'bridge-registration.json')
	const scheduleRegistration = (ctx: ExtensionContext, token: number) => {
		if (!live(ctx, token) || runtime || registrationAbort) return
		if (!pendingEnrollment && (selectedMode !== 'automatic' || !automaticAllowed || processPolicy[manualOnlyKey]))
			return
		availability = registrationAttempt === 0 ? 'eligible' : 'retrying'
		clearRetry()
		const delay = Math.min(250 * 2 ** Math.min(registrationAttempt, 4), 4_000)
		retryTimer = setTimeout(
			() => {
				if (!live(ctx, token) || runtime || registrationAbort) return
				if (!pendingEnrollment && (selectedMode !== 'automatic' || !automaticAllowed || processPolicy[manualOnlyKey]))
					return
				const controller = new AbortController()
				registrationAbort = controller
				const existing = pendingEnrollment
				const registration = existing
					? Promise.resolve(existing)
					: Promise.resolve().then(() => {
							const discovery = readRemoteRegistration(registrationPath())
							// Authorization scope/generation is host-owned and stable. The local
							// lifecycle token fences this closure only; it is never sent as scope.
							return registerBridge(discovery, ctx.sessionManager.getSessionId(), controller.signal)
						})
				void registration
					.then(enrollment => {
						if (registrationAbort === controller) registrationAbort = undefined
						if (!install(ctx, enrollment, token) && live(ctx, token)) {
							registrationAttempt++
							scheduleRegistration(ctx, token)
						}
					})
					.catch(() => {
						if (registrationAbort === controller) registrationAbort = undefined
						if (live(ctx, token)) {
							registrationAttempt++
							scheduleRegistration(ctx, token)
						}
					})
			},
			registrationAttempt === 0 ? 0 : delay,
		)
		retryTimer.unref()
	}
	const beginLifecycle = (ctx: ExtensionContext) => {
		if (ctx.mode !== 'tui' || process.env.PI_SUBAGENT_CHILD === '1' || disposed) return
		const disabled = availability === 'disabled'
		clearDialogs()
		current = ctx
		const token = ++lifecycle
		observedNavigations = 0
		observedNavigationKind = undefined
		availability = disabled ? 'disabled' : 'eligible'
		clearRetry()
		clearRegistration()
		clearRuntime()
		registrationAttempt = 0
		pendingEnrollment = undefined
		scheduleRegistration(ctx, token)
	}
	const fenceNavigation = (kind: 'tree' | 'switch' | 'fork') => {
		if (disposed) return
		clearDialogs()
		observedNavigations++
		observedNavigationKind = kind
		lifecycle++
		clearRetry()
		clearRegistration()
		clearRuntime()
		availability = 'navigation-fenced'
	}
	const reconnectAfterTree = (ctx: ExtensionContext) => {
		// Tree events carry no operation id. One observed navigation can be matched;
		// overlapping before-hooks remain fenced rather than guessed by UUID/idle time.
		if (availability !== 'navigation-fenced' || observedNavigations !== 1 || observedNavigationKind !== 'tree') return
		beginLifecycle(ctx)
	}
	const enrollManual = (ctx: ExtensionContext, path: string, notify: boolean): boolean => {
		if (
			ctx.mode !== 'tui' ||
			process.env.PI_SUBAGENT_CHILD === '1' ||
			disposed ||
			availability === 'navigation-fenced'
		) {
			if (notify) ctx.ui.notify('Remote remains paused until a fresh Pi lifecycle.', 'warning')
			return false
		}
		try {
			const enrollment = readRemoteEnrollment(path)
			selectedMode = 'manual'
			processPolicy[manualOnlyKey] = true
			current = ctx
			const token = ++lifecycle
			clearRetry()
			clearRegistration()
			clearRuntime()
			availability = 'eligible'
			pendingEnrollment = undefined
			registrationAttempt = 0
			const enrolled = install(ctx, enrollment, token)
			if (notify)
				ctx.ui.notify(
					enrolled ? 'Remote enrollment started. The terminal remains in control.' : 'Remote enrollment refused.',
					enrolled ? 'info' : 'error',
				)
			return enrolled
		} catch {
			if (notify) ctx.ui.notify('Remote enrollment refused. Check the private enrollment file.', 'error')
			return false
		}
	}

	pi.registerCommand('helm-remote-connect', {
		description: 'Explicitly enroll this terminal in the isolated Helm Remote proof host',
		handler: async (path, ctx) => {
			if (ctx.mode !== 'tui' || process.env.PI_SUBAGENT_CHILD === '1') {
				ctx.ui.notify('Remote control is available only for an ordinary TUI session', 'warning')
				return
			}
			if (runtime) {
				ctx.ui.notify('Already enrolled. Disconnect before enrolling again.', 'warning')
				return
			}
			enrollManual(ctx, path.trim(), true)
		},
	})
	pi.registerCommand('helm-remote-disconnect', {
		description: 'Stop Remote access without stopping Pi',
		handler: async (_args, ctx) => {
			disconnect(true)
			ctx.ui.notify('Remote disconnected', 'info')
		},
	})
	// Never connect from the extension factory. session_start is the fresh lifecycle
	// boundary for replacement; normal browser selection never reaches these hooks.
	pi.on('session_start', (_event, ctx) => beginLifecycle(ctx))
	pi.on('session_shutdown', () => {
		disposed = true
		clearDialogs()
		disconnect()
		removeQuestionOpen()
		removeQuestionClosed()
		availability = 'disposed'
	})
	pi.on('session_tree', (_event, ctx) => reconnectAfterTree(ctx))
	pi.on('session_before_switch', () => fenceNavigation('switch'))
	pi.on('session_before_fork', () => fenceNavigation('fork'))
	pi.on('session_before_tree', () => fenceNavigation('tree'))
	pi.on('message_start', event => runtime?.publish(event.message, 'current'))
	pi.on('message_update', event => runtime?.publish(event.message, 'current'))
	pi.on('message_end', event => runtime?.publish(event.message))
	pi.on('agent_start', () => runtime?.changed())
	pi.on('agent_settled', () => runtime?.changed())
	pi.on('model_select', () => runtime?.changed())
	pi.on('ui_prompt_start', () => {
		if (observeAllowed()) {
			waiting = true
			runtime?.changed()
		}
	})
	pi.on('ui_prompt_end', () => {
		if (observeAllowed()) {
			waiting = false
			runtime?.changed()
		}
	})
	// Replacement disposes the outgoing extension/API. Question-bus listeners are
	// explicitly removed at shutdown; each fresh extension registers its own pair.
}

function registerBridge(
	discovery: ReturnType<typeof readRemoteRegistration>,
	sessionId: string,
	signal: AbortSignal,
): Promise<RemoteEnrollmentFile> {
	return new Promise((resolvePromise, reject) => {
		const body = JSON.stringify({ sessionId })
		const req = request(
			{
				socketPath: discovery.socketPath,
				path: '/bridge-register',
				method: 'POST',
				headers: {
					Authorization: `Bearer ${discovery.capability}`,
					'Content-Type': 'application/json',
					'Content-Length': Buffer.byteLength(body),
				},
			},
			response => {
				const parts: Buffer[] = []
				let size = 0
				response.on('data', (part: Buffer) => {
					size += part.length
					if (size > 4096) response.destroy(new Error('registration_response_limit'))
					else parts.push(part)
				})
				response.on('error', reject)
				response.on('end', () => {
					if (response.statusCode !== 201) return reject(new Error('registration_refused'))
					try {
						resolvePromise(remoteEnrollmentFileSchema.parse(JSON.parse(Buffer.concat(parts).toString('utf8'))))
					} catch {
						reject(new Error('invalid_registration'))
					}
				})
			},
		)
		const abort = () => req.destroy(new Error('registration_aborted'))
		if (signal.aborted) return abort()
		signal.addEventListener('abort', abort, { once: true })
		req.on('error', error => {
			signal.removeEventListener('abort', abort)
			reject(error)
		})
		req.setTimeout(2000, () => req.destroy(new Error('registration_timeout')))
		req.end(body)
	})
}

function connect(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	enrollment: RemoteEnrollmentFile,
	dialogs: () => { question: RemoteSnapshot['question']; waiting: boolean },
	onLost?: (retryEnrollment?: RemoteEnrollmentFile) => void,
	onConnected?: () => void,
	dispatchAllowed?: () => boolean,
) {
	const target = {
		sessionId: ctx.sessionManager.getSessionId(),
		incarnation: randomUUID(),
		scopeId: enrollment.scopeId,
		generation: enrollment.generation,
	}
	const admission = new RemoteAdmission(target)
	let disposed = false
	let revision = 0
	const terminalMetadata = new TerminalMetadataObserver(createTerminalMetadataReader(), () => {
		revision++
	})
	let historyTruncated = false
	let messages: RemoteSnapshot['messages'] = []
	let current: RemoteSnapshot['messages'][number] | null = null
	let receipts: RemoteReceipt[] = []
	let timer: ReturnType<typeof setTimeout> | undefined
	let activeRequest: ReturnType<typeof request> | undefined
	let lastEpoch: string | null = null
	let exchangeObserved = false
	let entry = ctx.sessionManager.getLeafId()
	for (
		let visits = 0;
		entry &&
		visits < 200 &&
		(messages.length < 40 || messages.filter(isRemoteConversationMessage).length < REMOTE_CONVERSATION_RESERVE);
		visits++
	) {
		const value = ctx.sessionManager.getEntry(entry)
		if (!value) break
		if (value.type === 'message') {
			const projected = projectMessage(value.message, value.id)
			if (projected) {
				messages.unshift(projected)
				historyTruncated = trimRemoteMessages(messages) || historyTruncated
			}
		}
		entry = value.parentId
	}
	historyTruncated ||= entry !== null

	function publish(value: unknown, key?: string) {
		if (disposed) return
		const projected = projectMessage(value, key ?? randomUUID())
		if (!projected) return
		if (key) current = projected
		else {
			current = null
			messages.push(projected)
			historyTruncated = trimRemoteMessages(messages) || historyTruncated
		}
		revision++
	}
	function snapshot(): RemoteSnapshot {
		const { question, waiting } = dialogs()
		const visible = current ? [...messages, current] : [...messages]
		historyTruncated = trimRemoteMessages(visible) || historyTruncated
		// Bound wire bytes, including JSON escaping, BEFORE the transport sees them.
		while (visible.length && Buffer.byteLength(JSON.stringify(visible)) > 160 * 1024) {
			evictRemoteMessage(visible)
			historyTruncated = true
		}
		return {
			target,
			revision,
			label: (pi.getSessionName() ?? 'Pi session').slice(0, 160),
			workspace: basename(ctx.cwd).slice(0, 160),
			...(terminalMetadata.value ? { terminal: terminalMetadata.value } : {}),
			model: ctx.model ? `${ctx.model.provider}/${ctx.model.id}`.slice(0, 160) : null,
			activity: question || waiting ? 'waiting' : ctx.isIdle() ? 'idle' : 'working',
			capabilities: { prompt: !waiting && !question, interrupt: true, answer: question !== null },
			question,
			messages: visible,
			historyTruncated,
		}
	}
	function invoke(command: RemoteCommand): RemoteReceipt['status'] {
		const { question, waiting } = dialogs()
		// This is intentionally immediately adjacent to the synchronous Pi call.
		// Re-read Pi's guarded current manager here; no cached manager can survive a
		// replacement or tree mutation and invoke the wrong owner.
		try {
			if (!dispatchAllowed?.() || ctx.sessionManager.getSessionId() !== target.sessionId) return 'rejected'
		} catch {
			return 'rejected'
		}
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
		terminalMetadata.refresh()
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
								// A fresh owner can conflict while its old owner is still live. The
								// unused grant remains valid, so back off and retry it rather than
								// minting the registration allowance in a tight 409 loop.
								if (res.statusCode === 409) lost(enrollment)
								else if ([401, 403].includes(res.statusCode ?? 0)) lost()
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
				lost()
				return
			}
			lastEpoch = response.hostEpoch
			if (!exchangeObserved) {
				exchangeObserved = true
				onConnected?.()
			}
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
	function lost(retryEnrollment?: RemoteEnrollmentFile) {
		if (disposed) return
		stop()
		onLost?.(retryEnrollment)
	}
	function stop() {
		disposed = true
		terminalMetadata.stop()
		admission.dispose()
		clearTimeout(timer)
		activeRequest?.destroy()
		messages = []
		receipts = []
		current = null
	}
	void tick()
	return {
		stop,
		publish,
		changed: () => {
			if (!disposed) revision++
		},
	}
}
