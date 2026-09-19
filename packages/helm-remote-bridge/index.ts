import { randomUUID } from 'node:crypto'
import { request } from 'node:http'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent'
import { RemoteAdmission } from '../../src/remote/admission.js'
import {
	HISTORY_HEADER,
	HISTORY_RESULT_BYTES,
	type HistoryResult,
	remoteHistoryExchangeSchema,
} from '../../src/remote/history-protocol.js'
import { RemoteHistoryReader } from '../../src/remote/history-reader.js'
import { RemoteImageInputClient, type RemotePreparedImage } from '../../src/remote/image-input-client.js'
import { IMAGE_INPUT_HEADER, IMAGE_INPUT_VERSION } from '../../src/remote/image-input-protocol.js'
import { RemoteInformationClient } from '../../src/remote/information-client.js'
import { INFORMATION_HEADER } from '../../src/remote/information-protocol.js'
import { RemoteInformationPublisher } from '../../src/remote/information-transport.js'
import { RemoteLiveMessageObservation } from '../../src/remote/live-messages.js'
import {
	type RemoteEnrollmentFile,
	readRemoteEnrollment,
	readRemoteRegistration,
	remoteEnrollmentFileSchema,
} from '../../src/remote/private-file.js'
import {
	REMOTE_BODY_LIMIT,
	REMOTE_MAX_MODELS,
	REMOTE_PROTOCOL,
	type RemoteCommand,
	type RemoteModel,
	type RemoteReceipt,
	type RemoteSnapshot,
	remoteQuestionSchema,
} from '../../src/remote/protocol.js'
import { RemoteSubagentActivityClient } from '../../src/remote/subagent-activity-client.js'
import type { RemoteSubagentActivity } from '../../src/remote/subagent-activity-protocol.js'
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
	let information: RemoteInformationClient | undefined
	let activity: RemoteSubagentActivityClient | undefined
	let informationLifecycle = 0
	const clearInformation = () => {
		informationLifecycle++
		information?.dispose()
		information = undefined
	}
	const clearActivity = () => {
		activity?.dispose()
		activity = undefined
	}
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
		const sessionId = ctx.sessionManager.getSessionId()
		const next = connect(
			pi,
			ctx,
			enrollment,
			dialogs,
			() => information?.read() ?? null,
			() =>
				activity?.read().activity ??
				({ availability: 'unavailable', coverage: 'unavailable', active: null } as RemoteSubagentActivity),
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
		let accepted = false
		try {
			accepted = live(ctx, token) && ctx.sessionManager.getSessionId() === sessionId
		} catch {
			// A manager that became unavailable during setup cannot own this runtime.
		}
		if (!accepted) {
			next.stop()
			return false
		}
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
		clearInformation()
		clearActivity()
		current = ctx
		availability = disabled ? 'disabled' : 'eligible'
		const token = ++lifecycle
		observedNavigations = 0
		observedNavigationKind = undefined
		clearRetry()
		clearRegistration()
		clearRuntime()
		registrationAttempt = 0
		pendingEnrollment = undefined
		const informationToken = informationLifecycle
		const sessionId = ctx.sessionManager.getSessionId()
		const nextInformation = new RemoteInformationClient(
			pi.events,
			sessionId,
			sessionId =>
				!disposed &&
				informationToken === informationLifecycle &&
				availability !== 'navigation-fenced' &&
				ctx.sessionManager.getSessionId() === sessionId,
		)
		// Event-bus discovery invokes producer code synchronously. It may invalidate
		// this lifecycle before construction returns; never restore that admission.
		if (disposed || informationToken !== informationLifecycle) {
			nextInformation.dispose()
			return
		}
		information = nextInformation
		const nextActivity = new RemoteSubagentActivityClient(
			pi.events,
			sessionId,
			() =>
				!disposed &&
				informationToken === informationLifecycle &&
				availability !== 'navigation-fenced' &&
				current === ctx &&
				ctx.sessionManager.getSessionId() === sessionId,
		)
		if (disposed || informationToken !== informationLifecycle) {
			nextActivity.dispose()
			return
		}
		activity = nextActivity
		scheduleRegistration(ctx, token)
	}
	const fenceNavigation = (kind: 'tree' | 'switch' | 'fork') => {
		if (disposed) return
		clearInformation()
		clearActivity()
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
		clearInformation()
		clearActivity()
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
	pi.on('model_select', event => runtime?.modelChanged(event.model.input.includes('image')))
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
	readInformation: RemoteInformationClient['read'],
	readActivity: () => RemoteSubagentActivity,
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
	let receipts: RemoteReceipt[] = []
	let timer: ReturnType<typeof setTimeout> | undefined
	let activeRequest: ReturnType<typeof request> | undefined
	let lastEpoch: string | null = null
	let featureSupported = false
	let imageNegotiated = false
	let modelCapable = ctx.model?.input.includes('image') ?? false
	let modelLoss: symbol | undefined
	let activityContent = ''
	let activityRevision = 0
	let exchangeObserved = false
	let history: RemoteHistoryReader | undefined
	let historySending = false
	const historyAbort = new AbortController()
	const currentManager = () => {
		try {
			return !disposed && dispatchAllowed?.() && ctx.sessionManager.getSessionId() === target.sessionId
				? ctx.sessionManager
				: null
		} catch {
			return null
		}
	}
	const informationPublisher = new RemoteInformationPublisher(
		enrollment,
		target,
		readInformation,
		() => !!currentManager(),
	)
	const observation = new RemoteLiveMessageObservation(currentManager)
	const recordReceipt = (receipt: RemoteReceipt) => {
		const index = receipts.findIndex(item => item.commandId === receipt.commandId)
		if (index >= 0) receipts[index] = receipt
		else receipts.push(receipt)
		receipts = receipts.slice(-32)
	}
	const imageClient = new RemoteImageInputClient(enrollment, target, admission, {
		current: (hostEpoch, _generation, images) => {
			if (disposed || lastEpoch !== hostEpoch || !currentManager()) return false
			if (!images) return true
			observeModel()
			const { question, waiting } = dialogs()
			return imageNegotiated && modelCapable && !modelLoss && !question && !waiting
		},
		invoke: (command, images) => invoke(command, images),
		receipt: recordReceipt,
	})
	function publish(value: unknown, key?: string) {
		if (!disposed) observation.publish(value, key !== undefined)
	}
	/**
	 * Models Pi can actually reach: getAvailable() is the catalogue filtered by
	 * configured auth, so a choice here is one setModel can honour. The session's own
	 * scoped list is preferred when it has entries, because a scoped session should not
	 * be offered models outside its scope; it is frequently empty, which is not the same
	 * as offering nothing. Bounded so a long catalogue cannot inflate every snapshot.
	 */
	function selectableModels(): RemoteModel[] {
		const scoped = (ctx.scopedModels ?? []).map(entry => entry.model)
		const available = scoped.length ? scoped : (ctx.modelRegistry?.getAvailable() ?? [])
		return available.slice(0, REMOTE_MAX_MODELS).map(model => ({
			provider: model.provider,
			id: model.id,
			label: (model.name || model.id).slice(0, 96),
			image: model.input.includes('image'),
		}))
	}
	function observeModel(capable = ctx.model?.input.includes('image') ?? false): void {
		if (modelCapable && !capable) {
			modelLoss = Symbol()
			imageClient.rotateSupport()
		}
		if (modelCapable !== capable) revision++
		modelCapable = capable
	}
	function snapshot(): RemoteSnapshot {
		observeModel()
		const models = selectableModels()
		const observed = observation.snapshot()
		const sourceActivity = readActivity()
		const nextActivityContent = JSON.stringify(featureSupported ? sourceActivity : null)
		if (nextActivityContent !== activityContent) {
			activityContent = nextActivityContent
			activityRevision++
		}
		const { question, waiting } = dialogs()
		return {
			target,
			revision: revision + observation.revision + activityRevision,
			label: (pi.getSessionName() ?? 'Pi session').slice(0, 160),
			workspace: basename(ctx.cwd).slice(0, 160),
			...(terminalMetadata.value ? { terminal: terminalMetadata.value } : {}),
			model: ctx.model ? `${ctx.model.provider}/${ctx.model.id}`.slice(0, 160) : null,
			// Always present from this bridge, even when empty: an omitted list means "this
			// bridge cannot offer models", and an empty one means "it offers none". Collapsing
			// those made a reloaded bridge look exactly like one that never reloaded.
			models,
			...(imageNegotiated
				? { imageInput: { version: IMAGE_INPUT_VERSION, available: modelCapable && !modelLoss } }
				: {}),
			activity: question || waiting ? 'waiting' : ctx.isIdle() ? 'idle' : 'working',
			...(featureSupported ? { subagents: sourceActivity } : {}),
			capabilities: { prompt: !waiting && !question, interrupt: true, answer: question !== null },
			question,
			...observed,
		}
	}
	function invoke(
		command: Readonly<RemoteCommand>,
		preparedImages: readonly RemotePreparedImage[] = [],
	): RemoteReceipt['status'] {
		// This is intentionally immediately adjacent to the synchronous Pi call.
		// Re-read Pi's guarded current manager here; no cached manager can survive a
		// replacement or tree mutation and invoke the wrong owner.
		if (!currentManager()) return 'rejected'
		if (command.operation.kind === 'prompt') {
			const imageCount = command.operation.images?.length ?? 0
			if (imageCount) {
				observeModel()
				if (!modelCapable || modelLoss) return 'rejected'
			}
			const { question, waiting } = dialogs()
			if (!currentManager() || question || waiting) return 'rejected'
			if (imageCount !== preparedImages.length) return 'rejected'
			const content = [
				...(command.operation.text ? [{ type: 'text' as const, text: command.operation.text }] : []),
				...preparedImages,
			]
			pi.sendUserMessage(preparedImages.length ? content : command.operation.text, {
				deliverAs: command.operation.delivery,
				expandPromptTemplates: false,
			})
			return 'dispatched' // Pi's public API returns void: NOT an acceptance receipt.
		}
		if (command.operation.kind === 'interrupt') {
			imageClient.cancelUninvoked()
			ctx.abort()
			return 'dispatched'
		}
		if (command.operation.kind === 'model') {
			const selection = command.operation
			// Only a model Pi itself offers is ever applied; the request names one, it does
			// not supply one.
			const offered = selectableModels().some(
				value => value.provider === selection.provider && value.id === selection.id,
			)
			const scoped = offered ? ctx.modelRegistry?.find(selection.provider, selection.id) : undefined
			if (!scoped) return 'rejected'
			// This call is asynchronous while invoke must stay synchronous, so the answer
			// arrives as a corrected receipt: false means Pi holds no key for that model,
			// which is a refusal the reader has to be told about.
			void pi
				.setModel(scoped)
				.then(applied => {
					if (disposed) return
					if (!applied) recordReceipt({ commandId: command.commandId, status: 'rejected' })
					// Image support belongs to the model, so observe the new one at once
					// rather than waiting for the next poll to notice.
					else observeModel()
				})
				.catch(() => {
					if (!disposed) recordReceipt({ commandId: command.commandId, status: 'rejected' })
				})
			return 'dispatched' // Handed to Pi, which is not the same as accepted.
		}
		const { question } = dialogs()
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
		// Freeze exactly the receipt object identities serialized by this request.
		// Async image settlement may replace or append receipts while the response is
		// outstanding; those newer objects must survive acknowledgement of this batch.
		const sent = receipts.slice()
		try {
			const currentSnapshot = snapshot()
			const unavailableWitness = currentSnapshot.imageInput?.available === false && modelLoss ? modelLoss : undefined
			// Producer reads are synchronous but owner-controlled. A navigation or
			// replacement can invalidate the observation during that read; do not send
			// a snapshot or receipts captured from the outgoing owner.
			if (!currentManager()) return
			const body = JSON.stringify({
				protocol: REMOTE_PROTOCOL,
				enrollmentId: enrollment.enrollmentId,
				snapshot: currentSnapshot,
				receipts: sent,
			})
			if (Buffer.byteLength(body) > REMOTE_BODY_LIMIT) throw new Error('snapshot_limit')
			const rawResponse = await new Promise<{
				body: unknown
				information: boolean
				activity: boolean
				image: boolean
			}>((resolve, reject) => {
				const req = request(
					{
						socketPath: enrollment.socketPath,
						path: '/exchange',
						method: 'POST',
						headers: {
							Authorization: `Bearer ${enrollment.capability}`,
							'X-Helm-Enrollment': enrollment.enrollmentId,
							[HISTORY_HEADER]: '1',
							[INFORMATION_HEADER]: '1',
							[IMAGE_INPUT_HEADER]: '1',
							'X-Helm-Subagent-Activity': '1',
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
								resolve({
									body: JSON.parse(Buffer.concat(chunks).toString('utf8')),
									information: res.headers[INFORMATION_HEADER.toLowerCase()] === '1',
									activity: res.headers['x-helm-subagent-activity'] === '1',
									image: res.headers[IMAGE_INPUT_HEADER.toLowerCase()] === '1',
								})
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
			const response = remoteHistoryExchangeSchema.parse(rawResponse.body)
			// A changed host cannot silently inherit outstanding command authority.
			if (lastEpoch && lastEpoch !== response.hostEpoch) {
				lost()
				return
			}
			lastEpoch = response.hostEpoch
			imageNegotiated = rawResponse.image
			imageClient.negotiate(lastEpoch, imageNegotiated)
			if (unavailableWitness && modelLoss === unavailableWitness && imageNegotiated && currentManager())
				modelLoss = undefined
			featureSupported = rawResponse.activity
			informationPublisher.negotiate(lastEpoch, rawResponse.information)
			informationPublisher.publish()
			if (response.historyRead && !historySending && currentManager()) {
				history ??= new RemoteHistoryReader(target, lastEpoch, currentManager)
				const result = history.execute(response.historyRead)
				historySending = true
				// Separate bounded result transport never delays the live exchange loop.
				void postHistoryResult(enrollment, result, historyAbort.signal)
					.catch(() => {})
					.finally(() => {
						historySending = false
					})
			}
			if (!exchangeObserved) {
				exchangeObserved = true
				onConnected?.()
			}
			receipts = receipts.filter(receipt => !sent.includes(receipt))
			for (const { command, expiresAt } of response.commands) {
				if (command.hostEpoch !== lastEpoch) continue
				if (command.operation.kind === 'prompt') recordReceipt(imageClient.submit(command, expiresAt))
				else recordReceipt(admission.dispatch(command, () => (Date.now() >= expiresAt ? 'rejected' : invoke(command))))
			}
		} catch {
			featureSupported = false
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
		historyAbort.abort()
		informationPublisher.dispose()
		history?.dispose()
		terminalMetadata.stop()
		imageClient.dispose()
		admission.dispose()
		clearTimeout(timer)
		activeRequest?.destroy()
		receipts = []
		observation.dispose()
	}
	queueMicrotask(() => void tick())
	return {
		stop,
		publish,
		changed: () => {
			if (!disposed) revision++
		},
		modelChanged: (capable: boolean) => {
			if (!disposed) observeModel(capable)
		},
	}
}

/** History uses the existing UDS but its own body/response caps and cancellation. */
function postHistoryResult(
	enrollment: RemoteEnrollmentFile,
	result: HistoryResult,
	signal: AbortSignal,
): Promise<void> {
	const body = JSON.stringify(result)
	if (Buffer.byteLength(body) > HISTORY_RESULT_BYTES) return Promise.reject(new Error('history_result_limit'))
	return new Promise((resolve, reject) => {
		const req = request(
			{
				socketPath: enrollment.socketPath,
				path: '/history-result',
				method: 'POST',
				signal,
				headers: {
					Authorization: `Bearer ${enrollment.capability}`,
					'X-Helm-Enrollment': enrollment.enrollmentId,
					'Content-Type': 'application/json',
					'Content-Length': Buffer.byteLength(body),
				},
			},
			res => {
				let bytes = 0
				res.on('data', (chunk: Buffer) => {
					bytes += chunk.length
					if (bytes > 4096) res.destroy(new Error('history_ack_limit'))
				})
				res.on('error', reject)
				res.on('aborted', () => reject(new Error('history_ack_aborted')))
				res.on('end', () =>
					res.complete && res.statusCode === 200 ? resolve() : reject(new Error('history_ack_refused')),
				)
			},
		)
		req.on('error', reject)
		req.setTimeout(2000, () => req.destroy(new Error('history_result_timeout')))
		req.end(body)
	})
}
