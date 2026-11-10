// Design review only (Views / Signals / Sidebar look): five alternative looks for the Signals
// column's header and list, behind `SignalsColumnProps.look` (default `today`, which keeps the
// production SignalsTable untouched). Each look renders the header and the scroll owner over the
// SAME sections, rows, done/filtered buttons and source health; the footer, the keys and every flow
// stay the column's own. Illustrations are inline SVG or CSS on theme tokens (currentColor), with
// motion only under `prefers-reduced-motion: no-preference`.

import { Fragment, type ReactNode } from 'react'
import type { SignalSourceHealth, SignalThread } from '../../shared-helm'
import { KIND_GLYPH, KIND_WORD, SOURCE_LABEL, type SignalSections, formatAgo, handled } from './model'

/**
 * `today` — production. `card` — sections as soft containers, a dashed card with line-art when one
 * is empty. `calm` — a full-height calm state in the Braille dot language, Braille count marks on
 * the section titles. `terminal` — a compact `helm signal ls` transcript. `summary` — every count in
 * one status block under the title, empty sections folded into it, one centered illustration.
 * `ledger` — a count strip and, at rest, the legend of what lands here.
 */
export type SignalsLook = 'today' | 'card' | 'calm' | 'terminal' | 'summary' | 'ledger'

export const SIGNALS_LOOKS: readonly SignalsLook[] = ['today', 'card', 'calm', 'terminal', 'summary', 'ledger']

export interface SignalsLookBodyProps {
	look: Exclude<SignalsLook, 'today'>
	/** Needs you, Managed and Snoozed (done rows are listed only in their own view). */
	sections: SignalSections
	/** Null until the first snapshot arrives. */
	sources: readonly SignalSourceHealth[] | null
	/** Every source answered: an empty Needs you may say so. */
	quietEmpty: boolean
	/** The header's dim summary (`2 need you · 1 managed`, `nothing needs you`). */
	summary: string
	now: number
	row(thread: SignalThread): ReactNode
	/** The `Done today 8 · D` button, or the plain `Done today 0`. */
	done: ReactNode
	/** The `5 filtered · f` button; null when nothing was filtered. */
	filtered: ReactNode
	/** `9 filtered` (filteredLine), or null when nothing was filtered. */
	filteredText: string | null
	onOpenDone(): void
	onOpenFiltered(): void
	/** The header's Settings icon button. */
	settings: ReactNode
	/** `Reading signals…` or the bridge error while there is no snapshot; else null. */
	placeholder: string | null
}

const NEEDS_EMPTY = { title: 'Nothing needs you', detail: 'Reviews, comments, failed CI, mentions and mail land here.' }
const NEEDS_UNKNOWN = { title: 'Nothing listed', detail: 'Not every source answered. The footer says which.' }
const MANAGED_EMPTY = { title: 'Nothing managed', detail: 'Press m on a thread to hand it to the dispatcher.' }

function needsCopy(quietEmpty: boolean) {
	return quietEmpty ? NEEDS_EMPTY : NEEDS_UNKNOWN
}

/** Needs you threads not yet handled (routed or answered): the number the header says. */
function freshNeeds(sections: SignalSections, now: number): number {
	return sections.needs.filter(thread => !handled(thread, now)).length
}

function openCount(sections: SignalSections): number {
	return sections.needs.length + sections.managed.length + sections.snoozed.length
}

function DoneLine({ done, filtered, className }: { done: ReactNode; filtered: ReactNode; className?: string }) {
	return (
		<div className={`signals-look-done${className ? ` ${className}` : ''}`}>
			{done}
			{filtered ? <> · {filtered}</> : null}
		</div>
	)
}

function Header({ summary, settings }: { summary: string | null; settings: ReactNode }) {
	return (
		<header className="signals-title">
			<span className="signals-title-text">
				<span className="signals-title-kind">Signals</span>
				{summary ? <span className="signals-title-context">{summary}</span> : null}
			</span>
			{settings}
		</header>
	)
}

