import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import type { HistoryRecord } from '../../../../src/remote/history-protocol.js'
import type { RemoteImageReference } from '../../../../src/remote/image-input-protocol.js'
import type {
	RemoteCommand,
	RemoteDirectory,
	RemoteReceipt,
	RemoteSnapshot,
	RemoteSummary,
} from '../../../../src/remote/protocol.js'
import { REMOTE_PROTOCOL, sameRemoteTarget } from '../../../../src/remote/protocol.js'
import { ActivityIndicator } from '../activity-indicator.js'
import { Btn } from '../button.js'
import { GLYPH, IconBtn, MenuButton } from '../sidebar/ui.js'
import { HistoryNavigation, HistoryRangeNote } from './HistoryNavigation.js'
import { RemoteArrow } from './RemoteArrow.js'
import { RemoteDisclosure } from './RemoteDisclosure.js'
import { InformationFooter, RemoteInformation, useInformationRail, useRemoteInformation } from './RemoteInformation.js'
import { RemoteMarkdown } from './RemoteMarkdown.js'
import { RemoteSessionMenu } from './RemoteSessionMenu.js'
import { RemoteUsagePanel } from './RemoteUsagePanel.js'
import { RemoteHistoryController } from './history-controller.js'
import { ImageDraftResources, disposeImageBundle } from './image-draft.js'
import { prepareSelectedImages } from './image-preparation.js'
import {
	type PromptDraft,
	admitPrompt,
	choosePrompt,
	disposePromptDraft,
	editPrompt,
	editPromptImages,
	promptHasContent,
	settlePrompt,
} from './prompt-draft.js'
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
import { RemoteSubagentFreshnessController, remoteActivityAvailable } from './subagent-freshness.js'
import { normalizeThinkingText } from './thinking-text.js'
import { RemoteAccessError, type RemoteTransport } from './transport.js'
import { useRemoteUsage } from './usage-controller.js'
import { useFavoriteFocus } from './use-favorite-focus.js'
import { type RemoteFavoriteControls, useRemoteFavorites } from './use-favorites.js'
import { useLongPress } from './use-long-press.js'
import { useRemotePoll } from './use-poll.js'
import './remote.css'

type Operation = { command: RemoteCommand; status: RemoteReceipt['status'] | 'sending' }
function operationBlocksAdmission(operation: Operation | undefined, questionRequestId?: string): boolean {
	if (!operation) return false
	if (operation.status === 'sending' || operation.status === 'pending' || operation.status === 'unknown') return true
	return (
		operation.status === 'answered' &&
		operation.command.operation.kind === 'answer' &&
		operation.command.operation.requestId === questionRequestId
	)
}
type Answer = Extract<RemoteCommand['operation'], { kind: 'answer' }>['answers'][number]
type AnswerDraft = Array<Answer | null>
const MAX_QUESTION_DRAFTS = 8
interface Reading {
	following: boolean
	top: number
	anchor?: string
	offset?: number
}
interface Draft extends PromptDraft {
	delivery: 'steer' | 'followUp'
	failedSelection?: string
	preparation?: { token: symbol; controller: AbortController }
	transfer?: { token: symbol; commandId: string; delivery: 'steer' | 'followUp'; controller: AbortController }
	reading: Reading
	/** Memory-only drafts are scoped by this conversation's complete identity and request id. */
	questionAnswers: Map<string, AnswerDraft>
	operation?: Operation
}
const newDraft = (): Draft => ({
	text: '',
	images: [],
	editToken: Symbol(),
	delivery: 'steer',
	reading: { following: true, top: 0 },
	questionAnswers: new Map(),
})
function disposeDraft(draft: Draft): void {
	draft.preparation?.controller.abort()
	draft.transfer?.controller.abort()
	draft.preparation = undefined
	draft.transfer = undefined
	disposePromptDraft(draft)
}

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
	const [freshness] = useState(() => new RemoteSubagentFreshnessController())
	const receipt = useMemo(
		() => freshness.receipt((value, startedAt) => freshness.replaceDirectory(value as RemoteDirectory, startedAt)),
		[freshness],
	)
	const directory = useRemotePoll(read, 2000, { equal: sameRemoteDirectory, receipt })
	const favorites = useRemoteFavorites(transport, directory.value, directory.error === null)
	useSyncExternalStore(freshness.subscribe, freshness.getSnapshot)

	if (directory.error === 401 || favorites.accessEnded)
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
	return (
		<Workspace
			transport={transport}
			directory={directory.value}
			available={directory.error === null}
			freshness={freshness}
			favorites={favorites}
		/>
	)
}

