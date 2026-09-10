import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type {
	RemoteCommand,
	RemoteDirectory,
	RemoteReceipt,
	RemoteSnapshot,
	RemoteSummary,
} from '../../../../src/remote/protocol.js'
import { REMOTE_PROTOCOL, sameRemoteTarget } from '../../../../src/remote/protocol.js'
import { Btn } from '../button.js'
import { GLYPH, IconBtn, MenuButton } from '../sidebar/ui.js'
import { RemoteArrow } from './RemoteArrow.js'
import { RemoteDisclosure } from './RemoteDisclosure.js'
import { RemoteMarkdown } from './RemoteMarkdown.js'
import { pruneAbsentRemoteDrafts, remoteSessionIdentity } from './remote-identity.js'
import {
	reuseRemoteMessages,
	sameRemoteDetail,
	sameRemoteDirectory,
	sameRemoteQuestion,
} from './remote-poll-equality.js'
import {
	RemoteSessionInfo,
	describeRemoteSession,
	remoteSessionSearchText,
	remoteSessionStatus,
} from './remote-session-presentation.js'
import { RemoteAccessError, type RemoteTransport } from './transport.js'
import { useRemotePoll } from './use-poll.js'
import './remote.css'

type Operation = { command: RemoteCommand; status: RemoteReceipt['status'] | 'sending' }
type Answer = Extract<RemoteCommand['operation'], { kind: 'answer' }>['answers'][number]
type AnswerDraft = Array<Answer | null>
const MAX_QUESTION_DRAFTS = 8
interface Reading {
	following: boolean
	top: number
	anchor?: string
	offset?: number
}
interface Draft {
	text: string
	delivery: 'steer' | 'followUp'
	reading: Reading
	/** Memory-only drafts are scoped by this conversation's complete identity and request id. */
	questionAnswers: Map<string, AnswerDraft>
	operation?: Operation
}
const newDraft = (): Draft => ({
	text: '',
	delivery: 'steer',
	reading: { following: true, top: 0 },
	questionAnswers: new Map(),
})
type TranscriptMessage = RemoteSnapshot['messages'][number]
const EMPTY_MESSAGES: TranscriptMessage[] = []
const REMOTE_HISTORY_KEY = '__helmRemoteConversation'
const READING_KEY_TEXT_MAX = 160

/**
 * Keep the reading-effect dependency primitive and bounded. Remote presentation
 * fields are wire-bounded, but capping each field also keeps this key cheap if a
 * fixture or future adapter bypasses the protocol parser.
 */
function remoteReadingLayoutKey(values: Array<string | null | undefined>): string {
	return values.map(value => value?.slice(0, READING_KEY_TEXT_MAX) ?? '').join('\u001f')
}

function useStableMessages(messages: TranscriptMessage[] | undefined) {
	const previous = useRef<TranscriptMessage[] | undefined>(undefined)
	const stable = reuseRemoteMessages(previous.current, messages)
	previous.current = stable
	return stable
}

function useStableQuestion(question: RemoteSnapshot['question'] | undefined) {
	const previous = useRef<RemoteSnapshot['question'] | undefined>(undefined)
	if (question === undefined || question === null) {
		previous.current = question
		return question
	}
	if (previous.current && sameRemoteQuestion(previous.current, question)) return previous.current
	previous.current = question
	return question
}

const RECEIPT_COPY: Record<Operation['status'], string> = {
	sending: 'Sending…',
	pending: 'Host acknowledged. Waiting for Pi.',
	dispatched: 'Dispatched to Pi. The conversation confirms what happened.',
	answered: 'Answer submitted.',
	rejected: 'Not sent. Check the current session before trying again.',
	unknown: 'Delivery unknown. Check status and the conversation before sending again.',
}

export function RemoteWorkspace({ transport, onReconnect }: { transport: RemoteTransport; onReconnect?: () => void }) {
	const read = useCallback((signal: AbortSignal) => transport.directory(signal), [transport])
	const directory = useRemotePoll(read, 2000, { equal: sameRemoteDirectory })
	if (directory.error === 401)
		return (
			<main className="remote-empty">
				<h1>Access ended</h1>
				<p>This device no longer has access. Local Pi sessions keep running.</p>
				{onReconnect && <Btn onClick={onReconnect}>Pair again</Btn>}
			</main>
		)
	if (!directory.value)
		return (
			<main className="remote-empty">
				<h1>{directory.error === null ? 'Connecting to Helm Remote' : 'Host unavailable'}</h1>
				<p>
					{directory.error === null
						? 'Loading authorized sessions.'
						: 'Check the local host. Retrying without sending commands.'}
				</p>
			</main>
		)
	return <Workspace transport={transport} directory={directory.value} available={directory.error === null} />
}