/** A section title, its count on the age column (`Needs you  6`). */
function Title({ label, count, mark }: { label: string; count?: number; mark?: ReactNode }) {
	return (
		<div className="signals-look-subhead" data-marked={mark ? 'true' : undefined}>
			{mark}
			<span className="signals-look-subhead-label">{label}</span>
			{count !== undefined ? <span className="signals-look-subhead-count">{count}</span> : null}
		</div>
	)
}

function Rows({
	threads,
	row,
	label,
}: { threads: readonly SignalThread[]; row: SignalsLookBodyProps['row']; label: string }) {
	return (
		<ul className="signals-table signals-look-table" aria-label={label}>
			{threads.map(row)}
		</ul>
	)
}

// ---------- illustrations ----------

/** An empty tray, 1px strokes on half pixels (crisp at 1× and 2×). */
function TrayArt({ unknown }: { unknown: boolean }) {
	return (
		<svg className="signals-look-art" width="48" height="40" viewBox="0 0 48 40" aria-hidden="true" fill="none">
			<path
				d="M6.5 22.5 12.5 8.5h23l6 14v11h-35z"
				stroke="currentColor"
				strokeLinejoin="round"
				strokeDasharray={unknown ? '3 3' : undefined}
			/>
			<path d="M6.5 22.5h10l2 4h11l2-4h10" stroke="currentColor" strokeLinejoin="round" />
		</svg>
	)
}

/** A thread passed on: an arrow into a bracket. */
function HandoffArt() {
	return (
		<svg className="signals-look-art" width="32" height="24" viewBox="0 0 32 24" aria-hidden="true" fill="none">
			<path d="M4.5 12.5h15M15.5 8.5l4 4-4 4" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" />
			<path d="M23.5 5.5h4v14h-4" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" />
		</svg>
	)
}

/** Three Braille cells (2×3 dots each), the ActivityIndicator's dot language at rest. */
function BrailleField({ unknown }: { unknown: boolean }) {
	return (
		<span className="signals-look-braille" data-unknown={unknown ? 'true' : undefined} aria-hidden="true">
			{[0, 1, 2].map(cell => (
				<span key={cell} className="signals-look-braille-cell">
					{[0, 1, 2].map(rowIndex =>
						[0, 1].map(column => (
							<span
								key={`${rowIndex}-${column}`}
								className="signals-look-braille-dot"
								// Diagonal phase (cell, column, row): a slow gray wave crosses the field.
								style={{ animationDelay: `${(cell * 2 + column + rowIndex) * 240}ms` }}
							/>
						)),
					)}
				</span>
			))}
		</span>
	)
}

/** The indicator's clockwise dot order: top-left, top-right, middle-right, bottom-right, bottom-left, middle-left. */
const CLOCKWISE = [0, 1, 3, 5, 4, 2]

/** A 2×3 Braille cell counting a section (one lit dot per thread, clockwise, six and more = full). */
function BrailleCount({ count, tone }: { count: number; tone?: 'new' }) {
	const lit = new Set(CLOCKWISE.slice(0, Math.min(count, 6)))
	return (
		<span className="signals-look-braille signals-look-braille-mark" data-tone={tone} aria-hidden="true">
			<span className="signals-look-braille-cell">
				{[0, 1, 2, 3, 4, 5].map(dot => (
					<span key={dot} className="signals-look-braille-dot" data-lit={lit.has(dot) ? 'true' : undefined} />
				))}
			</span>
		</span>
	)
}

/** A point with three arcs: Signals listening. Broken arcs while a source is not answering. */
function ListeningArt({ unknown }: { unknown: boolean }) {
	const dash = unknown ? '4 5' : undefined
	return (
		<svg
			className="signals-look-art signals-look-listening"
			width="112"
			height="64"
			viewBox="0 0 112 64"
			aria-hidden="true"
			fill="none"
		>
			<circle cx="56" cy="56" r="3" fill="currentColor" />
			{[14, 28, 42].map((radius, index) => (
				<path
					key={radius}
					className="signals-look-arc"
					data-arc={index + 1}
					d={`M${56 - radius} 56a${radius} ${radius} 0 0 1 ${radius * 2} 0`}
					stroke="currentColor"
					strokeLinecap="round"
					strokeDasharray={dash}
				/>
			))}
		</svg>
	)
}