function Workspace({
	transport,
	directory,
	available,
	freshness,
	favorites,
}: {
	transport: RemoteTransport
	directory: RemoteDirectory
	available: boolean
	freshness: RemoteSubagentFreshnessController
	favorites: RemoteFavoriteControls
}) {
	const identity = (session: RemoteSummary) => remoteSessionIdentity(directory.hostEpoch, session.target)
	const [selected, setSelected] = useState<string | null>(null)
	const selectedRef = useRef<string | null>(null)
	selectedRef.current = selected
	const [query, setQuery] = useState('')
	const [scope, setScope] = useState('all')
	const [tab, setTab] = useState<'sessions' | 'usage'>('sessions')
	const [rowMenu, setRowMenu] = useState<string | null>(null)
	const rowMenuRef = useRef<string | null>(null)
	rowMenuRef.current = rowMenu
	const restoreFocusKey = useRef<string | null>(null)
	const longPress = useLongPress(setRowMenu)
	// Nothing is read from the providers while the session list is the visible destination.
	const usage = useRemoteUsage(transport, tab === 'usage')
	const drafts = useRef(new Map<string, Draft>())
	const [imageResources] = useState(() => new ImageDraftResources())
	const mounted = useRef(false)
	const mountGeneration = useRef(0)
	const [, redrawSettlement] = useState(0)
	useEffect(() => {
		const generation = ++mountGeneration.current
		mounted.current = true
		return () => {
			mounted.current = false
			queueMicrotask(() => {
				// React StrictMode's setup-cleanup-setup cycle must not retire the live root's resources.
				if (mountGeneration.current !== generation || mounted.current) return
				for (const draft of drafts.current.values()) disposeDraft(draft)
				drafts.current.clear()
				imageResources.dispose()
			})
		}
	}, [imageResources])
	// Retained Drafts may settle after Back/Forward replaced their Conversation component.
	// Notify only the selected exact owner; local editing keeps its Conversation-only refresh.
	const notifySettlement = useCallback((key: string, captured: Draft) => {
		if (mounted.current && drafts.current.get(key) === captured && selectedRef.current === key)
			redrawSettlement(value => value + 1)
	}, [])
	const publishedDirectory = useRef<RemoteDirectory | null>(null)
	const directoryRef = useRef<HTMLElement>(null)
	const rememberFavoriteFocus = useFavoriteFocus(favorites.pending)
	// Closing returns to the row the menu belongs to, then hands that focus to the
	// owner guard so pinning cannot drop it when the row moves to the top.
	const closeRowMenu = useCallback(() => {
		const key = rowMenuRef.current
		setRowMenu(null)
		const row = key
			? (directoryRef.current?.querySelector<HTMLButtonElement>(`[data-session-key="${key}"]`) ?? null)
			: null
		row?.focus({ preventScroll: true })
		rememberFavoriteFocus(row)
		// Pinning moves the row into the other section, so the element that had focus is
		// replaced rather than reordered; the key survives where the node does not.
		restoreFocusKey.current = key
	}, [rememberFavoriteFocus])
	useLayoutEffect(() => {
		if (favorites.pending !== null) return
		const key = restoreFocusKey.current
		restoreFocusKey.current = null
		// Never take focus back from wherever the reader has since moved it.
		if (!key || document.activeElement !== document.body) return
		directoryRef.current?.querySelector<HTMLButtonElement>(`[data-session-key="${key}"]`)?.focus({
			preventScroll: true,
		})
	}, [favorites.pending])
	const directoryBody = useRef<HTMLDivElement>(null)
	const directoryHeading = useRef<HTMLHeadingElement>(null)
	const historyOwner = useRef(`remote-${crypto.randomUUID()}`).current
	const historyOwned = useRef(false)
	const historySelection = useRef<string | null>(null)
	const backPending = useRef(false)
	const informationBack = useRef<(() => boolean) | null>(null)
	const [announcement, setAnnouncement] = useState('')
	const session = directory.sessions.find(value => identity(value) === selected)
	const directoryStateRef = useRef(directory)
	directoryStateRef.current = directory
	const selectedDraft = selected ? drafts.current.get(selected) : undefined
	useEffect(() => {
		if (!available || publishedDirectory.current === directory) return
		publishedDirectory.current = directory
		pruneAbsentRemoteDrafts(drafts.current, directory, disposeDraft)
	}, [available, directory])
	useEffect(() => {
		function onPopState(event: PopStateEvent) {
			backPending.current = false
			// Info is local to this conversation, not another owner or history range.
			// Consume Back by restoring our one conversation entry, with no target in the URL.
			if (
				event.state?.[REMOTE_HISTORY_KEY] !== historyOwner &&
				selectedRef.current &&
				directoryStateRef.current.sessions.some(
					value => remoteSessionIdentity(directoryStateRef.current.hostEpoch, value.target) === selectedRef.current,
				) &&
				informationBack.current?.()
			) {
				try {
					history.pushState({ ...(event.state ?? {}), [REMOTE_HISTORY_KEY]: historyOwner }, '', window.location.href)
					return
				} catch {
					/* Fall through to the existing safe directory destination. */
				}
			}
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
	const favoriteEntries = new Map(
		favorites.entries.map(entry => [remoteSessionIdentity(directory.hostEpoch, entry.target), entry]),
	)
	const visible = directory.sessions.filter(value => {
		const matchesScope = scope === 'all' || scope === (value.target.scopeId ?? 'personal')
		return matchesScope && remoteSessionSearchText(value).toLowerCase().includes(query.toLowerCase())
	})
	// Pinned conversations are a separate section, so the remaining list keeps its own order.
	const pinned = visible.filter(value => favoriteEntries.get(identity(value))?.favorite === true)
	const unpinned = visible.filter(value => favoriteEntries.get(identity(value))?.favorite !== true)
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
		<main className="remote-workspace" data-open={!!session} data-tab={tab}>
			<aside ref={directoryRef} className="remote-directory" aria-label="Session directory" hidden={tab !== 'sessions'}>
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
						{favorites.error && (
							<p className="remote-note">
								<output>{favorites.error}</output>
							</p>
						)}
						{pinned.length > 0 && (
							<>
								<h2 className="remote-section-heading">Pinned</h2>
								<nav className="remote-session-list" aria-label="Pinned sessions">
									{pinned.map(value => (
										<div key={identity(value)} className="remote-session-entry" {...longPress(identity(value))}>
											<button
												type="button"
												className="remote-session-row"
												data-session-key={identity(value)}
												aria-current={selected === identity(value) ? 'page' : undefined}
												onClick={() => select(value)}
											>
												<RemoteSessionInfo
													session={value}
													status={remoteSessionStatus(
														value.activity,
														available && value.connected,
														freshness.resolve(
															directory.hostEpoch,
															value.target,
															value.revision,
															available && value.connected,
															value.subagents,
														),
													)}
													variant="row"
												/>
											</button>
											{rowMenu === identity(value) && favoriteEntries.has(identity(value)) && (
												<RemoteSessionMenu
													title={describeRemoteSession(value).title}
													favorite={favoriteEntries.get(identity(value))?.favorite ?? false}
													canEdit={favorites.available && (favoriteEntries.get(identity(value))?.canEdit ?? false)}
													busy={favorites.pending !== null}
													onClose={closeRowMenu}
													onToggle={() => {
														favorites.setFavorite(value.target, !favoriteEntries.get(identity(value))?.favorite)
														closeRowMenu()
													}}
												/>
											)}
										</div>
									))}
								</nav>
							</>
						)}
						<h2 ref={directoryHeading} className="remote-section-heading" tabIndex={-1}>
							Live sessions
						</h2>
						<nav className="remote-session-list" aria-label="Live sessions">
							{unpinned.map(value => (
								<div key={identity(value)} className="remote-session-entry" {...longPress(identity(value))}>
									<button
										type="button"
										className="remote-session-row"
										data-session-key={identity(value)}
										aria-current={selected === identity(value) ? 'page' : undefined}
										onClick={() => select(value)}
									>
										<RemoteSessionInfo
											session={value}
											status={remoteSessionStatus(
												value.activity,
												available && value.connected,
												freshness.resolve(
													directory.hostEpoch,
													value.target,
													value.revision,
													available && value.connected,
													value.subagents,
												),
											)}
											variant="row"
										/>
									</button>
									{rowMenu === identity(value) && favoriteEntries.has(identity(value)) && (
										<RemoteSessionMenu
											title={describeRemoteSession(value).title}
											favorite={favoriteEntries.get(identity(value))?.favorite ?? false}
											canEdit={favorites.available && (favoriteEntries.get(identity(value))?.canEdit ?? false)}
											busy={favorites.pending !== null}
											onClose={closeRowMenu}
											onToggle={() => {
												favorites.setFavorite(value.target, !favoriteEntries.get(identity(value))?.favorite)
												closeRowMenu()
											}}
										/>
									)}
								</div>
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
			{tab === 'usage' && <RemoteUsagePanel state={usage} now={usage.response?.refreshedAt ?? Date.now()} />}
			{tab === 'sessions' &&
				(session && selectedDraft ? (
					<Conversation
						key={identity(session)}
						transport={transport}
						session={session}
						hostEpoch={directory.hostEpoch}
						available={available}
						draft={selectedDraft}
						notifySettlement={notifySettlement}
						onBack={back}
						informationBack={informationBack}
						imageResources={imageResources}
					/>
				) : (
					<section className="remote-empty remote-unselected">
						<h2>Choose a session</h2>
						<p>Read and control the same Pi conversation without restarting its terminal.</p>
					</section>
				))}
			{/* A destination bar, not a pane control: it stays put while reading a conversation. */}
			<nav className="remote-tabs" aria-label="Remote sections">
				{(['sessions', 'usage'] as const).map(value => (
					<button
						key={value}
						type="button"
						className="remote-tab"
						aria-current={tab === value ? 'page' : undefined}
						onClick={() => setTab(value)}
					>
						{value === 'sessions' ? 'Sessions' : 'Usage'}
					</button>
				))}
			</nav>
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
	notifySettlement,
	onBack,
	informationBack,
	imageResources,
}: {
	transport: RemoteTransport
	session: RemoteSummary
	hostEpoch: string
	available: boolean
	draft: Draft
	notifySettlement: (key: string, captured: Draft) => void
	onBack: () => void
	informationBack: { current: (() => boolean) | null }
	imageResources: ImageDraftResources
}) {
	const [, redraw] = useState(0)
	const ownerKey = remoteSessionIdentity(hostEpoch, session.target)
	const publishSettlement = useCallback(() => notifySettlement(ownerKey, draft), [notifySettlement, ownerKey, draft])
	const read = useCallback(
		(signal: AbortSignal) => transport.detail(session.target.sessionId, signal),
		[transport, session.target.sessionId],
	)
	const [freshness] = useState(() => new RemoteSubagentFreshnessController())
	const receipt = useMemo(
		() =>
			freshness.receipt((value, startedAt) =>
				freshness.replaceDetail(value as import('../../../../src/remote/protocol.js').RemoteDetail, startedAt),
			),
		[freshness],
	)
	const detail = useRemotePoll(read, 1000, { equal: sameRemoteDetail, receipt })
	useSyncExternalStore(freshness.subscribe, freshness.getSnapshot)
	const [reader] = useState(() => new RemoteHistoryController(transport, { hostEpoch, target: session.target }))
	const historyState = useSyncExternalStore(reader.subscribe, reader.getSnapshot)
	const information = useRemoteInformation(transport, { hostEpoch, target: session.target })
	const rail = useInformationRail()
	const [infoOpen, setInfoOpen] = useState(false)
	const infoCovering = useRef(false)
	infoCovering.current = infoOpen && !rail
	const infoOpener = useRef<HTMLButtonElement>(null)
	const infoHeading = useRef<HTMLHeadingElement>(null)
	const [infoFocusRequest, requestInfoFocus] = useState<symbol | null>(null)
	useLayoutEffect(() => {
		if (infoFocusRequest && (document.activeElement === document.body || document.activeElement === infoOpener.current))
			infoHeading.current?.focus({ preventScroll: true })
	}, [infoFocusRequest])
	const openInfo = () => {
		infoCovering.current = !rail
		setInfoOpen(true)
		requestInfoFocus(Symbol())
	}
	const closeInfo = useCallback(() => {
		const active = document.activeElement
		const restoreFocus =
			active === document.body ||
			active === infoOpener.current ||
			(active instanceof HTMLElement && !!active.closest('.remote-information, .remote-information-back, .remote-back'))
		infoCovering.current = false
		setInfoOpen(false)
		if (restoreFocus) infoOpener.current?.focus({ preventScroll: true })
	}, [])
	useLayoutEffect(() => {
		informationBack.current = () => {
			if (!infoOpen || rail) return false
			informationBack.current = null
			closeInfo()
			return true
		}
		return () => {
			informationBack.current = null
		}
	}, [informationBack, infoOpen, rail, closeInfo])
	useEffect(() => {
		if (!infoOpen || rail) return
		const onInfoEscape = (event: KeyboardEvent) => {
			if (event.key !== 'Escape' || event.isComposing) return
			event.preventDefault()
			event.stopImmediatePropagation()
			closeInfo()
		}
		window.addEventListener('keydown', onInfoEscape, true)
		return () => window.removeEventListener('keydown', onInfoEscape, true)
	}, [infoOpen, rail, closeInfo])
	const view =
		historyState.issue === 'access-ended' || information.state.status === 'access-ended'
			? undefined
			: detail.value?.snapshot
	const question = useStableQuestion(view?.question)
	const liveMessages = useStableMessages(view?.messages)
	const historyPage = historyState.current?.page
	const messages = useMemo(
		() =>
			historyPage
				? historyPage.records.flatMap(record => (record.kind === 'message' ? [record.message] : []))
				: liveMessages,
		[historyPage, liveMessages],
	)
	const historyRange = useRef<string | null>(null)
	const [gap, setGap] = useState(false)
	const [questionJump, setQuestionJump] = useState(false)
	const [promptExpanded, setPromptExpanded] = useState(false)
	const draftToggleButton = useRef<HTMLButtonElement>(null)
	const [showActivity, setShowActivity] = useState(false)
	const historyEntry = useRef<HTMLButtonElement>(null)
	const historyEntryFocus = useRef(false)
	const [following, setFollowing] = useState(() => draft.reading.following)
	const followingRef = useRef(following)
	const scroll = useRef<HTMLDivElement>(null)
	const prompt = useRef<HTMLTextAreaElement>(null)
	const imageInput = useRef<HTMLInputElement>(null)
	const composing = useRef(false)
	const attachPrompt = useCallback((node: HTMLTextAreaElement | null) => {
		prompt.current = node
		composing.current = false
	}, [])
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
	const recovery = draft.recovery?.state === 'choice' ? draft.recovery : undefined
	const transfer = draft.transfer
	const preparingImages = !!draft.preparation
	const attachedImages = draft.images ?? []
	const expandedImageQuestion =
		!!question && promptExpanded && (!!attachedImages.length || preparingImages || !!draft.failedSelection)
	const answerAwaitingObservation =
		operation?.status === 'answered' &&
		operation.command.operation.kind === 'answer' &&
		question?.requestId === operation.command.operation.requestId
	const unresolved =
		(operation && ['sending', 'pending', 'unknown'].includes(operation.status)) || answerAwaitingObservation
	const connected =
		historyState.issue !== 'access-ended' &&
		session.connected &&
		available &&
		detail.error === null &&
		view?.connected &&
		detail.value?.hostEpoch === hostEpoch &&
		sameRemoteTarget(view.target, session.target)
	const answerAdmission = useRef({ requestId: question?.requestId, allowed: false })
	answerAdmission.current = { requestId: question?.requestId, allowed: !!connected && !!view?.capabilities.answer }
	const promptAuthority = useRef({
		connected: false,
		target: session.target,
		allowed: false,
		image: false,
		question: true,
	})
	promptAuthority.current = {
		connected: !!connected,
		target: view?.target ?? session.target,
		allowed: !!view?.capabilities.prompt,
		image: view?.imageInput?.version === 1 && view.imageInput.available === true && !!transport.uploadImage,
		question: !!question,
	}
	useLayoutEffect(() => {
		reader.setAvailable(!!connected)
		information.controller.setAvailable(!!connected)
	}, [reader, connected, information.controller])
	useEffect(() => () => reader.dispose(), [reader])
	const statusActivity = view?.activity ?? session.activity
	const statusConnected = !!(view && connected)
	const freshSubagents = view
		? freshness.resolve(hostEpoch, view.target, view.revision, statusConnected, view.subagents)
		: undefined
	const sessionStatus = useMemo(
		() => remoteSessionStatus(statusActivity, statusConnected, freshSubagents),
		[statusActivity, statusConnected, freshSubagents],
	)
	const sessionPresentation = useMemo(() => describeRemoteSession(session), [session])
	const currentConversation = useMemo(
		() => ({
			presentation: sessionPresentation,
			status: sessionStatus,
			workspace: session.workspace?.trim() || null,
			subagents: freshSubagents,
		}),
		[sessionPresentation, sessionStatus, session.workspace, freshSubagents],
	)
	const detailModel = (view?.model ?? session.model)?.trim() || null
	const defaultAnswers = useMemo<AnswerDraft>(() => (question ? defaultQuestionAnswers(question) : []), [question])
	const questionAnswers = question ? (draft.questionAnswers.get(question.requestId) ?? defaultAnswers) : undefined
	const answersComplete = !!question && !!questionAnswers && questionAnswersComplete(question, questionAnswers)
	const imageInputAvailable =
		!!connected && view?.imageInput?.version === 1 && view.imageInput.available && !!transport.uploadImage
	const imageInputDisabled = !imageInputAvailable || preparingImages || !!transfer || attachedImages.length >= 4
	useEffect(() => {
		if (!question && connected) return
		draft.preparation?.controller.abort()
		draft.preparation = undefined
	}, [connected, draft, question])
	useEffect(() => {
		if (imageInputAvailable && !question) return
		const current = draft.transfer
		if (!current) return
		current.controller.abort()
		draft.transfer = undefined
		settlePrompt(draft, current.commandId, 'rejected')
		publishSettlement()
	}, [draft, imageInputAvailable, publishSettlement, question])
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
		return () => {
			abort.abort()
			draft.preparation?.controller.abort()
			draft.preparation = undefined
			const transfer = draft.transfer
			if (transfer) {
				transfer.controller.abort()
				draft.transfer = undefined
				settlePrompt(draft, transfer.commandId, 'rejected')
				publishSettlement()
			}
		}
	}, [draft, publishSettlement])
	// biome-ignore lint/correctness/useExhaustiveDependencies: measure after text changes or editor mount changes, not just ref identity.
	useLayoutEffect(() => {
		const input = prompt.current
		if (!input) return
		const resize = () => {
			// rows=1 and the CSS minimum already size an empty editor. Avoid forcing
			// an initial layout of the conversation just to measure that same row.
			if (!input.value) {
				input.style.height = 'auto'
				return
			}
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
		const range = historyPage?.reread ?? null
		if (range !== historyRange.current) {
			historyRange.current = range
			setGap(false)
			if (range) {
				const saved = historyState.current?.anchor
				const anchor = saved && pane.querySelector<HTMLElement>(`[data-message-id="${CSS.escape(saved.id)}"]`)
				pane.scrollTop = 0
				if (anchor)
					pane.scrollTop += anchor.getBoundingClientRect().top - pane.getBoundingClientRect().top - saved.offset
				else if (saved) setGap(true)
			}
		}
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
			if (!historyState.browsing && draft.reading.following && node) {
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
		if (historyState.browsing) {
			const saved = historyState.current?.anchor
			const node = saved && pane.querySelector<HTMLElement>(`[data-message-id="${CSS.escape(saved.id)}"]`)
			if (node) pane.scrollTop += node.getBoundingClientRect().top - pane.getBoundingClientRect().top - saved.offset
			return
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
	}, [
		messages,
		question,
		draft,
		draft.text,
		promptExpanded,
		showActivity,
		readingLayoutKey,
		historyState,
		historyPage,
		rail,
	])
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
		if (historyPage) {
			if (anchor?.dataset.messageId)
				reader.remember({
					id: anchor.dataset.messageId,
					offset: anchor.getBoundingClientRect().top - top,
					range: historyPage.reread,
				})
			return
		}
		if (historyState.browsing) return
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
	function openHistory() {
		historyEntryFocus.current = document.activeElement === historyEntry.current
		setQuestionJump(!!question)
		rememberReading()
		setGap(false)
		reader.open(liveMessages?.find(message => message.id !== 'current' && isMessageVisible(message, showActivity))?.id)
	}
	function latestHistory() {
		reader.latest()
		if (question) observedQuestion.current = null
		draft.reading = { following: true, top: 0 }
		publishFollowing(true)
		setGap(false)
		setQuestionJump(false)
		refresh()
	}
	function moveHistory(direction: 'older' | 'newer') {
		rememberReading()
		reader.move(direction)
	}
	useLayoutEffect(() => {
		if (!historyEntryFocus.current || !historyState.browsing) return
		const active = document.activeElement
		if (active !== document.body && active !== null) {
			historyEntryFocus.current = false
			return
		}
		const destination = scroll.current
			?.closest('.remote-chat')
			?.querySelector<HTMLButtonElement>('.remote-history-actions .btn:not([aria-disabled="true"]):not([disabled])')
		;(destination ?? scroll.current)?.focus({ preventScroll: true })
		historyEntryFocus.current = false
	}, [historyState.browsing])
	function toggleActivity() {
		rememberReading()
		const anchor = messages?.find(message => message.id === (historyState.current?.anchor?.id ?? draft.reading.anchor))
		if (showActivity && anchor && !isMessageVisible(anchor, false)) {
			// Deliberately hiding the anchor is not a live-window gap.
			draft.reading.anchor = undefined
			reader.forgetAnchor()
			restored.current = false
		}
		setGap(false)
		setShowActivity(value => !value)
	}
	const saveReceipt = useCallback(
		(receipt: RemoteReceipt, command: RemoteCommand) => {
			if (draft.operation?.command.commandId !== command.commandId) return
			draft.operation = { command, status: receipt.status }
			if (receipt.status === 'dispatched' || receipt.status === 'rejected')
				settlePrompt(draft, command.commandId, receipt.status)
			publishSettlement()
		},
		[draft, publishSettlement],
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
					publishSettlement()
				}
			}
		},
		[draft, publishSettlement, saveReceipt, transport],
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
	async function postCommand(command: RemoteCommand, signal: AbortSignal) {
		draft.operation = { command, status: 'sending' }
		refresh()
		try {
			saveReceipt(await transport.send(command, signal), command)
		} catch (error) {
			if (draft.operation?.command.commandId !== command.commandId) return
			// Once POST begins, an abort or transport failure is ambiguous and stays in the existing status flow.
			const rejected =
				error instanceof RemoteAccessError && [400, 401, 403, 404, 409, 413, 415, 429].includes(error.status)
			draft.operation = { command, status: rejected ? 'rejected' : 'unknown' }
			if (rejected) settlePrompt(draft, command.commandId, 'rejected')
			publishSettlement()
		}
	}
	function cancelUnsubmittedTransfer() {
		const current = draft.transfer
		if (!current) return
		current.controller.abort()
		draft.transfer = undefined
		settlePrompt(draft, current.commandId, 'rejected')
	}
	async function send(value: RemoteCommand['operation']) {
		// Every entry path checks the mutable Draft, not render-captured operation state.
		if (operationBlocksAdmission(draft.operation, question?.requestId)) return
		// A stale handler cannot answer a questionnaire covered by the mobile Info destination.
		if (
			value.kind === 'answer' &&
			(infoCovering.current ||
				!answerAdmission.current.allowed ||
				value.requestId !== answerAdmission.current.requestId)
		)
			return
		const signal = lifecycle.current?.signal
		const authority = value.kind === 'answer' ? answerAdmission.current.allowed : !!view?.capabilities[value.kind]
		// Synchronous admission also lets legitimate controls cancel an upload before any command POST.
		if (!view || !connected || unresolved || !signal || signal.aborted || !authority) return
		const command: RemoteCommand = {
			protocol: REMOTE_PROTOCOL,
			hostEpoch,
			commandId: crypto.randomUUID(),
			target: view.target,
			operation: value,
		}
		if (value.kind === 'prompt') {
			if (composing.current || draft.preparation || !admitPrompt(draft, command.commandId)) return
			draft.transferFailure = undefined
		}
		// Admission is synchronous: a same-task click/key event cannot replace this command.
		draft.operation = { command, status: 'sending' }
		if (value.kind !== 'prompt') cancelUnsubmittedTransfer()
		refresh()
		void postCommand(command, signal)
	}
	async function uploadPrompt(commandId: string, controller: AbortController) {
		const captured = draft.transfer
		const recovery = draft.recovery
		if (!captured || captured.commandId !== commandId || !recovery || !transport.uploadImage) return
		const references: RemoteImageReference[] = []
		try {
			for (const image of recovery.images) {
				if (draft.transfer !== captured || controller.signal.aborted) throw controller.signal.reason
				const envelope = await transport.uploadImage(
					{ hostEpoch, target: session.target },
					image.blob,
					controller.signal,
				)
				const current = promptAuthority.current
				if (
					draft.transfer !== captured ||
					controller.signal.aborted ||
					!current.connected ||
					!current.allowed ||
					!current.image ||
					current.question ||
					!sameRemoteTarget(current.target, session.target) ||
					envelope.hostEpoch !== hostEpoch ||
					envelope.image.sha256 !== image.sha256 ||
					envelope.image.bytes !== image.bytes ||
					envelope.image.width !== image.width ||
					envelope.image.height !== image.height ||
					envelope.image.mimeType !== image.mimeType
				)
					throw new Error('Image upload no longer matches this conversation')
				references.push(envelope.image)
			}
			const current = promptAuthority.current
			if (
				draft.transfer !== captured ||
				controller.signal.aborted ||
				!current.connected ||
				!current.allowed ||
				!current.image ||
				current.question ||
				!sameRemoteTarget(current.target, session.target)
			)
				throw new Error('Conversation changed before image submission')
			const signal = lifecycle.current?.signal
			if (!signal || signal.aborted) throw signal?.reason
			const command: RemoteCommand = {
				protocol: REMOTE_PROTOCOL,
				hostEpoch,
				commandId,
				target: session.target,
				operation: {
					kind: 'prompt',
					text: recovery.rawText.trim(),
					delivery: captured.delivery,
					images: references,
				},
			}
			draft.transfer = undefined
			await postCommand(command, signal)
		} catch {
			if (draft.transfer !== captured) return
			draft.transfer = undefined
			settlePrompt(draft, commandId, 'rejected')
			if (!controller.signal.aborted)
				draft.transferFailure = {
					transferToken: captured.token,
					message: 'Message was not sent. Image upload failed.',
				}
			publishSettlement()
		}
	}
	function sendPrompt() {
		if (
			operationBlocksAdmission(draft.operation, question?.requestId) ||
			question ||
			composing.current ||
			draft.preparation ||
			draft.failedSelection ||
			draft.transfer ||
			!promptHasContent(draft)
		)
			return
		const commandId = crypto.randomUUID()
		const images = draft.images ?? []
		if (!images.length) {
			void send({ kind: 'prompt', text: draft.text.trim(), delivery: draft.delivery })
			return
		}
		if (!imageInputAvailable || !view || !admitPrompt(draft, commandId)) return
		draft.transferFailure = undefined
		const controller = new AbortController()
		draft.transfer = { token: Symbol(), commandId, delivery: draft.delivery, controller }
		refresh()
		void uploadPrompt(commandId, controller)
	}
	async function selectImages(files: readonly File[]) {
		if (!files.length) return
		if (!imageInputAvailable || question || draft.preparation || draft.transfer) return
		if ((draft.images?.length ?? 0) + files.length > 4) {
			draft.failedSelection = 'Attach no more than four images to one message.'
			refresh()
			return
		}
		const controller = new AbortController()
		const reservation = imageResources.reserve(files.length, controller.signal)
		if (!reservation) {
			draft.failedSelection = 'Image preparation is busy or the 16-image, 24 MiB local limit is full.'
			refresh()
			return
		}
		const preparation = { token: Symbol(), controller }
		draft.preparation = preparation
		refresh()
		try {
			const prepared = await prepareSelectedImages(files, reservation)
			if (draft.preparation !== preparation || controller.signal.aborted) {
				disposeImageBundle(prepared)
				return
			}
			editPromptImages(draft, [...(draft.images ?? []), ...prepared])
			draft.failedSelection = undefined
		} catch (error) {
			if (draft.preparation === preparation && !controller.signal.aborted)
				draft.failedSelection =
					error instanceof Error ? error.message.slice(0, 240) : 'Image preparation failed. Nothing was attached.'
		} finally {
			if (draft.preparation === preparation) draft.preparation = undefined
			publishSettlement()
		}
	}
	function leaveConversation() {
		draft.preparation?.controller.abort()
		draft.preparation = undefined
		cancelUnsubmittedTransfer()
		onBack()
	}
	function collapsePromptDraft() {
		setPromptExpanded(false)
		requestAnimationFrame(() => draftToggleButton.current?.focus())
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
			<div className="remote-chat">
				<header className="remote-header">
					<IconBtn
						className="remote-back"
						onClick={infoOpen && !rail ? closeInfo : leaveConversation}
						label={infoOpen && !rail ? 'Back to conversation' : 'Back to live conversations'}
					>
						{GLYPH.back}
					</IconBtn>
					<h2 ref={heading} tabIndex={-1} title={sessionPresentation.title}>
						{sessionPresentation.title}
					</h2>
					<MenuButton
						trigger={GLYPH.ellipsis}
						triggerLabel="Conversation options"
						triggerRef={infoOpener}
						entries={[
							{ label: 'Info', onSelect: openInfo },
							{ label: 'Show tool activity', checked: showActivity, checkedRole: 'checkbox', onSelect: toggleActivity },
							...(historyPage
								? [
										{
											label: 'Reread this range',
											onSelect: () => {
												rememberReading()
												reader.reread()
											},
										},
									]
								: []),
						]}
					/>
				</header>
				{(!view ? false : !connected || gap) && (
					<output className="remote-notice">
						{!connected
							? 'Disconnected or refreshing — controls are unavailable.'
							: 'Some earlier messages are outside the live window. Your reading position needs attention.'}
					</output>
				)}

				{view && (
					<HistoryNavigation
						reader={reader}
						state={historyState}
						question={!!question}
						available={!!connected}
						open={openHistory}
						latest={latestHistory}
						move={moveHistory}
					/>
				)}
				<div className="remote-reading-area">
					{!rail && infoOpen && (
						<RemoteInformation
							state={information.state}
							current={currentConversation}
							headingRef={infoHeading}
							mobile
						/>
					)}
					<div
						ref={scroll}
						className="remote-transcript"
						inert={infoOpen && !rail}
						onScroll={rememberReading}
						// biome-ignore lint/a11y/noNoninteractiveTabindex: keyboard users need to scroll the reading region without focusing the composer.
						tabIndex={0}
						aria-label="Conversation messages"
					>
						{view &&
							connected &&
							(!historyState.issue || historyState.issue === 'disconnected') &&
							!historyState.current &&
							!historyState.browsing && (
								<div className="remote-history-entry">
									<Btn ref={historyEntry} tone="ghost" onClick={openHistory}>
										Load earlier messages
									</Btn>
								</div>
							)}
						{!view && (
							<p className="remote-note">
								{historyState.issue === 'access-ended' || information.state.status === 'access-ended'
									? 'Access ended. Earlier messages have been cleared.'
									: 'Loading conversation…'}
							</p>
						)}
						<HistoryRangeNote state={historyState} />
						{view &&
							(historyPage ? (
								<HistoryMessages records={historyPage.records} showActivity={showActivity} />
							) : (
								<Messages messages={messages ?? EMPTY_MESSAGES} showActivity={showActivity} />
							))}
						{historyPage &&
							!historyPage.records.some(
								record => record.kind === 'message' && isMessageVisible(record.message, showActivity),
							) && (
								<p className="remote-note">
									No visible conversation messages in this range. Continue with Older or Newer, or show tool activity in
									Conversation options.
								</p>
							)}
						{view &&
							connected &&
							(view.activity === 'working' ||
								(view.activity === 'idle' && remoteActivityAvailable(freshSubagents) && freshSubagents.active)) &&
							!historyState.browsing && (
								<div className="remote-working">
									<ActivityIndicator label={view.activity === 'working' ? 'Pi is working' : 'Subagents are active'} />
									<span className="activity-indicator-label">
										{view.activity === 'working' ? 'Working…' : 'Subagents active…'}
									</span>
								</div>
							)}
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
					{(questionJump || (!question && (!following || historyState.browsing))) && (
						<div className="remote-jump" inert={infoOpen && !rail}>
							{questionJump && (
								<Btn className="remote-jump-button" onClick={answerQuestion}>
									<RemoteArrow direction="down" />
									Answer question
								</Btn>
							)}
							{!question && (!following || historyState.browsing) && (
								<Btn className="remote-jump-button" onClick={latestHistory}>
									<RemoteArrow direction="down" /> Jump to latest
								</Btn>
							)}
						</div>
					)}
				</div>
				<footer className={`remote-composer${expandedImageQuestion ? ' remote-compact-image-question' : ''}`}>
					<InformationFooter
						state={information.state}
						source={sessionPresentation.source}
						modelFallback={detailModel}
					/>
					{((operation && operation.status !== 'dispatched') || transfer || recovery || draft.transferFailure) && (
						<output className="remote-receipt">
							{transfer && (
								<span>
									Uploading {draft.recovery?.images.length ?? 0}{' '}
									{draft.recovery?.images.length === 1 ? 'image' : 'images'} before sending…
								</span>
							)}
							{operation && operation.status !== 'dispatched' && <span>{RECEIPT_COPY[operation.status]}</span>}
							{draft.transferFailure && <span>{draft.transferFailure.message}</span>}
							{operation?.status === 'unknown' && (
								<>
									<Btn onClick={() => void check(operation.command)}>Check status</Btn>
									<Btn
										onClick={() => {
											if (draft.operation?.command.commandId !== operation.command.commandId) return
											settlePrompt(draft, operation.command.commandId, 'rejected')
											draft.operation = undefined
											refresh()
										}}
									>
										I’ve checked the conversation
									</Btn>
								</>
							)}
							{recovery && (
								<>
									<span>
										Submitted{' '}
										{recovery.images.length
											? `bundle with ${recovery.images.length} ${recovery.images.length === 1 ? 'image' : 'images'}`
											: 'message'}{' '}
										saved locally. Choose which draft to keep before sending.
									</span>
									<Btn
										onClick={() => {
											if (choosePrompt(draft, recovery, true)) refresh()
										}}
									>
										{promptHasContent(draft) ? 'Replace current draft' : 'Restore submitted message'}
									</Btn>
									<Btn
										onClick={() => {
											if (choosePrompt(draft, recovery, false)) refresh()
										}}
									>
										{promptHasContent(draft) ? 'Keep current draft' : 'Discard submitted message'}
									</Btn>
								</>
							)}
						</output>
					)}
					{question && (promptHasContent(draft) || promptExpanded) ? (
						<div className={`remote-draft-toggle${expandedImageQuestion ? ' remote-draft-toggle-image-expanded' : ''}`}>
							<span>
								{promptHasContent(draft)
									? `Message draft saved locally${attachedImages.length ? ` with ${attachedImages.length} ${attachedImages.length === 1 ? 'image' : 'images'}` : ''}`
									: 'Message draft'}
							</span>
							<Btn
								ref={draftToggleButton}
								ariaExpanded={promptExpanded}
								onClick={() => (promptExpanded ? collapsePromptDraft() : setPromptExpanded(true))}
							>
								{promptExpanded ? 'Hide draft' : 'Edit draft'}
							</Btn>
						</div>
					) : null}
					<div className={!question || promptExpanded ? 'remote-compose-surface' : 'remote-question-actions'}>
						{(!question || promptExpanded) && draft.failedSelection ? (
							<div className="remote-image-selection-error" role="alert">
								<span>{draft.failedSelection}</span>
								<Btn
									onClick={() => {
										draft.failedSelection = undefined
										refresh()
									}}
								>
									Discard failed selection
								</Btn>
							</div>
						) : (!question || promptExpanded) && preparingImages ? (
							<output className="remote-image-preparing">Preparing images… Existing attachments are unchanged.</output>
						) : (!question || promptExpanded) && attachedImages.length ? (
							<div className="remote-image-previews" aria-label="Attached images">
								{!imageInputAvailable && (
									<output className="remote-image-unavailable">
										{!view?.imageInput
											? 'Images need this conversation’s terminal to reload. Text still sends.'
											: 'Image input unavailable. Remove images or wait for support.'}
									</output>
								)}
								{attachedImages.map((image, index) => (
									<div className="remote-image-preview" key={image.localId}>
										<img src={image.objectUrl} alt={`Attachment ${index + 1}`} />
										<IconBtn
											label={`Remove attached image ${index + 1}`}
											onClick={() => {
												image.dispose()
												editPromptImages(
													draft,
													attachedImages.filter(value => value !== image),
												)
												refresh()
											}}
										>
											{GLYPH.close}
										</IconBtn>
									</div>
								))}
							</div>
						) : null}
						{(!question || promptExpanded) && (
							<label className="remote-prompt-field" htmlFor="remote-prompt">
								<span className="sr-only">Message</span>
								<textarea
									ref={attachPrompt}
									onCompositionStart={() => {
										composing.current = true
									}}
									onCompositionEnd={() => {
										composing.current = false
									}}
									id="remote-prompt"
									aria-label="Message"
									rows={1}
									maxLength={16384}
									value={draft.text}
									aria-keyshortcuts="Control+Enter Meta+Enter"
									onChange={event => {
										editPrompt(draft, event.target.value)
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
								<>
									<input
										ref={imageInput}
										type="file"
										hidden
										accept="image/png,image/jpeg"
										multiple
										disabled={imageInputDisabled}
										onChange={event => {
											const files = Array.from(event.target.files ?? [])
											event.target.value = ''
											void selectImages(files)
										}}
									/>
									<IconBtn
										// A disabled control with no reason is a dead end; say what would enable it.
										label={
											!imageInputAvailable && !view?.imageInput
												? 'Add images — needs this conversation’s terminal to reload'
												: 'Add images'
										}
										className="remote-add-images"
										disabled={imageInputDisabled}
										onClick={() => {
											const input = imageInput.current
											if (!input || input.disabled) return
											if (typeof input.showPicker === 'function') input.showPicker()
											else input.click()
										}}
									>
										{GLYPH.plus}
									</IconBtn>
									<MenuButton
										align="start"
										triggerLabel={`Message delivery: ${draft.delivery === 'steer' ? 'During work' : 'Follow-up'}`}
										triggerClass="icon-btn remote-mode-trigger"
										trigger={GLYPH.settings}
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
								</>
							)}
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
							{expandedImageQuestion && (
								<IconBtn className="remote-compact-hide-draft" label="Hide draft" onClick={collapsePromptDraft}>
									{GLYPH.chevronDown}
								</IconBtn>
							)}
							{question && infoOpen && !rail ? (
								<Btn className="remote-information-back" onClick={closeInfo}>
									Back to conversation
								</Btn>
							) : question ? (
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
									tone={promptHasContent(draft) ? 'primary' : 'quiet'}
									disabled={
										!connected ||
										!view?.capabilities.prompt ||
										!!unresolved ||
										!!recovery ||
										!!transfer ||
										preparingImages ||
										!!draft.failedSelection ||
										(attachedImages.length > 0 && !imageInputAvailable) ||
										!promptHasContent(draft)
									}
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
			</div>
			{rail && <RemoteInformation state={information.state} current={currentConversation} headingRef={infoHeading} />}
		</section>
	)
}

function isLegacyWholeToolActivity(message: TranscriptMessage) {
	if (message.role !== 'assistant' || message.toolCalls !== undefined) return false
	if (message.text.trim() && !message.text.startsWith('\nTool: ')) return false
	// Older bridges flatten tool calls into reserved `Tool: name` lines.
	// Hide only whole activity messages, never strip matching lines from prose/code.
	return message.text.split('\n').every(line => !line.trim() || /^Tool: [^\n]{1,100}$/.test(line))
}

function isActivityOnly(message: TranscriptMessage) {
	return (
		message.role === 'toolResult' ||
		(message.role === 'assistant' &&
			(message.toolCalls !== undefined ? !message.text.trim() : isLegacyWholeToolActivity(message)))
	)
}

function hasMeaningfulThinking(message: TranscriptMessage) {
	return message.role === 'assistant' && !!message.thinking && !!normalizeThinkingText(message.thinking).trim()
}

function isMessageVisible(message: TranscriptMessage, showActivity: boolean) {
	if (
		message.role === 'assistant' &&
		message.thinking &&
		!hasMeaningfulThinking(message) &&
		!message.text.trim() &&
		!message.toolCalls
	)
		return false
	return showActivity || hasMeaningfulThinking(message) || !isActivityOnly(message)
}

const Messages = memo(function Messages({
	messages,
	showActivity,
}: { messages: TranscriptMessage[]; showActivity: boolean }) {
	let speaker: TranscriptMessage['role'] | undefined
	return messages
		.filter(message => isMessageVisible(message, showActivity))
		.map(message => {
			const showAuthor = message.role !== 'toolResult' && message.role !== speaker
			if (message.role !== 'toolResult') speaker = message.role
			return <Message key={message.id} message={message} showActivity={showActivity} showAuthor={showAuthor} />
		})
})

const HistoryMessages = memo(function HistoryMessages({
	records,
	showActivity,
}: { records: HistoryRecord[]; showActivity: boolean }) {
	let speaker: TranscriptMessage['role'] | undefined
	return records.map(record => {
		if (record.kind === 'marker')
			return (
				<p className="remote-note" key={record.id} data-message-id={record.id}>
					{record.marker === 'compaction' ? 'Conversation compacted in Pi' : 'Branch summary in Pi'}
				</p>
			)
		const message = record.message
		if (!isMessageVisible(message, showActivity)) return null
		const showAuthor = message.role !== 'toolResult' && speaker !== message.role
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
		<article
			className="remote-message"
			data-message-id={message.id === 'current' ? undefined : message.id}
			data-continuation={!showAuthor || undefined}
		>
			{showAuthor && <h3 className="remote-message-author">{message.role === 'user' ? 'You' : 'Pi'}</h3>}
			{hasMeaningfulThinking(message) && (
				<fieldset className="remote-thinking" aria-label="Thinking">
					<div className="remote-thinking-text">{normalizeThinkingText(message.thinking ?? '')}</div>
				</fieldset>
			)}
			{showActivity && message.toolCalls && <RemoteDisclosure label="Tool calls" text={message.toolCalls} />}
			{message.role === 'toolResult' ? (
				<RemoteDisclosure label="Tool output" text={message.text} />
			) : message.role === 'assistant' ? (
				message.text && (
					<RemoteMarkdown text={showActivity || !isLegacyWholeToolActivity(message) ? message.text : ''} />
				)
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