function Workspace({
	transport,
	directory,
	available,
}: { transport: RemoteTransport; directory: RemoteDirectory; available: boolean }) {
	const identity = (session: RemoteSummary) => remoteSessionIdentity(directory.hostEpoch, session.target)
	const [selected, setSelected] = useState<string | null>(null)
	const selectedRef = useRef<string | null>(null)
	selectedRef.current = selected
	const [query, setQuery] = useState('')
	const [scope, setScope] = useState('all')
	const drafts = useRef(new Map<string, Draft>())
	const publishedDirectory = useRef<RemoteDirectory | null>(null)
	const directoryRef = useRef<HTMLElement>(null)
	const directoryBody = useRef<HTMLDivElement>(null)
	const directoryHeading = useRef<HTMLHeadingElement>(null)
	const historyOwner = useRef(`remote-${crypto.randomUUID()}`).current
	const historyOwned = useRef(false)
	const historySelection = useRef<string | null>(null)
	const backPending = useRef(false)
	const [announcement, setAnnouncement] = useState('')
	const session = directory.sessions.find(value => identity(value) === selected)
	const directoryStateRef = useRef(directory)
	directoryStateRef.current = directory
	const selectedDraft = selected ? drafts.current.get(selected) : undefined
	useEffect(() => {
		if (!available || publishedDirectory.current === directory) return
		publishedDirectory.current = directory
		pruneAbsentRemoteDrafts(drafts.current, directory)
	}, [available, directory])
	useEffect(() => {
		function onPopState(event: PopStateEvent) {
			backPending.current = false
			if (event.state?.[REMOTE_HISTORY_KEY] === historyOwner) {
				const current = directoryStateRef.current
				const key = historySelection.current
				const present =
					key &&
					current.sessions.some(
						value =>
							`${current.hostEpoch}:${value.target.scopeId ?? 'personal'}:${value.target.generation}:${value.target.sessionId}:${value.target.incarnation}` ===
							key,
					)
				if (present) {
					historyOwned.current = true
					selectedRef.current = key
					setSelected(key)
				} else {
					// Forward is explicit navigation, never authority to adopt a replacement owner.
					const state = { ...history.state }
					delete state[REMOTE_HISTORY_KEY]
					history.replaceState(state, '', window.location.href)
					historyOwned.current = false
					historySelection.current = null
					selectedRef.current = null
					setSelected(null)
				}
				return
			}
			if (!historyOwned.current) return
			const prior = selectedRef.current
			historyOwned.current = false
			selectedRef.current = null
			setSelected(null)
			setAnnouncement('Session list.')
			requestAnimationFrame(() => {
				if (prior) directoryRef.current?.querySelector<HTMLButtonElement>(`[data-session-key="${prior}"]`)?.focus()
				else directoryHeading.current?.focus()
			})
		}
		window.addEventListener('popstate', onPopState)
		return () => window.removeEventListener('popstate', onPopState)
	}, [historyOwner])
	useEffect(() => {
		if (!selected || session) return
		const prior = selected
		// A published directory is the evidence boundary. Never infer owner settlement from time.
		drafts.current.delete(prior)
		historySelection.current = null
		selectedRef.current = null
		setSelected(null)
		if (historyOwned.current) {
			const state = history.state
			if (state && typeof state === 'object' && state[REMOTE_HISTORY_KEY] === historyOwner) {
				const next = { ...state }
				delete next[REMOTE_HISTORY_KEY]
				history.replaceState(next, '', window.location.href)
			}
			historyOwned.current = false
		}
		setAnnouncement('The selected session changed owners. Choose it again from Live sessions.')
		requestAnimationFrame(() => directoryHeading.current?.focus())
	}, [historyOwner, selected, session])
	useEffect(() => {
		function onKeyDown(event: KeyboardEvent) {
			if (event.key !== 'Escape' || event.defaultPrevented || !selectedRef.current) return
			const target = event.target
			if (
				target instanceof HTMLElement &&
				(target.matches('input, textarea, select, button, [contenteditable="true"]') ||
					target.closest('[role="dialog"]'))
			)
				return
			event.preventDefault()
			back()
		}
		window.addEventListener('keydown', onKeyDown)
		return () => window.removeEventListener('keydown', onKeyDown)
	}, [])
	const scopes = [...new Set(directory.sessions.map(value => value.target.scopeId ?? 'personal'))]
	const visible = directory.sessions.filter(value => {
		const matchesScope = scope === 'all' || scope === (value.target.scopeId ?? 'personal')
		return matchesScope && remoteSessionSearchText(value).toLowerCase().includes(query.toLowerCase())
	})
	function select(value: RemoteSummary) {
		const key = identity(value)
		if (!drafts.current.has(key)) drafts.current.set(key, newDraft())
		if (!selectedRef.current && !historyOwned.current) {
			try {
				history.pushState({ ...(history.state ?? {}), [REMOTE_HISTORY_KEY]: historyOwner }, '', window.location.href)
				historyOwned.current = true
			} catch {
				// A host-controlled history state must never prevent a conversation from opening.
				historyOwned.current = false
			}
		}
		historySelection.current = key
		selectedRef.current = key
		setAnnouncement('')
		setSelected(key)
	}
	function back() {
		const prior = selectedRef.current
		if (!prior || backPending.current) return
		if (historyOwned.current) {
			backPending.current = true
			history.back()
			return
		}
		setSelected(null)
		setAnnouncement('Session list.')
		requestAnimationFrame(() =>
			directoryRef.current?.querySelector<HTMLButtonElement>(`[data-session-key="${prior}"]`)?.focus(),
		)
	}
	return (
		<main className="remote-workspace" data-open={!!session}>
			<aside ref={directoryRef} className="remote-directory" aria-label="Session directory">
				<div ref={directoryBody} className="remote-directory-body">
					<div className="remote-filters">
						<label className="sr-only" htmlFor="remote-search">
							Search live conversations
						</label>
						<input
							id="remote-search"
							type="search"
							placeholder="Search live conversations"
							value={query}
							onChange={event => {
								setQuery(event.target.value)
							}}
						/>
						{(scopes.length > 1 || scope !== 'all') && (
							<label className="remote-scope-filter" htmlFor="remote-scope">
								<span>Live session scope</span>
								<select id="remote-scope" value={scope} onChange={event => setScope(event.target.value)}>
									<option value="all">All authorized scopes</option>
									{scopes.map(id => (
										<option key={id} value={id}>
											{id === 'personal' ? 'Personal' : `Profile ${id.slice(0, 8)}`}
										</option>
									))}
								</select>
							</label>
						)}
					</div>
					<div>
						{!available && (
							<output className="remote-notice">
								Disconnected — showing last known sessions. No commands will be sent.
							</output>
						)}
						<h2 ref={directoryHeading} className="remote-section-heading" tabIndex={-1}>
							Live sessions
						</h2>
						<nav className="remote-session-list" aria-label="Live sessions">
							{visible.map(value => (
								<button
									key={identity(value)}
									type="button"
									className="remote-session-row"
									data-session-key={identity(value)}
									aria-current={selected === identity(value) ? 'page' : undefined}
									onClick={() => select(value)}
								>
									<RemoteSessionInfo
										session={value}
										status={remoteSessionStatus(value.activity, available && value.connected)}
										variant="row"
									/>
								</button>
							))}
							{visible.length === 0 && (
								<p className="remote-note">No matching live sessions. Clear the filter or enroll a terminal locally.</p>
							)}
						</nav>
					</div>
					<p className="sr-only" aria-live="polite">
						{announcement}
					</p>
				</div>
			</aside>
			{session && selectedDraft ? (
				<Conversation
					key={identity(session)}
					transport={transport}
					session={session}
					hostEpoch={directory.hostEpoch}
					available={available}
					draft={selectedDraft}
					onBack={back}
				/>
			) : (
				<section className="remote-empty remote-unselected">
					<h2>Choose a session</h2>
					<p>Read and control the same Pi conversation without restarting its terminal.</p>
				</section>
			)}
		</main>
	)
}