// ---------- the five looks ----------

/** 1. Card: each section's rows sit in a soft container; an empty section is a dashed card with line-art. */
function CardLook(props: SignalsLookBodyProps) {
	const { sections, quietEmpty, row, done, filtered, now } = props
	const needs = needsCopy(quietEmpty)
	return (
		<div className="signals-look-cards">
			<Title label="Needs you" count={freshNeeds(sections, now) || undefined} />
			{sections.needs.length > 0 ? (
				<div className="signals-look-group">
					<Rows threads={sections.needs} row={row} label="Needs you" />
				</div>
			) : (
				<div className="signals-look-card" data-size="large">
					<TrayArt unknown={!quietEmpty} />
					<span className="signals-look-card-title">{needs.title}</span>
					<span className="signals-look-card-detail">{needs.detail}</span>
				</div>
			)}
			<Title label="Managed" count={sections.managed.length || undefined} />
			{sections.managed.length > 0 ? (
				<div className="signals-look-group">
					<Rows threads={sections.managed} row={row} label="Managed" />
				</div>
			) : (
				<div className="signals-look-card" data-size="small">
					<HandoffArt />
					<span className="signals-look-card-title">{MANAGED_EMPTY.title}</span>
					<span className="signals-look-card-detail">{MANAGED_EMPTY.detail}</span>
				</div>
			)}
			{sections.snoozed.length > 0 ? (
				<>
					<Title label="Snoozed" count={sections.snoozed.length} />
					<div className="signals-look-group" data-quiet="true">
						<Rows threads={sections.snoozed} row={row} label="Snoozed" />
					</div>
				</>
			) : null}
			<DoneLine done={done} filtered={filtered} className="signals-look-card-done" />
		</div>
	)
}

/** 2. Calm: with nothing open, one centered calm state; else Braille count marks, the done line pinned low. */
function CalmLook(props: SignalsLookBodyProps) {
	const { sections, quietEmpty, row, done, filtered, now } = props
	const needs = needsCopy(quietEmpty)
	if (openCount(sections) === 0)
		return (
			<div className="signals-look-calm">
				<BrailleField unknown={!quietEmpty} />
				<span className="signals-look-calm-title">{needs.title}</span>
				<span className="signals-look-calm-detail">
					{quietEmpty ? 'Nothing managed either. New threads land here.' : needs.detail}
				</span>
				<DoneLine done={done} filtered={filtered} className="signals-look-calm-done" />
			</div>
		)
	const fresh = freshNeeds(sections, now)
	const anyNew = sections.needs.some(thread => thread.state === 'new' && !handled(thread, now))
	return (
		<div className="signals-look-calm-list">
			<Title label="Needs you" count={fresh} mark={<BrailleCount count={fresh} tone={anyNew ? 'new' : undefined} />} />
			{/* Empty here: the header and the empty count mark already say it. */}
			{sections.needs.length > 0 ? <Rows threads={sections.needs} row={row} label="Needs you" /> : null}
			<Title label="Managed" count={sections.managed.length} mark={<BrailleCount count={sections.managed.length} />} />
			{sections.managed.length > 0 ? (
				<Rows threads={sections.managed} row={row} label="Managed" />
			) : (
				<p className="signals-look-line">
					{MANAGED_EMPTY.title}. <span className="signals-look-line-dim">{MANAGED_EMPTY.detail}</span>
				</p>
			)}
			{sections.snoozed.length > 0 ? (
				<>
					<Title
						label="Snoozed"
						count={sections.snoozed.length}
						mark={<BrailleCount count={sections.snoozed.length} />}
					/>
					<Rows threads={sections.snoozed} row={row} label="Snoozed" />
				</>
			) : null}
			<DoneLine done={done} filtered={filtered} className="signals-look-pinned-done" />
		</div>
	)
}

