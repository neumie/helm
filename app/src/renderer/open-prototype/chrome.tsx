// Story-only window chrome variants for `helm open` (spec §Design variants A and B).
// Three ways to frame one viewer window, each in plain viewing and agent-bound feedback mode.
import { type ReactNode, useEffect, useMemo, useRef, useState } from 'react'
import { Btn } from '../button'
import { GLYPH, MenuButton } from '../sidebar/ui'
import './chrome.css'
import { FeedbackBubble } from './FeedbackBubble'
import './open.css'
import { RENDERERS } from './registry'
import type { FeedbackAnchor, FeedbackHost, ViewerFile, ViewerStatus } from './types'
import { anchorLabel, formatBytes, formatWord } from './types'

// ---------------------------------------------------------------------------
// Shared pieces

export type AgentState = 'listening' | 'working' | 'paused' | 'disconnected'

/** An agent conversation bound to this window (feedback mode). Null = plain viewing. */
export interface AgentBinding {
	provider: 'Claude' | 'Codex' | 'Pi' | 'Agent'
	/** Human conversation name, as the agent's `--label` or session title. */
	name: string
	state: AgentState
}

export interface Thread {
	id: string
	anchor: FeedbackAnchor | null
	intent: 'Ask' | 'Request change'
	text: string
	reply?: string
	state: 'sent' | 'replied' | 'working'
}

const STATE_WORD: Record<AgentState, string> = {
	listening: 'Listening',
	working: 'Working',
	paused: 'Feedback paused',
	disconnected: 'Disconnected',
}

/** Status glyph, colored by state; the word next to it carries the meaning (never color alone). */
export function AgentGlyph({ state }: { state: AgentState }) {
	const glyph = state === 'working' ? '✻' : state === 'disconnected' ? '¿' : state === 'paused' ? '◌' : '●'
	return (
		<span className={`open-agent-glyph open-agent-${state}`} aria-hidden="true">
			{glyph}
		</span>
	)
}

/** Story-only stand-in for the native macOS traffic lights inside the 90px reserve. */
export function TrafficLights() {
	return (
		<span className="open-traffic" aria-hidden="true">
			<i />
			<i />
			<i />
		</span>
	)
}

/** Extension tag in mono, colored by family like `ls --color` (the glyph is the only color). */
export function ExtTag({ file }: { file: ViewerFile }) {
	const ext = file.name.includes('.') ? (file.name.split('.').pop() ?? '') : ''
	return (
		<span className={`open-ext open-ext-${file.format}`} aria-hidden="true">
			{ext}
		</span>
	)
}

/** Middle-truncate a path so the file's own folder stays visible. */
export function shortPath(path: string, max = 48): string {
	if (path.length <= max) return path
	const keep = max - 1
	const head = Math.ceil(keep * 0.35)
	return `${path.slice(0, head)}…${path.slice(path.length - (keep - head))}`
}

/** Parent folder of a display path. */
function folderOf(path: string): string {
	const index = path.lastIndexOf('/')
	return index > 0 ? path.slice(0, index) : path
}

/** Renders the right renderer for the file from the registry. */
export function FileBody({
	file,
	zoom,
	onStatus,
	feedback,
}: {
	file: ViewerFile
	zoom?: number
	onStatus?: (status: ViewerStatus) => void
	feedback?: FeedbackHost | null
}) {
	const Renderer = RENDERERS[file.format]
	if (!Renderer)
		return (
			<div className="open-note">
				<b>No viewer for {formatWord(file)} yet</b>Open it in its default app with ⌘⇧D.
			</div>
		)
	return <Renderer key={file.url} file={file} zoom={zoom} onStatus={onStatus} feedback={feedback} />
}

/** Feedback host plus the bubble state shared by all bound variants. */
function useFeedback(bound: boolean, initial: FeedbackAnchor | null = null) {
	const [active, setActive] = useState<FeedbackAnchor | null>(initial)
	const [box, setBox] = useState<DOMRect | null>(null)
	const host = useMemo<FeedbackHost | null>(
		() =>
			bound
				? {
						active,
						onAnchor: (anchor, rect) => {
							setActive(anchor)
							setBox(rect)
						},
					}
				: null,
		[bound, active],
	)
	const clear = () => {
		setActive(null)
		setBox(null)
	}
	return { host, active, box, clear }
}