function defaultQuestionAnswers(question: NonNullable<RemoteSnapshot['question']>): AnswerDraft {
	return question.questions.map(value => (value.multiSelect ? { options: [] } : null))
}

function questionAnswersComplete(question: NonNullable<RemoteSnapshot['question']>, answers: AnswerDraft): boolean {
	return question.questions.every((_value, index) => {
		const answer = answers[index]
		if (!answer) return false
		if ('text' in answer) return answer.text.trim().length > 0
		return true
	})
}

function Conversation({
	transport,
	session,
	hostEpoch,
	available,
	draft,
	onBack,
}: {
	transport: RemoteTransport
	session: RemoteSummary
	hostEpoch: string
	available: boolean
	draft: Draft
	onBack: () => void
}) {
	const [, redraw] = useState(0)
	const read = useCallback(
		(signal: AbortSignal) => transport.detail(session.target.sessionId, signal),
		[transport, session.target.sessionId],
	)
	const detail = useRemotePoll(read, 1000, { equal: sameRemoteDetail })
	const view = detail.value?.snapshot
	const question = useStableQuestion(view?.question)
	const messages = useStableMessages(view?.messages)
	const [gap, setGap] = useState(false)
	const [questionJump, setQuestionJump] = useState(false)
	const [promptExpanded, setPromptExpanded] = useState(false)
	const [showActivity, setShowActivity] = useState(false)
	const [following, setFollowing] = useState(() => draft.reading.following)
	const followingRef = useRef(following)
	const scroll = useRef<HTMLDivElement>(null)
	const prompt = useRef<HTMLTextAreaElement>(null)
	const questionRegion = useRef<HTMLDivElement>(null)
	const heading = useRef<HTMLHeadingElement>(null)
	const lifecycle = useRef<AbortController | null>(null)
	const restored = useRef(false)
	const observedQuestion = useRef<string | null>(null)
	const publishFollowing = useCallback((value: boolean) => {
		if (followingRef.current === value) return
		followingRef.current = value
		setFollowing(value)
	}, [])
	const refresh = useCallback(() => redraw(value => value + 1), [])
	const operation = draft.operation
	const answerAwaitingObservation =
		operation?.status === 'answered' &&
		operation.command.operation.kind === 'answer' &&
		question?.requestId === operation.command.operation.requestId
	const unresolved =
		(operation && ['sending', 'pending', 'unknown'].includes(operation.status)) || answerAwaitingObservation
	const connected =
		available &&
		detail.error === null &&
		view?.connected &&
		detail.value?.hostEpoch === hostEpoch &&
		sameRemoteTarget(view.target, session.target)
	const sessionStatus = remoteSessionStatus(view?.activity ?? session.activity, !!(view && connected))
	const sessionPresentation = describeRemoteSession(session)
	const detailModel = (view?.model ?? session.model ?? 'Model unknown').trim()
	const defaultAnswers = useMemo<AnswerDraft>(() => (question ? defaultQuestionAnswers(question) : []), [question])
	const questionAnswers = question ? (draft.questionAnswers.get(question.requestId) ?? defaultAnswers) : undefined
	const answersComplete = !!question && !!questionAnswers && questionAnswersComplete(question, questionAnswers)
	const capabilityMessage =
		connected && question && !view?.capabilities.answer
			? 'Answering is read-only for this device.'
			: connected && !question && !view?.capabilities.prompt
				? 'Sending messages is read-only for this device.'
				: null
	const terminalDialogNotice = view?.activity === 'waiting' && !view.question
	const readingLayoutKey = remoteReadingLayoutKey([
		connected ? 'connected' : 'disconnected',
		gap ? 'gap' : '',
		view?.historyTruncated && connected && !gap ? 'history-truncated' : '',
		capabilityMessage,
		terminalDialogNotice ? 'terminal-dialog' : '',
		operation?.status ?? '',
		sessionPresentation.title,
		sessionPresentation.source,
		...sessionPresentation.facts.flatMap(fact => [fact.label, fact.value]),
		sessionPresentation.branch,
		detailModel,
		sessionStatus.label,
		view?.activity ?? 'no-view',
		view && view.activity !== 'idle' ? 'interrupt' : 'no-interrupt',
	])
	useEffect(() => {
		heading.current?.focus()
		const abort = new AbortController()
		lifecycle.current = abort
		return () => abort.abort()
	}, [])
	// biome-ignore lint/correctness/useExhaustiveDependencies: measure after text changes or editor mount changes, not just ref identity.
	useLayoutEffect(() => {
		const input = prompt.current
		if (!input) return
		const resize = () => {
			input.style.height = '0px'
			input.style.height = `${input.scrollHeight}px`
		}
		resize()
		window.addEventListener('resize', resize)
		return () => window.removeEventListener('resize', resize)
	}, [draft.text, promptExpanded, !!question])
	// biome-ignore lint/correctness/useExhaustiveDependencies: composer text/mount changes alter the reading viewport after the preceding layout effect.
	useLayoutEffect(() => {
		const pane = scroll.current
		if (!pane || !view) return
		const requestId = question?.requestId ?? null
		for (const key of draft.questionAnswers.keys()) {
			if (key !== requestId) draft.questionAnswers.delete(key)
		}
		const newQuestion = requestId !== observedQuestion.current
		if (newQuestion) observedQuestion.current = requestId
		if (newQuestion && question) {
			setPromptExpanded(false)
			const node = questionRegion.current
			const first = node?.querySelector<HTMLElement>('legend')
			if (draft.reading.following && node) {
				const paneRect = pane.getBoundingClientRect()
				pane.scrollTop += node.getBoundingClientRect().top - paneRect.top - 8
				setQuestionJump(false)
				restored.current = true
				return
			}
			if (first) {
				const paneRect = pane.getBoundingClientRect()
				const firstRect = first.getBoundingClientRect()
				setQuestionJump(firstRect.bottom <= paneRect.top || firstRect.top >= paneRect.bottom)
			}
		}
		if (draft.reading.following) pane.scrollTop = pane.scrollHeight
		else if (draft.reading.anchor) {
			const anchor = pane.querySelector<HTMLElement>(`[data-message-id="${CSS.escape(draft.reading.anchor)}"]`)
			if (anchor)
				pane.scrollTop +=
					anchor.getBoundingClientRect().top - pane.getBoundingClientRect().top - (draft.reading.offset ?? 0)
			else {
				if (!restored.current) pane.scrollTop = draft.reading.top
				setGap(true)
			}
		} else if (!restored.current) pane.scrollTop = draft.reading.top
		restored.current = true
	}, [messages, question, draft, draft.text, promptExpanded, showActivity, readingLayoutKey])
	const updateQuestionAnswers = useCallback(
		(requestId: string, answers: AnswerDraft) => {
			draft.questionAnswers.delete(requestId)
			draft.questionAnswers.set(requestId, answers)
			while (draft.questionAnswers.size > MAX_QUESTION_DRAFTS) {
				const oldest = draft.questionAnswers.keys().next().value
				if (typeof oldest !== 'string') break
				draft.questionAnswers.delete(oldest)
			}
			refresh()
		},
		[draft, refresh],
	)
	const onQuestionAnswersChange = useCallback(
		(answers: AnswerDraft) => {
			if (question) updateQuestionAnswers(question.requestId, answers)
		},
		[question, updateQuestionAnswers],
	)
	function rememberReading() {
		const pane = scroll.current
		if (!pane) return
		const top = pane.getBoundingClientRect().top
		const nextFollowing = pane.scrollHeight - pane.scrollTop - pane.clientHeight < 32
		const anchor = [...pane.querySelectorAll<HTMLElement>('[data-message-id]')].find(
			node => node.getBoundingClientRect().bottom > top,
		)
		draft.reading = {
			following: nextFollowing,
			top: pane.scrollTop,
			anchor: anchor?.dataset.messageId,
			offset: anchor ? anchor.getBoundingClientRect().top - top : undefined,
		}
		publishFollowing(nextFollowing)
		const first = questionRegion.current?.querySelector<HTMLElement>('legend')
		if (questionJump && first) {
			const bounds = pane.getBoundingClientRect()
			const firstBounds = first.getBoundingClientRect()
			if (firstBounds.bottom > bounds.top && firstBounds.top < bounds.bottom) setQuestionJump(false)
		}
	}
	function toggleActivity() {
		rememberReading()
		const anchor = messages?.find(message => message.id === draft.reading.anchor)
		if (showActivity && anchor && isActivityOnly(anchor)) {
			// Deliberately hiding the anchor is not a live-window gap.
			draft.reading.anchor = undefined
			restored.current = false
		}
		setGap(false)
		setShowActivity(value => !value)
	}
	const saveReceipt = useCallback(
		(receipt: RemoteReceipt, command: RemoteCommand) => {
			if (draft.operation?.command.commandId !== command.commandId) return
			draft.operation = { command, status: receipt.status }
			if (
				receipt.status === 'dispatched' &&
				command.operation.kind === 'prompt' &&
				draft.text.trim() === command.operation.text
			)
				draft.text = ''
			refresh()
		},
		[draft, refresh],
	)
	const check = useCallback(
		async (command: RemoteCommand) => {
			const signal = lifecycle.current?.signal
			if (!signal || signal.aborted) return
			try {
				saveReceipt(await transport.receipt(command, signal), command)
			} catch {
				if (!signal.aborted && draft.operation?.command.commandId === command.commandId) {
					draft.operation = { command, status: 'unknown' }
					refresh()
				}
			}
		},
		[draft, refresh, saveReceipt, transport],
	)
	const pendingCommand = operation?.status === 'pending' ? operation.command : undefined
	useEffect(() => {
		if (!pendingCommand) return
		const command = pendingCommand
		let cancelled = false
		let timer: ReturnType<typeof setTimeout>
		async function pollReceipt() {
			await check(command)
			if (!cancelled && draft.operation?.status === 'pending') timer = setTimeout(() => void pollReceipt(), 1000)
		}
		timer = setTimeout(() => void pollReceipt(), 1000)
		return () => {
			cancelled = true
			clearTimeout(timer)
		}
	}, [check, draft, pendingCommand])
	async function send(value: RemoteCommand['operation']) {
		const signal = lifecycle.current?.signal
		// This synchronous guard covers rapid keyboard/click activation before React paints disabled controls.
		if (
			!view ||
			!connected ||
			unresolved ||
			(draft.operation && ['sending', 'pending', 'unknown'].includes(draft.operation.status)) ||
			!signal ||
			signal.aborted ||
			!view.capabilities[value.kind]
		)
			return
		const command: RemoteCommand = {
			protocol: REMOTE_PROTOCOL,
			hostEpoch,
			commandId: crypto.randomUUID(),
			target: view.target,
			operation: value,
		}
		draft.operation = { command, status: 'sending' }
		refresh()
		try {
			saveReceipt(await transport.send(command, signal), command)
		} catch (error) {
			// A navigation abort is ambiguous too. Retain the exact command for read-only status recovery.
			const rejected =
				error instanceof RemoteAccessError && [400, 401, 403, 404, 409, 413, 415, 429].includes(error.status)
			draft.operation = { command, status: rejected ? 'rejected' : 'unknown' }
			refresh()
		}
	}
	function sendPrompt() {
		if (question || !draft.text.trim()) return
		void send({ kind: 'prompt', text: draft.text.trim(), delivery: draft.delivery })
	}
	function answerQuestion() {
		const pane = scroll.current
		const node = questionRegion.current
		if (!pane || !node) return
		const bounds = pane.getBoundingClientRect()
		pane.scrollTop += node.getBoundingClientRect().top - bounds.top - 8
		draft.reading.following = false
		draft.reading.top = pane.scrollTop
		publishFollowing(false)
		setQuestionJump(false)
		refresh()
		requestAnimationFrame(() => node.querySelector<HTMLInputElement>('input:not(:disabled)')?.focus())
	}
	return (
		<section className="remote-conversation" aria-label="Conversation">
			<header className="remote-header">
				<Btn className="remote-back" tone="ghost" onClick={onBack} ariaLabel="Back to live conversations">
					{GLYPH.back}
					<span>Back</span>
				</Btn>
				<h2 ref={heading} tabIndex={-1} title={sessionPresentation.title}>
					{sessionPresentation.title}
				</h2>
				{view && view.activity !== 'idle' && (
					<IconBtn
						label="Interrupt"
						className="remote-interrupt"
						disabled={!connected || !view.capabilities.interrupt || !!unresolved}
						onClick={() => void send({ kind: 'interrupt' })}
					>
						{GLYPH.stop}
					</IconBtn>
				)}
				<MenuButton
					trigger={GLYPH.ellipsis}
					triggerLabel="Conversation options"
					entries={[
						{ label: 'Show activity', checked: showActivity, checkedRole: 'checkbox', onSelect: toggleActivity },
					]}
				/>
			</header>
			<div
				className="remote-meta"
				// biome-ignore lint/a11y/noNoninteractiveTabindex: compact metadata becomes a bounded keyboard scroll owner.
				tabIndex={0}
				aria-label="Session metadata"
			>
				<RemoteSessionInfo session={session} status={sessionStatus} variant="detail" model={detailModel} />
			</div>
			{(!view ? false : !connected || gap) && (
				<output className="remote-notice">
					{!connected
						? 'Disconnected or refreshing — controls are unavailable.'
						: 'Some earlier messages are outside the live window. Your reading position needs attention.'}
				</output>
			)}
			{view?.historyTruncated && connected && !gap && (
				<p className="remote-context">Recent messages · Earlier messages remain in Pi.</p>
			)}
			<div className="remote-reading-area">
				<div
					ref={scroll}
					className="remote-transcript"
					onScroll={rememberReading}
					// biome-ignore lint/a11y/noNoninteractiveTabindex: keyboard users need to scroll the reading region without focusing the composer.
					tabIndex={0}
					aria-label="Conversation messages"
				>
					{!view && <p className="remote-note">Loading conversation…</p>}
					{view && <Messages messages={messages ?? EMPTY_MESSAGES} showActivity={showActivity} />}
					{capabilityMessage && <p className="remote-capability-note">{capabilityMessage}</p>}
					{question && (
						<div ref={questionRegion} data-question-request={question.requestId} tabIndex={-1}>
							<Question
								key={question.requestId}
								question={question}
								answers={questionAnswers ?? defaultAnswers}
								disabled={!connected || !view?.capabilities.answer || !!unresolved}
								onAnswersChange={onQuestionAnswersChange}
							/>
						</div>
					)}
					{terminalDialogNotice && (
						<p className="remote-notice">
							This dialog needs the original terminal. Remote does not support this custom UI.
						</p>
					)}
				</div>
				{(questionJump || (!question && !following)) && (
					<div className="remote-jump">
						{questionJump && (
							<Btn className="remote-jump-button" onClick={answerQuestion}>
								<RemoteArrow direction="down" />
								Answer question
							</Btn>
						)}
						{!question && !following && (
							<Btn
								className="remote-jump-button"
								onClick={() => {
									draft.reading.following = true
									publishFollowing(true)
									if (scroll.current) scroll.current.scrollTop = scroll.current.scrollHeight
									setGap(false)
									setQuestionJump(false)
									refresh()
								}}
							>
								<RemoteArrow direction="down" /> Jump to latest
							</Btn>
						)}
					</div>
				)}
			</div>
			<footer className="remote-composer">
				{operation && (
					<output className="remote-receipt">
						<span>{RECEIPT_COPY[operation.status]}</span>
						{operation.status === 'unknown' && (
							<>
								<Btn onClick={() => void check(operation.command)}>Check status</Btn>
								<Btn
									onClick={() => {
										draft.operation = undefined
										refresh()
									}}
								>
									I’ve checked the conversation
								</Btn>
							</>
						)}
					</output>
				)}
				{question && (draft.text.trim() || promptExpanded) ? (
					<div className="remote-draft-toggle">
						<span>{draft.text.trim() ? 'Message draft saved locally' : 'Message draft'}</span>
						<Btn ariaExpanded={promptExpanded} onClick={() => setPromptExpanded(value => !value)}>
							{promptExpanded ? 'Hide draft' : 'Edit draft'}
						</Btn>
					</div>
				) : null}
				<div className={!question || promptExpanded ? 'remote-compose-surface' : 'remote-question-actions'}>
					{(!question || promptExpanded) && (
						<label className="remote-prompt-field" htmlFor="remote-prompt">
							<span className="sr-only">Message</span>
							<textarea
								ref={prompt}
								id="remote-prompt"
								aria-label="Message"
								rows={1}
								maxLength={16384}
								value={draft.text}
								aria-keyshortcuts="Control+Enter Meta+Enter"
								onChange={event => {
									draft.text = event.target.value
									refresh()
								}}
								onKeyDown={event => {
									if ((event.metaKey || event.ctrlKey) && event.key === 'Enter' && !event.nativeEvent.isComposing) {
										event.preventDefault()
										sendPrompt()
									}
								}}
								placeholder="Message Pi…"
							/>
						</label>
					)}
					<div className="remote-composer-actions">
						{!question && (
							<MenuButton
								align="start"
								triggerLabel="Message delivery"
								triggerClass="btn btn-ghost remote-mode-trigger"
								trigger={
									<>
										{draft.delivery === 'steer' ? 'During work' : 'Follow-up'} {GLYPH.chevronDown}
									</>
								}
								entries={[
									{
										label: 'Steer at the next safe point',
										checked: draft.delivery === 'steer',
										onSelect: () => {
											draft.delivery = 'steer'
											refresh()
										},
									},
									{
										label: 'Follow up after current work',
										checked: draft.delivery === 'followUp',
										onSelect: () => {
											draft.delivery = 'followUp'
											refresh()
										},
									},
								]}
							/>
						)}
						{question ? (
							<Btn
								tone="primary"
								disabled={!connected || !view?.capabilities.answer || !!unresolved || !answersComplete}
								onClick={() => {
									if (questionAnswers && answersComplete)
										void send({
											kind: 'answer',
											requestId: question.requestId,
											answers: questionAnswers as Answer[],
										})
								}}
							>
								Submit answers
							</Btn>
						) : (
							<Btn
								className="remote-send"
								ariaLabel="Send"
								tone={draft.text.trim() ? 'primary' : 'quiet'}
								disabled={!connected || !view?.capabilities.prompt || !!unresolved || !draft.text.trim()}
								onClick={sendPrompt}
							>
								<RemoteArrow direction="up" />
							</Btn>
						)}
					</div>
				</div>
				{operation?.command.operation.kind === 'interrupt' && (
					<p className="remote-note">Interrupt requests an abort. Queued follow-ups may still run.</p>
				)}
			</footer>
		</section>
	)
}