/** A transcript key that opens its list (`done today`, `filtered`); the key hint shows while Signals has the keys. */
function TermListKey({
	label,
	keys,
	shortcut,
	onOpen,
}: { label: string; keys: string; shortcut: string; onOpen(): void }) {
	return (
		<button
			type="button"
			className="signals-list-btn signals-look-term-key"
			aria-keyshortcuts={shortcut}
			onMouseDown={event => event.preventDefault()}
			onClick={onOpen}
		>
			{label}
			<span className="signals-list-key" aria-hidden="true">
				{' '}
				<kbd>{keys}</kbd>
			</span>
		</button>
	)
}

/** 3. Terminal: a compact `helm signal ls` transcript as the inbox-zero illustration (mono). */
function TerminalLook(props: SignalsLookBodyProps) {
	const { sections, quietEmpty, row, done, filtered, now } = props
	const filteredCount = props.filteredText ? Number.parseInt(props.filteredText, 10) : 0
	if (openCount(sections) === 0) {
		return (
			<div className="signals-look-term">
				<div>
					<span className="signals-look-term-prompt">$</span> helm signal ls
				</div>
				<div className="signals-look-term-out">
					<span className="signals-look-term-key">needs you</span>
					<span className="signals-look-term-val">0</span>
					<span className="signals-look-term-key">managed</span>
					<span className="signals-look-term-val">0</span>
					{sections.doneToday > 0 ? (
						<TermListKey label="done today" keys="D" shortcut="Shift+D" onOpen={props.onOpenDone} />
					) : (
						<span className="signals-look-term-key">done today</span>
					)}
					<span className="signals-look-term-val">{sections.doneToday}</span>
					{filteredCount > 0 ? (
						<>
							<TermListKey label="filtered" keys="f" shortcut="f" onOpen={props.onOpenFiltered} />
							<span className="signals-look-term-val">{filteredCount}</span>
						</>
					) : null}
				</div>
				<div className="signals-look-term-note">{quietEmpty ? 'inbox zero' : 'nothing listed'}</div>
				<div className="signals-look-term-note">
					{quietEmpty ? 'every source answered' : 'not every source answered'}
				</div>
				<div className="signals-look-term-caret-line">
					<span className="signals-look-term-prompt">$</span> <span className="signals-look-caret" />
				</div>
			</div>
		)
	}
	const head = (label: string, count: number) => (
		<div className="signals-look-term-head">
			<span className="signals-look-term-prompt">#</span> {label} <span className="signals-look-term-val">{count}</span>
		</div>
	)
	return (
		<div className="signals-look-term-list">
			{head('needs you', freshNeeds(sections, now))}
			{sections.needs.length > 0 ? (
				<Rows threads={sections.needs} row={row} label="Needs you" />
			) : (
				<p className="signals-look-term-empty">{quietEmpty ? 'inbox zero' : 'not every source answered'}</p>
			)}
			{head('managed', sections.managed.length)}
			{sections.managed.length > 0 ? (
				<Rows threads={sections.managed} row={row} label="Managed" />
			) : (
				<p className="signals-look-term-empty">none · m hands one off</p>
			)}
			{sections.snoozed.length > 0 ? (
				<>
					{head('snoozed', sections.snoozed.length)}
					<Rows threads={sections.snoozed} row={row} label="Snoozed" />
				</>
			) : null}
			<div className="signals-look-term-head">
				<span className="signals-look-term-prompt">#</span>{' '}
				{sections.doneToday > 0 ? (
					<TermListKey label="done today" keys="D" shortcut="Shift+D" onOpen={props.onOpenDone} />
				) : (
					'done today'
				)}{' '}
				<span className="signals-look-term-val">{sections.doneToday}</span>
				{filteredCount > 0 ? (
					<>
						{' · '}
						<TermListKey label="filtered" keys="f" shortcut="f" onOpen={props.onOpenFiltered} />{' '}
						<span className="signals-look-term-val">{filteredCount}</span>
					</>
				) : null}
			</div>
		</div>
	)
}