const SAMPLE_THREADS: Thread[] = [
	{
		id: 't1',
		anchor: { kind: 'pdf-text', page: 1, quote: 'p95 latency fell from 412 ms to 268 ms' },
		intent: 'Ask',
		text: 'Is this drop real, or is it the ARES cache warming up after the deploy?',
		reply:
			'Real. The cache landed on 14 October and p95 stayed under 280 ms for the rest of the month, including the re-verification batch on the 26th.',
		state: 'replied',
	},
	{
		id: 't2',
		anchor: { kind: 'pdf-region', page: 1, rect: { x: 0.1, y: 0.47, width: 0.8, height: 0.24 } },
		intent: 'Request change',
		text: 'Sort this by October only, not the year to date.',
		state: 'working',
	},
]

/** A composer row shared by the variants: text, intent, Send. Prototype only (no admission). */
function Composer({ placeholder, compact }: { placeholder: string; compact?: boolean }) {
	const [text, setText] = useState('')
	const [intent, setIntent] = useState<'Ask' | 'Request change'>('Ask')
	return (
		<div className={`open-composer${compact ? ' open-composer-compact' : ''}`}>
			<textarea
				className="open-composer-field"
				placeholder={placeholder}
				aria-label="Feedback"
				rows={compact ? 1 : 2}
				value={text}
				onChange={event => setText(event.target.value)}
			/>
			<div className="open-composer-actions">
				<MenuButton
					align="start"
					trigger={
						<span className="open-intent">
							{intent}
							{GLYPH.chevronDown}
						</span>
					}
					triggerLabel={`Intent: ${intent}`}
					triggerClass="btn btn-ghost btn-sm"
					entries={(['Ask', 'Request change'] as const).map(entry => ({
						label: entry,
						checked: entry === intent,
						onSelect: () => setIntent(entry),
					}))}
				/>
				<Btn sm tone={text.trim() ? 'primary' : 'quiet'} disabled={!text.trim()} ariaKeyShortcuts="Meta+Enter">
					Send
				</Btn>
			</div>
		</div>
	)
}

function ThreadEntry({ thread }: { thread: Thread }) {
	const label = thread.anchor ? anchorLabel(thread.anchor) : { place: 'Whole file' }
	return (
		<article className="open-thread">
			<div className="open-thread-meta">
				<span>{label.place}</span>
				{label.literal ? <span className="open-mono">{label.literal}</span> : null}
				<span className="open-thread-intent">{thread.intent}</span>
			</div>
			<p className="open-thread-text">{thread.text}</p>
			{thread.reply ? (
				<p className="open-thread-reply">
					<span className="open-thread-mark" aria-hidden="true">
						●
					</span>
					{thread.reply}
				</p>
			) : thread.state === 'working' ? (
				<p className="open-thread-working">
					<span className="open-agent-glyph open-agent-working" aria-hidden="true">
						✻
					</span>
					Working…
				</p>
			) : null}
		</article>
	)
}

// ---------------------------------------------------------------------------
// A1 — Title row: one 40px row (reserve, ext tag, name, path), icon actions on the right,
// agent state as a glyph + words that opens a right-hand companion.

export function ChromeTitleRow({
	file,
	agent = null,
	initialAnchor = null,
	companionOpen = true,
	tabs,
}: {
	file: ViewerFile
	agent?: AgentBinding | null
	initialAnchor?: FeedbackAnchor | null
	companionOpen?: boolean
	/** B1 passes a tab strip that replaces the name/path block. */
	tabs?: ReactNode
}) {
	const [status, setStatus] = useState<ViewerStatus>({})
	const [open, setOpen] = useState(companionOpen)
	const feedback = useFeedback(agent !== null, initialAnchor)
	return (
		<div className="open-stage open-a1">
			<header className="open-a1-head">
				<TrafficLights />
				{tabs ?? (
					<div className="open-a1-identity">
						<ExtTag file={file} />
						<h1 className="open-a1-name">{file.name}</h1>
						<span className="open-a1-path" title={file.path}>
							{shortPath(folderOf(file.path), 44)}
						</span>
					</div>
				)}
				<div className="open-a1-actions">
					{status.position ? <span className="open-a1-position">{status.position}</span> : null}
					<button type="button" className="icon-btn" aria-label="Find" title="Find  ⌘F">
						<SearchGlyph />
					</button>
					<button
						type="button"
						className="icon-btn"
						aria-label="Open with default app"
						title="Open with default app  ⌘⇧D"
					>
						{GLYPH.external}
					</button>
					<MenuButton
						triggerLabel="File options"
						triggerClass="icon-btn"
						trigger={GLYPH.ellipsis}
						entries={[
							{ label: 'Show in Finder', onSelect: () => {} },
							{ label: 'Copy path', onSelect: () => {} },
							{ label: 'Print…', onSelect: () => {} },
							{ label: 'Details', onSelect: () => {}, group: true },
						]}
					/>
					{agent ? (
						<button
							type="button"
							className={`open-a1-agent${open ? ' open-a1-agent-open' : ''}`}
							aria-pressed={open}
							onClick={() => setOpen(value => !value)}
							title={`${agent.name} — ${STATE_WORD[agent.state]}`}
						>
							<AgentGlyph state={agent.state} />
							<span>{agent.provider}</span>
							<span className="open-a1-agent-state">{STATE_WORD[agent.state]}</span>
						</button>
					) : null}
				</div>
			</header>
			<div className="open-body">
				<FileBody file={file} onStatus={setStatus} feedback={feedback.host} />
				{agent && open ? (
					<aside className="open-companion" aria-label="Conversation">
						<div className="open-companion-head">
							<div className="open-companion-name">{agent.name}</div>
							<div className="open-companion-sub">
								<AgentGlyph state={agent.state} />
								{agent.provider} · {STATE_WORD[agent.state]}
							</div>
						</div>
						<div className="open-companion-threads">
							{SAMPLE_THREADS.map(thread => (
								<ThreadEntry key={thread.id} thread={thread} />
							))}
						</div>
						<Composer placeholder="Ask about the whole file" />
					</aside>
				) : null}
				{feedback.active && feedback.box ? (
					<FeedbackBubble anchor={feedback.active} box={feedback.box} onClose={feedback.clear} />
				) : null}
			</div>
		</div>
	)
}