function isActivityOnly(message: TranscriptMessage) {
	if (message.role === 'toolResult') return true
	if (message.role !== 'assistant') return false
	if (message.toolCalls !== undefined) return !message.text.trim()
	if (message.text.trim() && !message.text.startsWith('\nTool: ')) return false
	// Older bridges flatten tool calls into reserved `Tool: name` lines.
	// Hide only whole activity messages, never strip matching lines from prose/code.
	// This is a reversible display filter, not an activity or authority signal.
	return message.text.split('\n').every(line => !line.trim() || /^Tool: [^\n]{1,100}$/.test(line))
}

const Messages = memo(function Messages({
	messages,
	showActivity,
}: { messages: TranscriptMessage[]; showActivity: boolean }) {
	let speaker: TranscriptMessage['role'] | undefined
	return messages
		.filter(message => showActivity || !isActivityOnly(message))
		.map(message => {
			const showAuthor = message.role !== 'toolResult' && message.role !== speaker
			if (message.role !== 'toolResult') speaker = message.role
			return <Message key={message.id} message={message} showActivity={showActivity} showAuthor={showAuthor} />
		})
})

const Message = memo(function Message({
	message,
	showActivity,
	showAuthor,
}: { message: TranscriptMessage; showActivity: boolean; showAuthor: boolean }) {
	return (
		<article className="remote-message" data-message-id={message.id} data-continuation={!showAuthor || undefined}>
			{showAuthor && <h3 className="remote-message-author">{message.role === 'user' ? 'You' : 'Pi'}</h3>}
			{showActivity && message.thinking && <RemoteDisclosure label="Thinking" text={message.thinking} />}
			{showActivity && message.toolCalls && <RemoteDisclosure label="Tool calls" text={message.toolCalls} />}
			{message.role === 'toolResult' ? (
				<RemoteDisclosure label="Tool output" text={message.text} />
			) : message.role === 'assistant' ? (
				<RemoteMarkdown text={message.text} />
			) : (
				<p className="remote-user-text">{message.text}</p>
			)}
			{message.truncated && <p className="remote-note">Preview truncated. Full output remains in Pi.</p>}
		</article>
	)
})