/** 4. Summary: every count in one status block under the title; empty sections fold into it. */
function SummaryLook(props: SignalsLookBodyProps) {
	const { sections, quietEmpty, row, done, filtered, sources, now } = props
	const fresh = freshNeeds(sections, now)
	const parts = [
		sections.needs.length === 0
			? quietEmpty
				? 'Nothing needs you'
				: 'Nothing listed'
			: fresh === 0
				? 'All handled'
				: `${fresh} need${fresh === 1 ? 's' : ''} you`,
		sections.managed.length === 0 ? 'nothing managed' : `${sections.managed.length} managed`,
	]
	if (sections.snoozed.length > 0) parts.push(`${sections.snoozed.length} snoozed`)
	const listening = (sources ?? []).filter(source => source.status === 'ok').map(source => SOURCE_LABEL[source.source])
	return (
		<div className="signals-look-summary">
			<div className="signals-look-status">
				<span className="signals-look-status-text">
					{parts.map((part, index) => (
						<Fragment key={part}>
							{index > 0 ? ' ' : null}
							<span className="signals-look-status-part">
								{index > 0 ? '· ' : null}
								{part}
							</span>
						</Fragment>
					))}
				</span>
				<DoneLine done={done} filtered={filtered} />
			</div>
			{openCount(sections) > 0 ? (
				<>
					{sections.needs.length > 0 ? <Title label="Needs you" /> : null}
					{sections.needs.length > 0 ? <Rows threads={sections.needs} row={row} label="Needs you" /> : null}
					{sections.managed.length > 0 ? <Title label="Managed" /> : null}
					{sections.managed.length > 0 ? <Rows threads={sections.managed} row={row} label="Managed" /> : null}
					{sections.snoozed.length > 0 ? <Title label="Snoozed" /> : null}
					{sections.snoozed.length > 0 ? <Rows threads={sections.snoozed} row={row} label="Snoozed" /> : null}
				</>
			) : (
				<div className="signals-look-stage">
					<ListeningArt unknown={!quietEmpty} />
					<span className="signals-look-stage-title">
						{quietEmpty ? `Listening to ${listening.join(' and ') || 'your sources'}` : 'Not every source answered'}
					</span>
					<span className="signals-look-stage-detail">
						{quietEmpty
							? 'New reviews, comments, failed CI, mentions and mail show up here.'
							: 'The footer says which one, and how to fix it.'}
					</span>
				</div>
			)}
		</div>
	)
}

const LEGEND: readonly (keyof typeof KIND_GLYPH)[] = ['review', 'comments', 'ci', 'mention', 'mail', 'sentry', 'ask']

/** 5. Ledger: a count strip under the title, then only the sections that hold threads; at rest the legend. */
function LedgerLook(props: SignalsLookBodyProps) {
	const { sections, quietEmpty, row, sources, now } = props
	if (openCount(sections) > 0)
		return (
			<div className="signals-look-ledger">
				{sections.needs.length > 0 ? <Title label="Needs you" /> : null}
				{sections.needs.length > 0 ? <Rows threads={sections.needs} row={row} label="Needs you" /> : null}
				{sections.managed.length > 0 ? <Title label="Managed" /> : null}
				{sections.managed.length > 0 ? <Rows threads={sections.managed} row={row} label="Managed" /> : null}
				{sections.snoozed.length > 0 ? <Title label="Snoozed" /> : null}
				{sections.snoozed.length > 0 ? <Rows threads={sections.snoozed} row={row} label="Snoozed" /> : null}
			</div>
		)
	const answering = (sources ?? []).filter(source => source.status !== 'disabled')
	return (
		<div className="signals-look-ledger">
			<div className="signals-look-legend">
				<span className="signals-look-legend-title">{quietEmpty ? NEEDS_EMPTY.title : NEEDS_UNKNOWN.title}</span>
				<span className="signals-look-legend-detail">
					{quietEmpty ? 'What lands here when it does:' : 'Not every source answered.'}
				</span>
				<ul className="signals-look-legend-list" aria-label="What lands here">
					{LEGEND.map(kind => (
						<li key={kind}>
							<span className="signals-glyph" data-kind={kind} aria-hidden="true">
								{KIND_GLYPH[kind]}
							</span>
							<span>{KIND_WORD[kind]}</span>
						</li>
					))}
				</ul>
				{answering.length > 0 ? (
					<ul className="signals-look-legend-sources" aria-label="Sources">
						{answering.map(source => (
							<li key={source.source}>
								{source.status === 'ok' && source.lastOkAt
									? `${SOURCE_LABEL[source.source]} answered ${formatAgo(now - Date.parse(source.lastOkAt))} ago`
									: `${SOURCE_LABEL[source.source]} is not answering`}
							</li>
						))}
					</ul>
				) : null}
			</div>
		</div>
	)
}