// ---------------------------------------------------------------------------
// A2 — Status line: the window top is only the drag strip with the centered name (macOS
// title). Everything else lives in a 24px tmux-like status line at the bottom; the agent
// conversation is an in-flow pane that splits off above it, like the agent dock.

export function ChromeStatusLine({
	file,
	agent = null,
	initialAnchor = null,
	paneOpen = true,
}: {
	file: ViewerFile
	agent?: AgentBinding | null
	initialAnchor?: FeedbackAnchor | null
	paneOpen?: boolean
}) {
	const [status, setStatus] = useState<ViewerStatus>({})
	const [open, setOpen] = useState(paneOpen)
	const feedback = useFeedback(agent !== null, initialAnchor)
	return (
		<div className="open-stage open-a2">
			<header className="open-a2-head">
				<TrafficLights />
				<h1 className="open-a2-title">{file.name}</h1>
			</header>
			<div className="open-body">
				<FileBody file={file} onStatus={setStatus} feedback={feedback.host} />
				{feedback.active && feedback.box ? (
					<FeedbackBubble anchor={feedback.active} box={feedback.box} onClose={feedback.clear} />
				) : null}
			</div>
			{agent && open ? (
				<section className="open-a2-pane" aria-label="Conversation">
					<div className="open-a2-pane-threads">
						{SAMPLE_THREADS.map(thread => (
							<ThreadEntry key={thread.id} thread={thread} />
						))}
					</div>
					<Composer placeholder="Ask about the whole file" compact />
				</section>
			) : null}
			<footer className="open-a2-status" aria-label="Status">
				{agent ? (
					<button
						type="button"
						className="open-a2-seg open-a2-agent"
						aria-pressed={open}
						onClick={() => setOpen(value => !value)}
						title={agent.name}
					>
						<AgentGlyph state={agent.state} />
						{agent.provider} {STATE_WORD[agent.state].toLowerCase()}
						<span className="open-a2-dim">· 2 threads</span>
					</button>
				) : null}
				<span className="open-a2-seg">
					<ExtTag file={file} />
				</span>
				<span className="open-a2-seg open-a2-path" title={file.path}>
					{shortPath(file.path, 60)}
				</span>
				<span className="open-a2-seg open-a2-dim">{formatBytes(file.size)}</span>
				<span className="open-a2-fill" />
				{status.position ? <span className="open-a2-seg">{status.position}</span> : null}
				{status.facts?.slice(0, 2).map(fact => (
					<span key={fact} className="open-a2-seg open-a2-dim">
						{fact}
					</span>
				))}
				<span className="open-a2-seg open-a2-keys">
					⌘F find <span>⌘⇧D open with</span>
					{agent ? <span>⌘⇧J conversation</span> : null}
				</span>
			</footer>
		</div>
	)
}

// ---------------------------------------------------------------------------
// A3 — Breadcrumb: a 44px header with the path as clickable folders and the name last,
// actions as text keys. Feedback lives in a margin beside the content: one entry per
// anchor in reading order, no chat column.

