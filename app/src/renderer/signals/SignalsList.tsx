// The Signals list (design §3.25, Jakub's pick 2026-11-11): only the sections that hold threads,
// each under a sticky full-width band with its Braille count mark and count; with nothing open, a
// slow gray Braille dot field over what Signals listens to. The done line sits at the bottom of the
// list. Rows, keys, footer and flows stay the column's own (Signals.tsx).

import type { ReactNode } from 'react'
import type { SignalSourceHealth, SignalThread } from '../../shared-helm'
import { type SignalSections, answersNew, needsYouCount, needsYouNew, restingWords } from './model'

export interface SignalsListProps {
	/** Needs you, Managed and Snoozed (done rows are listed only in their own view). */
	sections: SignalSections
	/** The snapshot's sources: the resting words claim listening only while every source answered. */
	sources: readonly SignalSourceHealth[] | null
	now: number
	row(thread: SignalThread): ReactNode
	/** The `Done today 8 · D` button, or the plain `Done today 0`. */
	done: ReactNode
	/** The `5 filtered · f` button; null when nothing was filtered. */
	filtered: ReactNode
}

/** Three Braille cells (2×3 dots each), the ActivityIndicator's dot language at rest. */
function BrailleField({ unknown }: { unknown: boolean }) {
	return (
		<span className="signals-braille" data-unknown={unknown ? 'true' : undefined} aria-hidden="true">
			{[0, 1, 2].map(cell => (
				<span key={cell} className="signals-braille-cell">
					{[0, 1, 2].map(rowIndex =>
						[0, 1].map(column => (
							<span
								key={`${rowIndex}-${column}`}
								className="signals-braille-dot"
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
function BrailleCount({ count, tone }: { count: number; tone?: 'new' | 'info' }) {
	const lit = new Set(CLOCKWISE.slice(0, Math.min(count, 6)))
	return (
		<span className="signals-braille signals-braille-mark" data-tone={tone} aria-hidden="true">
			<span className="signals-braille-cell">
				{[0, 1, 2, 3, 4, 5].map(dot => (
					<span key={dot} className="signals-braille-dot" data-lit={lit.has(dot) ? 'true' : undefined} />
				))}
			</span>
		</span>
	)
}

function Section({
	label,
	count,
	tone,
	threads,
	row,
}: {
	label: string
	count: number
	tone?: 'new' | 'info'
	threads: readonly SignalThread[]
	row: SignalsListProps['row']
}) {
	return (
		<section className="signals-section" aria-label={label}>
			<div className="signals-band">
				<BrailleCount count={count} tone={tone} />
				<span className="signals-band-label">{label}</span>
				<span className="signals-band-count">{count}</span>
			</div>
			<ul className="signals-table" aria-label={label}>
				{threads.map(row)}
			</ul>
		</section>
	)
}

export function SignalsList({ sections, sources, now, row, done, filtered }: SignalsListProps) {
	const open = sections.needs.length + sections.answers.length + sections.managed.length + sections.snoozed.length > 0
	const resting = restingWords(sources)
	return (
		<div className="signals-list">
			{open ? (
				<>
					{sections.needs.length > 0 ? (
						<Section
							label="Needs you"
							count={needsYouCount(sections, now)}
							tone={needsYouNew(sections, now) ? 'new' : undefined}
							threads={sections.needs}
							row={row}
						/>
					) : null}
					{sections.answers.length > 0 ? (
						<Section
							label="Answers"
							count={sections.answers.length}
							tone={answersNew(sections.answers) ? 'info' : undefined}
							threads={sections.answers}
							row={row}
						/>
					) : null}
					{sections.managed.length > 0 ? (
						<Section label="Managed" count={sections.managed.length} threads={sections.managed} row={row} />
					) : null}
					{sections.snoozed.length > 0 ? (
						<Section label="Snoozed" count={sections.snoozed.length} threads={sections.snoozed} row={row} />
					) : null}
				</>
			) : (
				<div className="signals-resting">
					<BrailleField unknown={!resting.listening} />
					<span className="signals-resting-title">{resting.title}</span>
					<span className="signals-resting-detail">{resting.detail}</span>
				</div>
			)}
			<div className="signals-done-line" data-done-header="">
				{done}
				{filtered ? <> · {filtered}</> : null}
			</div>
		</div>
	)
}