const Question = memo(function Question({
	question,
	answers,
	disabled,
	onAnswersChange,
}: {
	question: NonNullable<RemoteSnapshot['question']>
	answers: AnswerDraft
	disabled: boolean
	onAnswersChange: (answers: AnswerDraft) => void
}) {
	const set = (index: number, answer: Answer) =>
		onAnswersChange(answers.map((value, key) => (key === index ? answer : value)))
	return (
		<section className="remote-question" aria-label="Question for you">
			{question.questions.map((value, index) => (
				<fieldset key={`${question.requestId}:${index}`} disabled={disabled}>
					<legend>{value.question}</legend>
					{value.options.map((option, optionIndex) => {
						const answer = answers[index]
						const checked =
							!!answer &&
							('option' in answer
								? answer.option === optionIndex
								: 'options' in answer && answer.options.includes(optionIndex))
						return (
							<label className="remote-option" key={option.label}>
								<input
									type={value.multiSelect ? 'checkbox' : 'radio'}
									name={`${question.requestId}-${index}`}
									checked={checked}
									onChange={() => {
										if (!value.multiSelect) set(index, { option: optionIndex })
										else {
											const previous = answer && 'options' in answer ? answer.options : []
											set(index, {
												options: checked ? previous.filter(item => item !== optionIndex) : [...previous, optionIndex],
											})
										}
									}}
								/>
								<span>
									<strong>{option.label}</strong>
									<span>{option.description}</span>
									{checked && option.preview && <pre>{option.preview}</pre>}
								</span>
							</label>
						)
					})}
					<label>
						Write an answer instead
						<input
							aria-label={`Custom answer: ${value.header}`}
							maxLength={4000}
							value={answers[index] && 'text' in answers[index] ? answers[index].text : ''}
							onChange={event => set(index, { text: event.target.value })}
						/>
					</label>
				</fieldset>
			))}
		</section>
	)
})