export function ChromeBreadcrumb({
	file,
	agent = null,
	initialAnchor = null,
}: {
	file: ViewerFile
	agent?: AgentBinding | null
	initialAnchor?: FeedbackAnchor | null
}) {
	const [status, setStatus] = useState<ViewerStatus>({})
	const feedback = useFeedback(agent !== null, initialAnchor)
	const parts = folderOf(file.path).split('/')
	return (
		<div className="open-stage open-a3">
			<header className="open-a3-head">
				<TrafficLights />
				<nav className="open-a3-crumbs" aria-label="Path">
					{parts.map((part, index) => (
						<span key={parts.slice(0, index + 1).join('/')} className="open-a3-crumb">
							<button
								type="button"
								className="open-a3-folder"
								title={`Show ${parts.slice(0, index + 1).join('/')} in Finder`}
							>
								{part}
							</button>
							<span className="open-a3-sep" aria-hidden="true">
								/
							</span>
						</span>
					))}
					<h1 className="open-a3-name">{file.name}</h1>
				</nav>
				<span className="open-a3-format">{formatWord(file)}</span>
				<div className="open-a3-keys">
					<button type="button" className="open-a3-key">
						Find <kbd>⌘F</kbd>
					</button>
					<button type="button" className="open-a3-key">
						{status.position ?? 'Fit'}
					</button>
					<button type="button" className="open-a3-key">
						Open with <kbd>⌘⇧D</kbd>
					</button>
				</div>
			</header>
			{agent ? (
				<div className="open-a3-agentline">
					<AgentGlyph state={agent.state} />
					<span>
						{agent.name}{' '}
						<span className="open-a3-dim">
							· {agent.provider} · {STATE_WORD[agent.state]}
						</span>
					</span>
					<span className="open-a3-dim open-a3-hint">Select anything to comment</span>
				</div>
			) : null}
			<div className="open-body">
				<FileBody file={file} onStatus={setStatus} feedback={feedback.host} />
				{agent ? (
					<aside className="open-a3-margin" aria-label="Feedback in this file">
						{SAMPLE_THREADS.map(thread => (
							<ThreadEntry key={thread.id} thread={thread} />
						))}
						<div className="open-a3-whole">
							<Composer placeholder="Comment on the whole file" />
						</div>
					</aside>
				) : null}
				{feedback.active && feedback.box ? (
					<FeedbackBubble anchor={feedback.active} box={feedback.box} onClose={feedback.clear} />
				) : null}
			</div>
		</div>
	)
}

// ---------------------------------------------------------------------------
// B — several files

/** B1: tabs in the title row (A1 frame). */
export function MultiTabs({ files, agent = null }: { files: ViewerFile[]; agent?: AgentBinding | null }) {
	const [current, setCurrent] = useState(0)
	const file = files[current] ?? files[0]
	if (!file) return null
	const strip = (
		<div className="open-tabs" role="tablist" aria-label="Open files">
			{files.map((entry, index) => (
				<button
					key={entry.url}
					type="button"
					role="tab"
					aria-selected={index === current}
					className={`open-tab${index === current ? ' open-tab-active' : ''}`}
					onClick={() => setCurrent(index)}
					title={entry.path}
				>
					<ExtTag file={entry} />
					{/* The extension tag already names the type, so the tab shows the stem only. */}
					<span className="open-tab-name">{entry.name.replace(/\.[^.]+$/, '')}</span>
					{index < 9 ? <span className="open-tab-key">⌘{index + 1}</span> : null}
				</button>
			))}
		</div>
	)
	return <ChromeTitleRow key={file.url} file={file} agent={agent} tabs={strip} companionOpen={false} />
}

