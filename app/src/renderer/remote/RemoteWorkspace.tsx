import { memo, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type {
	RemoteCommand,
	RemoteDirectory,
	RemoteReceipt,
	RemoteSnapshot,
	RemoteSummary,
} from '../../../../src/remote/protocol.js'
import { REMOTE_PROTOCOL, sameRemoteTarget } from '../../../../src/remote/protocol.js'
import { Btn } from '../button.js'
import { Disclosure } from '../sidebar/ui.js'
import { RemoteAccessError, type RemoteTransport } from './transport.js'
import { useRemotePoll } from './use-poll.js'
import './remote.css'

type Operation = { command: RemoteCommand; status: RemoteReceipt['status'] | 'sending' }
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
	operation?: Operation
}
const newDraft = (): Draft => ({ text: '', delivery: 'steer', reading: { following: true, top: 0 } })
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
	const directory = useRemotePoll(read)
	if (directory.error === 401)
		return (
			<main className="remote-empty">
				<h1>Access ended</h1>
				<p>Reconnect with a current access token. Local Pi sessions keep running.</p>
				{onReconnect && <Btn onClick={onReconnect}>Connect again</Btn>}
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
	const identity = (session: RemoteSummary) =>
		`${directory.hostEpoch}:${session.target.scopeId ?? 'personal'}:${session.target.generation}:${session.target.sessionId}:${session.target.incarnation}`
	const [selected, setSelected] = useState<string | null>(null)
	const [query, setQuery] = useState('')
	const [scope, setScope] = useState('all')
	const drafts = useRef(new Map<string, Draft>())
	const directoryRef = useRef<HTMLElement>(null)
	const session = directory.sessions.find(value => identity(value) === selected)
	const selectedDraft = selected ? drafts.current.get(selected) : undefined
	const visible = directory.sessions.filter(value => {
		const matchesScope = scope === 'all' || scope === (value.target.scopeId ?? 'personal')
		return (
			matchesScope &&
			`${value.label} ${value.workspace} ${value.model ?? ''}`.toLowerCase().includes(query.toLowerCase())
		)
	})
	function select(value: RemoteSummary) {
		const key = identity(value)
		if (!drafts.current.has(key)) drafts.current.set(key, newDraft())
		setSelected(key)
	}
	function back() {
		const prior = selected
		setSelected(null)
		requestAnimationFrame(() =>
			directoryRef.current?.querySelector<HTMLButtonElement>(`[data-session-key="${prior}"]`)?.focus(),
		)
	}
	return (
		<main className="remote-workspace" data-open={!!session}>
			<aside ref={directoryRef} className="remote-directory" aria-label="Session directory">
				<header className="remote-header">
					<h1>Helm Remote</h1>
				</header>
				<div className="remote-filters">
					<label htmlFor="remote-search">Find a session</label>
					<input id="remote-search" type="search" value={query} onChange={event => setQuery(event.target.value)} />
					<label htmlFor="remote-scope">Viewing scope</label>
					<select id="remote-scope" value={scope} onChange={event => setScope(event.target.value)}>
						<option value="all">All authorized scopes</option>
						{[...new Set(directory.sessions.map(value => value.target.scopeId ?? 'personal'))].map(id => (
							<option key={id} value={id}>
								{id === 'personal' ? 'Personal' : `Profile ${id.slice(0, 8)}`}
							</option>
						))}
					</select>
				</div>
				<p className="remote-note">
					Enrolled terminal sessions only. Historical and unconnected sessions are not indexed yet.
				</p>
				{!available && (
					<output className="remote-notice">
						Disconnected — showing last known sessions. No commands will be sent.
					</output>
				)}
				<nav className="remote-session-list" aria-label="Sessions">
					{visible.map(value => (
						<button
							key={identity(value)}
							type="button"
							className="remote-session-row"
							data-session-key={identity(value)}
							aria-current={selected === identity(value) ? 'page' : undefined}
							onClick={() => select(value)}
						>
							<strong>{value.label}</strong>
							<span>
								{value.workspace} · {value.connected && available ? value.activity : 'disconnected'}
							</span>
						</button>
					))}
					{visible.length === 0 && (
						<p className="remote-note">No matching sessions. Clear the filter or enroll a terminal locally.</p>
					)}
				</nav>
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
	const detail = useRemotePoll(read, 1000)
	const view = detail.value?.snapshot
	const question = view?.question
	const [gap, setGap] = useState(false)
	const scroll = useRef<HTMLDivElement>(null)
	const heading = useRef<HTMLHeadingElement>(null)
	const lifecycle = useRef<AbortController | null>(null)
	const restored = useRef(false)
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
	useEffect(() => {
		heading.current?.focus()
		const abort = new AbortController()
		lifecycle.current = abort
		return () => abort.abort()
	}, [])
	useLayoutEffect(() => {
		const pane = scroll.current
		if (!pane || !view) return
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
	}, [view, draft])
	function rememberReading() {
		const pane = scroll.current
		if (!pane) return
		const top = pane.getBoundingClientRect().top
		const anchor = [...pane.querySelectorAll<HTMLElement>('[data-message-id]')].find(
			node => node.getBoundingClientRect().bottom > top,
		)
		draft.reading = {
			following: pane.scrollHeight - pane.scrollTop - pane.clientHeight < 32,
			top: pane.scrollTop,
			anchor: anchor?.dataset.messageId,
			offset: anchor ? anchor.getBoundingClientRect().top - top : undefined,
		}
		refresh()
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
		if (!view || !connected || unresolved || !signal) return
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
	return (
		<section className="remote-conversation" aria-label="Conversation">
			<header className="remote-header">
				<Btn tone="ghost" onClick={onBack}>
					Sessions
				</Btn>
				<h2 ref={heading} tabIndex={-1}>
					{session.label}
				</h2>
			</header>
			<div className="remote-meta">
				{session.workspace} · {view?.model ?? session.model ?? 'Model unknown'} ·{' '}
				{connected ? view?.activity : 'disconnected'}
			</div>
			{(!connected || gap || view?.historyTruncated) && (
				<output className="remote-notice">
					{!connected
						? 'Disconnected or refreshing — controls are unavailable.'
						: 'Showing a bounded live window, not full history. Earlier content remains in Pi.'}
				</output>
			)}
			<div
				ref={scroll}
				className="remote-transcript"
				onScroll={rememberReading}
				// biome-ignore lint/a11y/noNoninteractiveTabindex: keyboard users need to scroll the reading region without focusing the composer.
				tabIndex={0}
				aria-label="Conversation messages"
			>
				{!view && <p className="remote-note">Loading conversation…</p>}
				{view?.messages.map(message => (
					<Message key={message.id} message={message} />
				))}
				{question && (
					<Question
						key={question.requestId}
						question={question}
						disabled={!connected || !!unresolved}
						onAnswer={answers => void send({ kind: 'answer', requestId: question.requestId, answers })}
					/>
				)}
				{view?.activity === 'waiting' && !view.question && (
					<p className="remote-notice">
						This dialog needs the original terminal. Remote does not support this custom UI.
					</p>
				)}
			</div>
			{!draft.reading.following && (
				<div className="remote-jump">
					<Btn
						onClick={() => {
							draft.reading.following = true
							if (scroll.current) scroll.current.scrollTop = scroll.current.scrollHeight
							setGap(false)
							refresh()
						}}
					>
						Jump to latest
					</Btn>
				</div>
			)}
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
				<label htmlFor="remote-prompt">Message</label>
				<textarea
					id="remote-prompt"
					rows={3}
					maxLength={16384}
					value={draft.text}
					onChange={event => {
						draft.text = event.target.value
						refresh()
					}}
					placeholder="Continue this conversation"
				/>
				<div className="remote-composer-actions">
					<label>
						Delivery
						<select
							aria-label="Message delivery"
							value={draft.delivery}
							onChange={event => {
								draft.delivery = event.target.value as Draft['delivery']
								refresh()
							}}
						>
							<option value="steer">Steer at the next safe point</option>
							<option value="followUp">Follow up after this work</option>
						</select>
					</label>
					{view?.question ? null : (
						<Btn
							tone="primary"
							disabled={!connected || !view?.capabilities.prompt || !!unresolved || !draft.text.trim()}
							onClick={() => void send({ kind: 'prompt', text: draft.text.trim(), delivery: draft.delivery })}
						>
							Send
						</Btn>
					)}
					<Btn
						disabled={!connected || !view?.capabilities.interrupt || !!unresolved || view?.activity === 'idle'}
						onClick={() => void send({ kind: 'interrupt' })}
					>
						Interrupt
					</Btn>
				</div>
				<p className="remote-note">
					Interrupt requests an abort; Pi may still run queued follow-ups. No terminal keys or shell commands are
					forwarded.
				</p>
			</footer>
		</section>
	)
}

const Message = memo(function Message({ message }: { message: RemoteSnapshot['messages'][number] }) {
	return (
		<article className="remote-message" data-message-id={message.id}>
			<h3>{message.role === 'user' ? 'You' : message.role === 'assistant' ? 'Pi' : 'Tool output'}</h3>
			{message.thinking && (
				<Disclosure heading="Thinking" label="Show" hideLabel="Hide">
					<pre>{message.thinking}</pre>
				</Disclosure>
			)}
			{message.role === 'toolResult' ? (
				<Disclosure heading="Result" label="Show" hideLabel="Hide">
					<pre>{message.text}</pre>
				</Disclosure>
			) : (
				<p>{message.text}</p>
			)}
			{message.truncated && <p className="remote-note">Preview truncated. Full output remains in Pi.</p>}
		</article>
	)
})

type Answer = Extract<RemoteCommand['operation'], { kind: 'answer' }>['answers'][number]
function Question({
	question,
	disabled,
	onAnswer,
}: { question: NonNullable<RemoteSnapshot['question']>; disabled: boolean; onAnswer: (answers: Answer[]) => void }) {
	const [answers, setAnswers] = useState<Array<Answer | null>>(() =>
		question.questions.map(value => (value.multiSelect ? { options: [] } : null)),
	)
	const set = (index: number, answer: Answer) =>
		setAnswers(previous => previous.map((value, key) => (key === index ? answer : value)))
	const complete = answers.every(answer => answer !== null && (!('text' in answer) || answer.text.trim()))
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
			<Btn
				tone="primary"
				disabled={disabled || !complete}
				onClick={() => {
					if (complete) onAnswer(answers as Answer[])
				}}
			>
				Submit answers
			</Btn>
		</section>
	)
}
