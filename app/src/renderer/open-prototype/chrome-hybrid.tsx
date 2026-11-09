// Story-only A1 × A3 hybrids for the `helm open` window chrome (spec §Design exploration, A4–A6).
// Every hybrid keeps A1's single 40px title row and its bound model (an agent button in the row that
// toggles the conversation column), so they differ only in how the file name and its path sit together.
import { type ReactNode, useState } from 'react'
import { GLYPH, MenuButton } from '../sidebar/ui'
import {
	type AgentBinding,
	AgentGlyph,
	Composer,
	ExtTag,
	FileBody,
	SAMPLE_THREADS,
	STATE_WORD,
	SearchGlyph,
	ThreadEntry,
	TrafficLights,
	useFeedback,
} from './chrome'
import './chrome-hybrid.css'
import { FeedbackBubble } from './FeedbackBubble'
import type { ViewerFile, ViewerStatus } from './types'

export type HybridVariant = 'path-first' | 'name-first' | 'collapsing'

/** Folders of a display path, each with the full path it stands for. */
function folders(path: string): { name: string; full: string }[] {
	const index = path.lastIndexOf('/')
	if (index <= 0) return []
	const parts = path.slice(0, index).split('/')
	return parts.map((name, at) => ({ name, full: parts.slice(0, at + 1).join('/') }))
}

/** Clickable dim folders; every folder reveals itself in Finder. `trailing` puts the separator first. */
function Crumbs({ path, trailing, className }: { path: string; trailing?: boolean; className?: string }) {
	const list = folders(path)
	return (
		<nav className={`hy-crumbs${className ? ` ${className}` : ''}`} aria-label="Path">
			{list.map((folder, index) => [
				// Narrow A4 keeps the first folder and the last two; this "…" stands for the ones between.
				index === 1 && list.length > 3 ? (
					<span key="gap" className="hy-gap" aria-hidden="true">
						<span className="hy-gap-dots">…</span>
						<span className="hy-sep">/</span>
					</span>
				) : null,
				<span
					key={folder.full}
					className="hy-crumb"
					data-last={index === list.length - 1 || undefined}
					data-middle={(index > 0 && index < list.length - 2) || undefined}
				>
					{trailing && index > 0 ? (
						<span className="hy-sep" aria-hidden="true">
							/
						</span>
					) : null}
					<button type="button" className="hy-folder" title={`Show ${folder.full} in Finder`}>
						{folder.name}
					</button>
					{trailing ? null : (
						<span className="hy-sep" aria-hidden="true">
							/
						</span>
					)}
				</span>,
			])}
		</nav>
	)
}

/** A6 narrow: the whole path folded into one "…" menu before the name. */
function FoldedPath({ path }: { path: string }) {
	const list = folders(path)
	return (
		<span className="hy-folded">
			<MenuButton
				align="start"
				triggerLabel={`Path: ${list.map(folder => folder.name).join('/')}`}
				triggerClass="hy-folder hy-fold-trigger"
				trigger={GLYPH.ellipsis}
				entries={[...list].reverse().map(folder => ({
					label: `Show ${folder.full} in Finder`,
					onSelect: () => {},
				}))}
			/>
			<span className="hy-sep" aria-hidden="true">
				/
			</span>
		</span>
	)
}

function IconActions({ position }: { position?: string }) {
	return (
		<>
			{position ? <span className="hy-position">{position}</span> : null}
			<button type="button" className="icon-btn" aria-label="Find" title="Find  ⌘F">
				<SearchGlyph />
			</button>
			<button type="button" className="icon-btn" aria-label="Open with default app" title="Open with default app  ⌘⇧D">
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
		</>
	)
}

function KeyActions({ position }: { position?: string }) {
	return (
		<>
			<button type="button" className="hy-key" aria-keyshortcuts="Meta+F">
				Find <kbd>⌘F</kbd>
			</button>
			<button type="button" className="hy-key">
				{position ?? 'Fit'}
			</button>
			<button type="button" className="hy-key" aria-keyshortcuts="Meta+Shift+D">
				Open with <kbd>⌘⇧D</kbd>
			</button>
		</>
	)
}

/** The name, prominent in every hybrid. */
function Name({ file }: { file: ViewerFile }) {
	return (
		<h1 className="hy-name" title={file.path}>
			{file.name}
		</h1>
	)
}

/** One 40px title row. The identity block is what the three hybrids vary. */
export function HybridHeader({
	variant,
	file,
	agent = null,
	position,
	open = false,
	onToggle,
}: {
	variant: HybridVariant
	file: ViewerFile
	agent?: AgentBinding | null
	position?: string
	open?: boolean
	onToggle?: () => void
}) {
	let identity: ReactNode
	if (variant === 'path-first')
		// A4: A3's reading order (folders, then the name last) in A1's single row.
		identity = (
			<div className="hy-identity hy-a4">
				<ExtTag file={file} />
				<Crumbs path={file.path} className="hy-a4-crumbs" />
				<Name file={file} />
			</div>
		)
	else if (variant === 'name-first')
		// A5: A1's order (name first), the path after it as a dim clickable breadcrumb. In a narrow window the
		// path steps aside and comes back while the pointer or focus is on the name.
		identity = (
			<div className="hy-identity hy-a5">
				<ExtTag file={file} />
				<Name file={file} />
				<Crumbs path={file.path} trailing className="hy-a5-crumbs" />
			</div>
		)
	// A6: the full breadcrumb when there is room; folded into "…" before the name when there is not.
	else
		identity = (
			<div className="hy-identity hy-a6">
				<ExtTag file={file} />
				<Crumbs path={file.path} className="hy-a6-full" />
				<FoldedPath path={file.path} />
				<Name file={file} />
			</div>
		)
	return (
		<header className="hy-head" data-variant={variant}>
			<TrafficLights />
			{identity}
			<div className="hy-actions">
				{variant === 'name-first' ? <KeyActions position={position} /> : <IconActions position={position} />}
				{agent ? (
					<button
						type="button"
						className={`hy-agent${open ? ' hy-agent-open' : ''}`}
						aria-pressed={open}
						onClick={onToggle}
						title={`${agent.name} — ${STATE_WORD[agent.state]}`}
					>
						<AgentGlyph state={agent.state} />
						<span>{agent.provider}</span>
						<span className="hy-agent-state">{STATE_WORD[agent.state]}</span>
					</button>
				) : null}
			</div>
		</header>
	)
}

/** The whole window: hybrid title row, the file, and (bound) A1's conversation column. */
export function ChromeHybrid({
	variant,
	file,
	agent = null,
}: {
	variant: HybridVariant
	file: ViewerFile
	agent?: AgentBinding | null
}) {
	const [status, setStatus] = useState<ViewerStatus>({})
	const [open, setOpen] = useState(true)
	const feedback = useFeedback(agent !== null)
	return (
		<div className="open-stage hy-stage">
			<HybridHeader
				variant={variant}
				file={file}
				agent={agent}
				position={status.position}
				open={open}
				onToggle={() => setOpen(value => !value)}
			/>
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