/** B2: one window per file; ⌘⇧O lists open windows and recent files (detached palette). */
export function MultiWindows({ files }: { files: ViewerFile[] }) {
	const file = files[0]
	const [query, setQuery] = useState('')
	const inputRef = useRef<HTMLInputElement>(null)
	useEffect(() => inputRef.current?.focus(), [])
	if (!file) return null
	const match = (entry: ViewerFile) => entry.name.toLowerCase().includes(query.toLowerCase())
	const openWindows = files.slice(0, 4).filter(match)
	const recent = files.slice(4).filter(match)
	return (
		<div className="open-b2">
			<ChromeTitleRow file={file} />
			<div className="open-b2-scrim" />
			<section className="open-palette" aria-label="Go to file">
				<input
					ref={inputRef}
					className="open-palette-field"
					placeholder="Go to file"
					value={query}
					onChange={event => setQuery(event.target.value)}
				/>
				<div className="open-palette-list">
					<div className="open-palette-section">Open windows</div>
					{openWindows.map((entry, index) => (
						<button
							key={entry.url}
							type="button"
							aria-current={index === 1 ? 'true' : undefined}
							className={`open-palette-row${index === 1 ? ' open-palette-row-active' : ''}`}
						>
							<ExtTag file={entry} />
							<span className="open-palette-name">{entry.name}</span>
							<span className="open-palette-path">{shortPath(folderOf(entry.path), 36)}</span>
							{index === 0 ? <span className="open-palette-note">This window</span> : null}
						</button>
					))}
					<div className="open-palette-section">Recent</div>
					{recent.map(entry => (
						<button key={entry.url} type="button" className="open-palette-row">
							<ExtTag file={entry} />
							<span className="open-palette-name">{entry.name}</span>
							<span className="open-palette-path">{shortPath(folderOf(entry.path), 36)}</span>
							<span className="open-palette-note">{entry.modified}</span>
						</button>
					))}
				</div>
				<div className="open-palette-keys">
					<span>↑↓ choose</span>
					<span>↵ open</span>
					<span>⌘↵ open beside</span>
					<span>esc close</span>
				</div>
			</section>
		</div>
	)
}

/** B3: a file list on the left, grouped by folder, the viewer on the right (A1-like header). */
export function MultiSidebar({ files, agent = null }: { files: ViewerFile[]; agent?: AgentBinding | null }) {
	const [current, setCurrent] = useState(0)
	const [status, setStatus] = useState<ViewerStatus>({})
	const file = files[current] ?? files[0]
	const groups = useMemo(() => {
		const map = new Map<string, { file: ViewerFile; index: number }[]>()
		files.forEach((entry, index) => {
			const folder = folderOf(entry.path)
			map.set(folder, [...(map.get(folder) ?? []), { file: entry, index }])
		})
		return [...map.entries()]
	}, [files])
	if (!file) return null
	return (
		<div className="open-stage open-b3">
			<div className="open-b3-split">
				<nav className="open-b3-list" aria-label="Open files">
					<div className="open-b3-list-head">
						<TrafficLights />
					</div>
					<div className="open-b3-scroll">
						{groups.map(([folder, entries]) => (
							<section key={folder} className="open-b3-group">
								<h2 className="open-b3-folder" title={folder}>
									{shortPath(folder, 30)}
								</h2>
								{entries.map(({ file: entry, index }) => (
									<button
										key={entry.url}
										type="button"
										className={`open-b3-row${index === current ? ' open-b3-row-active' : ''}`}
										aria-current={index === current ? 'true' : undefined}
										onClick={() => setCurrent(index)}
									>
										<ExtTag file={entry} />
										<span className="open-b3-name">{entry.name}</span>
										<span className="open-b3-meta">{entry.modified}</span>
									</button>
								))}
							</section>
						))}
					</div>
					<div className="open-b3-foot">
						<span>{files.length} files</span>
						<span>⌘O open</span>
					</div>
				</nav>
				<div className="open-b3-main">
					<header className="open-b3-head">
						<h1 className="open-a1-name">{file.name}</h1>
						<span className="open-a1-path">{formatWord(file)}</span>
						<span className="open-a1-path">{formatBytes(file.size)}</span>
						<div className="open-a1-actions">
							{status.position ? <span className="open-a1-position">{status.position}</span> : null}
							<button type="button" className="icon-btn" aria-label="Find" title="Find  ⌘F">
								<SearchGlyph />
							</button>
							<button
								type="button"
								className="icon-btn"
								aria-label="Open with default app"
								title="Open with default app  ⌘⇧D"
							>
								{GLYPH.external}
							</button>
							{agent ? (
								<span className="open-a1-agent">
									<AgentGlyph state={agent.state} />
									<span>{agent.provider}</span>
									<span className="open-a1-agent-state">{STATE_WORD[agent.state]}</span>
								</span>
							) : null}
						</div>
					</header>
					<div className="open-body">
						<FileBody key={file.url} file={file} onStatus={setStatus} />
					</div>
				</div>
			</div>
		</div>
	)
}

/** Heroicons micro magnifying glass (MIT), 16px native. */
function SearchGlyph() {
	return (
		<svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
			<path
				fillRule="evenodd"
				d="M9.965 11.026a5 5 0 1 1 1.06-1.06l2.755 2.754a.75.75 0 1 1-1.06 1.06l-2.755-2.754ZM10.5 7a3.5 3.5 0 1 1-7 0 3.5 3.5 0 0 1 7 0Z"
				clipRule="evenodd"
			/>
		</svg>
	)
}
