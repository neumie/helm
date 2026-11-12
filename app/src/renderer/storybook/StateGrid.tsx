// Storybook-only state grid (docs/design-system.md §7). One cell per
// interaction state, rendered from the REAL primitive: forced states set
// `data-force-state="<state>"` on the primitive's interactive element, and the
// primitive's CSS answers it in the same rule as the real pseudo-class
// (`.btn-quiet:hover:not(:disabled), .btn-quiet[data-force-state="hover"]:not(:disabled)`).
// Production never sets the attribute, so these selectors never match there.
// Never import this file from production renderer code.
import { type ReactElement, type ReactNode, cloneElement, isValidElement, useLayoutEffect, useRef } from 'react'

/** States CSS answers through `[data-force-state]`. `focus-visible` also
 *  stands in for `:focus` rules (keyboard focus implies both). */
export const FORCED_STATES = ['hover', 'active', 'focus-visible'] as const
export type ForcedState = (typeof FORCED_STATES)[number]

/** States a row supplies as its own element (a real prop, never forced CSS). */
export const VARIANT_STATES = ['selected', 'checked', 'busy', 'open'] as const
export type VariantState = (typeof VARIANT_STATES)[number]

export type GridState = 'rest' | ForcedState | 'disabled' | VariantState

/** Every column a grid can show, in display order. */
export const STATE_GRID_STATES: readonly GridState[] = [
	'rest',
	'hover',
	'active',
	'focus-visible',
	'disabled',
	...VARIANT_STATES,
]

/** Default columns: the interaction states every interactive primitive has. */
export const INTERACTION_STATES: readonly GridState[] = ['rest', 'hover', 'active', 'focus-visible', 'disabled']

export interface StateGridRow {
	label: string
	/** The primitive at rest. Forced states are derived from it. */
	element: ReactElement
	/** CSS selector (inside the cell) of the element that takes the forced
	 *  state; default is the first focusable element. */
	target?: string
	/** Elements for real-prop states (selected, checked, busy, open). */
	variants?: Partial<Record<VariantState, ReactElement>>
	/** Forced states the primitive has no style for (no `:active` rule, say).
	 *  The cell says so instead of showing a copy of rest. */
	unstyled?: readonly ForcedState[]
	/** Fixed cell size, for primitives that paint outside their box (menus). */
	height?: number
	width?: number
}

const FOCUSABLE = 'button, input, textarea, select, a[href], [tabindex]'

function isForced(state: GridState): state is ForcedState {
	return (FORCED_STATES as readonly string[]).includes(state)
}

function isVariant(state: GridState): state is VariantState {
	return (VARIANT_STATES as readonly string[]).includes(state)
}

function cellElement(row: StateGridRow, state: GridState): ReactNode {
	if (isVariant(state)) return row.variants?.[state] ?? null
	const element = row.element
	// A row with a `target` is a wrapper (layout box, menu): StateCell's effect
	// sets the state on the target only.
	if (!isValidElement(element) || state === 'rest' || row.target) return element
	if (state === 'disabled') return cloneElement(element, { disabled: true } as never)
	// Plain DOM elements take the attribute directly; components that do not
	// forward it get it from StateCell's effect below.
	return cloneElement(element, { 'data-force-state': state } as never)
}

/** Applies the forced state to the target element, also after the primitive
 *  replaces its DOM (menus mount their panel after the first render). */
function StateCell({ row, state }: { row: StateGridRow; state: GridState }) {
	const cellRef = useRef<HTMLDivElement>(null)
	useLayoutEffect(() => {
		const cell = cellRef.current
		if (!cell || !(isForced(state) || state === 'disabled')) return
		const apply = () => {
			const target = cell.querySelector<HTMLElement>(row.target ?? FOCUSABLE)
			if (!target) return
			if (isForced(state)) {
				if (target.getAttribute('data-force-state') !== state) target.setAttribute('data-force-state', state)
			} else if ('disabled' in target && !target.disabled) {
				;(target as HTMLButtonElement).disabled = true
			}
		}
		apply()
		const observer = new MutationObserver(apply)
		observer.observe(cell, { childList: true, subtree: true })
		return () => observer.disconnect()
	}, [row.target, state])
	if (isForced(state) && row.unstyled?.includes(state)) {
		return (
			<div title={`No ${state} style`} style={{ color: 'var(--text-2)', fontSize: 'calc(11px * var(--ui-scale))' }}>
				— no style
			</div>
		)
	}
	const content = cellElement(row, state)
	return (
		<div ref={cellRef} style={{ height: row.height, minWidth: row.width, position: 'relative' }}>
			{content ?? (
				<span aria-hidden="true" style={{ color: 'var(--text-2)' }}>
					—
				</span>
			)}
		</div>
	)
}

const headerStyle = {
	padding: '0 0 4px',
	color: 'var(--text-2)',
	fontSize: 'calc(11px * var(--ui-scale))',
	fontWeight: 500,
	textAlign: 'left',
	whiteSpace: 'nowrap',
	verticalAlign: 'bottom',
} as const

export function StateGrid({
	rows,
	states = INTERACTION_STATES,
	caption,
	transpose = false,
}: {
	rows: StateGridRow[]
	states?: readonly GridState[]
	caption?: string
	/** States down, rows across: for wide primitives (list rows) whose grid
	 *  would not fit a narrow canvas. */
	transpose?: boolean
}) {
	const columns = transpose ? rows.map(row => row.label) : states
	const lines = transpose ? states : rows.map(row => row.label)
	const cell = (line: number, column: number) => {
		const row = rows[transpose ? column : line] as StateGridRow
		const state = states[transpose ? line : column] as GridState
		return <StateCell row={row} state={state} />
	}
	return (
		<table
			style={{ width: 'max-content', borderCollapse: 'separate', borderSpacing: '16px 12px', margin: '-12px -16px' }}
		>
			{caption ? (
				<caption style={{ ...headerStyle, padding: '0 16px', color: 'var(--text-1)' }}>{caption}</caption>
			) : null}
			<thead>
				<tr>
					<th scope="col" style={headerStyle}>
						<span className="sr-only">{transpose ? 'State' : 'Variant'}</span>
					</th>
					{columns.map(column => (
						<th key={column} scope="col" style={headerStyle}>
							{column}
						</th>
					))}
				</tr>
			</thead>
			<tbody>
				{lines.map((line, lineIndex) => (
					<tr key={line}>
						<th scope="row" style={{ ...headerStyle, verticalAlign: 'middle', color: 'var(--text-1)' }}>
							{line}
						</th>
						{columns.map((column, columnIndex) => (
							<td key={column} style={{ verticalAlign: 'middle' }}>
								{cell(lineIndex, columnIndex)}
							</td>
						))}
					</tr>
				))}
			</tbody>
		</table>
	)
}