/** The count strip under the title: needs you, managed, done today (opens Done today), filtered. */
function LedgerStrip({
	sections,
	now,
	filteredText,
	onOpenDone,
	onOpenFiltered,
}: Pick<SignalsLookBodyProps, 'sections' | 'now' | 'filteredText' | 'onOpenDone' | 'onOpenFiltered'>) {
	const cell = (count: number, label: string) => (
		<span className="signals-look-ledger-cell" data-zero={count === 0 ? 'true' : undefined}>
			<span className="signals-look-ledger-n">{count}</span>
			<span className="signals-look-ledger-label">{label}</span>
		</span>
	)
	const filteredCount = filteredText ? Number.parseInt(filteredText, 10) : 0
	return (
		<div className="signals-look-ledger-strip">
			{cell(freshNeeds(sections, now), 'needs you')}
			{cell(sections.managed.length, 'managed')}
			{sections.doneToday > 0 ? (
				<button
					type="button"
					className="signals-look-ledger-cell signals-look-ledger-btn"
					aria-keyshortcuts="Shift+D"
					title="Threads done in the last 24 hours, and how each got done"
					onMouseDown={event => event.preventDefault()}
					onClick={onOpenDone}
				>
					<span className="signals-look-ledger-n">
						{sections.doneToday}
						<span className="signals-list-key" aria-hidden="true">
							{' '}
							· <kbd>D</kbd>
						</span>
					</span>
					<span className="signals-look-ledger-label">done today</span>
				</button>
			) : (
				cell(0, 'done today')
			)}
			{filteredCount > 0 ? (
				<button
					type="button"
					className="signals-look-ledger-cell signals-look-ledger-btn"
					aria-keyshortcuts="f"
					title="Mail the rules kept out of Needs you (last 7 days)"
					onMouseDown={event => event.preventDefault()}
					onClick={onOpenFiltered}
				>
					<span className="signals-look-ledger-n">
						{filteredCount}
						<span className="signals-list-key" aria-hidden="true">
							{' '}
							· <kbd>f</kbd>
						</span>
					</span>
					<span className="signals-look-ledger-label">filtered</span>
				</button>
			) : null}
		</div>
	)
}

/** Header + scroll owner for a non-production look. */
export function SignalsLookBody(props: SignalsLookBodyProps) {
	const { look, summary, settings, placeholder } = props
	const body =
		placeholder !== null ? (
			<p className="signals-placeholder">{placeholder}</p>
		) : look === 'card' ? (
			<CardLook {...props} />
		) : look === 'calm' ? (
			<CalmLook {...props} />
		) : look === 'terminal' ? (
			<TerminalLook {...props} />
		) : look === 'summary' ? (
			<SummaryLook {...props} />
		) : (
			<LedgerLook {...props} />
		)
	return (
		<>
			<Header
				summary={
					look === 'summary' || look === 'ledger' || (look === 'calm' && openCount(props.sections) === 0)
						? null
						: summary
				}
				settings={settings}
			/>
			{look === 'ledger' && placeholder === null ? (
				<LedgerStrip
					sections={props.sections}
					now={props.now}
					filteredText={props.filteredText}
					onOpenDone={props.onOpenDone}
					onOpenFiltered={props.onOpenFiltered}
				/>
			) : null}
			<div className="signals-scroll signals-look-scroll">{body}</div>
		</>
	)
}
