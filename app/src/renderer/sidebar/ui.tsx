// Shared sidebar primitives, styled per docs/design-system.md:
// buttons (§3.1), segmented control (§3.2), chips (§3.4), status dots (§3.5),
// inputs/selects (§3.7), menus (§3.8), sheets (§3.9), push-nav header (§3.10),
// banners (§3.12), empty states (§3.13), inline disclosure (§3.20).

import { useCallback, useEffect, useId, useRef, useState } from 'react'
import type { CSSProperties, ReactNode } from 'react'
import type { DashboardTone } from '../../shared-helm'
import { CHIP_CLASS } from './model'
import type { StatusTone } from './model'

// ---------------------------------------------------------------------------
// Buttons

export function Btn({
	tone = 'quiet',
	sm,
	disabled,
	busy,
	onClick,
	children,
	block,
	ariaLabel,
}: {
	tone?: 'primary' | 'quiet' | 'danger' | 'ghost'
	sm?: boolean
	disabled?: boolean
	/** In-flight: keeps the label, appends an ellipsis, disables the control. */
	busy?: boolean
	onClick?: () => void
	children: ReactNode
	block?: boolean
	ariaLabel?: string
}) {
	return (
		<button
			type="button"
			className={`btn btn-${tone}${sm ? ' btn-sm' : ''}${block ? ' btn-block' : ''}`}
			disabled={disabled || busy}
			aria-label={ariaLabel}
			onClick={onClick}
		>
			{children}
			{busy ? '…' : null}
		</button>
	)
}

export function IconBtn({
	label,
	onClick,
	children,
	pressed,
	disabled,
}: {
	label: string
	onClick?: () => void
	children: ReactNode
	pressed?: boolean
	disabled?: boolean
}) {
	return (
		<button
			type="button"
			className="icon-btn"
			aria-label={label}
			title={label}
			aria-pressed={pressed}
			disabled={disabled}
			onClick={onClick}
		>
			{children}
		</button>
	)
}

// Inline SVG glyphs — stroke follows currentColor so button tones apply.
const glyph = (d: string, size = 14) => (
	<svg width={size} height={size} viewBox="0 0 16 16" fill="none" aria-hidden="true">
		<path d={d} stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
	</svg>
)

export const GLYPH = {
	plus: glyph('M8 3v10M3 8h10'),
	back: glyph('M9.5 3.5 5 8l4.5 4.5'),
	chevronRight: glyph('M6 3.5 10.5 8 6 12.5', 12),
	chevronDown: glyph('M3.5 6 8 10.5 12.5 6', 12),
	ellipsis: (
		<svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
			<circle cx="3" cy="8" r="1.3" />
			<circle cx="8" cy="8" r="1.3" />
			<circle cx="13" cy="8" r="1.3" />
		</svg>
	),
	external: glyph('M6.5 4H4v8h8V9.5M9 3h4v4M13 3 7.5 8.5', 12),
	copy: glyph('M6 6h7v7H6zM10 6V3H3v7h3', 12),
	check: glyph('M3.5 8.5 6.5 11.5 12.5 4.5'),
	agent: glyph('M4 5h8v7H4zM8 2.5V5M6 8h.1M9.9 8h.1M6 10h4'),
	manual: glyph('M8 7a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5M3.5 13a4.5 4 0 0 1 9 0'),
	play: glyph('M5 3.5 12 8 5 12.5z'),
	queue: glyph('M8 2.5v7M5.5 7 8 9.5 10.5 7M3.5 12.5h9'),
	retry: glyph('M12.5 5.5V2.8l-2.2 1.4A5 5 0 1 0 13 8'),
	stop: glyph('M4.5 4.5h7v7h-7z'),
	pause: glyph('M5.5 4v8M10.5 4v8'),
	return: glyph('M6.5 4 3 7.5 6.5 11M3.5 7.5H9a4 4 0 0 1 4 4'),
	plan: glyph('M4 2.5h6l2 2V13.5H4zM10 2.5v2h2M6 7h4M6 9.5h4', 13),
	archive: glyph('M3 5h10v8H3zM2.5 3h11v2h-11M6.5 8h3'),
	group: glyph('M3 3.5h10v3H3zM3 9.5h7v3H3z'),
	settings: glyph(
		'M8 5.5A2.5 2.5 0 1 0 8 10.5 2.5 2.5 0 0 0 8 5.5M8 2.5v1M8 12.5v1M2.5 8h1M12.5 8h1M4.1 4.1l.7.7M11.2 11.2l.7.7M11.9 4.1l-.7.7M4.8 11.2l-.7.7',
	),
	close: glyph('M4 4l8 8M12 4l-8 8'),
}

// ---------------------------------------------------------------------------
// Chips & dots

export function Chip({ tone, children, title }: { tone: DashboardTone; children: ReactNode; title?: string }) {
	return (
		<span className={`chip ${CHIP_CLASS[tone]}`} title={title}>
			{children}
		</span>
	)
}

export function StatusDot({ tone, pulse }: { tone: StatusTone; pulse?: boolean }) {
	return <span className={`status-dot dot-${tone}${pulse ? ' dot-pulse' : ''}`} aria-hidden="true" />
}

export function ProjectColorText({
	color,
	className,
	children,
}: {
	color: string | null
	className?: string
	children: ReactNode
}) {
	const style = color ? ({ '--project-color': color } as CSSProperties) : undefined
	// Only configured projects get the 55/45 color mix (§3.3); unconfigured
	// slugs stay --text-2 via the base class.
	return (
		<span
			className={`project-color-text${color ? ' project-colored' : ''}${className ? ` ${className}` : ''}`}
			style={style}
		>
			{children}
		</span>
	)
}

// ---------------------------------------------------------------------------
// Menu (overflow / popover) — §3.8

export interface MenuEntry {
	label: string
	icon?: ReactNode
	onSelect: () => void
	danger?: boolean
	disabled?: boolean
	/** When present, renders this entry as one choice in a radio-menu group. */
	checked?: boolean
	/** Renders a separator ABOVE this entry. */
	group?: boolean
}

export function MenuButton({
	entries,
	align = 'end',
	trigger,
	triggerLabel,
	triggerClass,
	disabled,
}: {
	entries: MenuEntry[]
	align?: 'start' | 'end'
	trigger: ReactNode
	triggerLabel: string
	triggerClass?: string
	disabled?: boolean
}) {
	const [open, setOpen] = useState(false)
	const [activeIndex, setActiveIndex] = useState(-1)
	const rootRef = useRef<HTMLDivElement>(null)
	const triggerRef = useRef<HTMLButtonElement>(null)
	const menuId = useId()
	const itemRefs = useRef<Array<HTMLButtonElement | null>>([])

	const close = useCallback((refocus: boolean) => {
		setOpen(false)
		setActiveIndex(-1)
		if (refocus) triggerRef.current?.focus()
	}, [])

	// Click-outside closes; Esc is handled on the panel (capture) so it never
	// bubbles into the push stack's Esc-= -back handler.
	useEffect(() => {
		if (!open) return
		const onPointerDown = (event: PointerEvent) => {
			if (rootRef.current && !rootRef.current.contains(event.target as Node)) close(false)
		}
		const onKeyDown = (event: KeyboardEvent) => {
			if (event.key === 'Escape') {
				event.stopPropagation()
				close(true)
			}
		}
		document.addEventListener('pointerdown', onPointerDown)
		window.addEventListener('keydown', onKeyDown, { capture: true })
		return () => {
			document.removeEventListener('pointerdown', onPointerDown)
			window.removeEventListener('keydown', onKeyDown, { capture: true })
		}
	}, [open, close])

	const enabled = entries.map((entry, index) => ({ entry, index })).filter(({ entry }) => !entry.disabled)

	const focusIndex = (index: number) => {
		setActiveIndex(index)
		requestAnimationFrame(() => itemRefs.current[index]?.focus())
	}
	const move = (delta: number) => {
		if (enabled.length === 0) return
		const position = enabled.findIndex(({ index }) => index === activeIndex)
		const next = enabled[(position + delta + enabled.length) % enabled.length]
		if (next) focusIndex(next.index)
	}
	const openMenu = (last = false) => {
		if (disabled || enabled.length === 0) return
		const next = last ? enabled[enabled.length - 1] : enabled[0]
		setOpen(true)
		if (next) focusIndex(next.index)
	}

	const onMenuKeyDown = (event: React.KeyboardEvent) => {
		if (event.key === 'Tab') {
			close(false)
			return
		}
		if (event.key === 'ArrowDown') {
			event.preventDefault()
			move(1)
		} else if (event.key === 'ArrowUp') {
			event.preventDefault()
			move(-1)
		} else if (event.key === 'Home') {
			event.preventDefault()
			if (enabled[0]) focusIndex(enabled[0].index)
		} else if (event.key === 'End') {
			event.preventDefault()
			const last = enabled[enabled.length - 1]
			if (last) focusIndex(last.index)
		} else if (event.key === 'Enter' || event.key === ' ') {
			event.preventDefault()
			const entry = entries[activeIndex]
			if (entry && !entry.disabled) {
				close(true)
				entry.onSelect()
			}
		}
	}

	return (
		<div
			className="menu-root"
			ref={rootRef}
			onBlur={event => {
				if (!event.currentTarget.contains(event.relatedTarget as Node | null)) close(false)
			}}
		>
			<button
				type="button"
				ref={triggerRef}
				className={triggerClass ?? 'icon-btn'}
				aria-label={triggerLabel}
				title={triggerLabel}
				aria-haspopup="menu"
				aria-expanded={open}
				aria-controls={open ? menuId : undefined}
				disabled={disabled}
				onClick={() => (open ? close(false) : openMenu())}
				onKeyDown={event => {
					if (event.key === 'ArrowDown') {
						event.preventDefault()
						open ? move(1) : openMenu()
					}
					if (event.key === 'ArrowUp') {
						event.preventDefault()
						open ? move(-1) : openMenu(true)
					}
				}}
			>
				{trigger}
			</button>
			{open && (
				// biome/eslint-free zone: the panel is keyboard-driven via the handlers above.
				<div
					id={menuId}
					role="menu"
					aria-label={triggerLabel}
					className={`menu-panel menu-${align}`}
					onKeyDown={onMenuKeyDown}
				>
					{entries.map((entry, index) => (
						<div key={entry.label}>
							{entry.group && index > 0 && <div className="menu-separator" aria-hidden="true" />}
							<button
								type="button"
								role={entry.checked === undefined ? 'menuitem' : 'menuitemradio'}
								aria-checked={entry.checked}
								className={`menu-item${entry.danger ? ' menu-item-danger' : ''}${index === activeIndex ? ' menu-item-active' : ''}`}
								disabled={entry.disabled}
								ref={node => {
									itemRefs.current[index] = node
								}}
								tabIndex={index === activeIndex ? 0 : -1}
								onMouseEnter={() => focusIndex(index)}
								onClick={() => {
									close(true)
									entry.onSelect()
								}}
							>
								{entry.checked !== undefined ? (
									<span className={`menu-item-icon${entry.checked ? '' : ' menu-item-icon-empty'}`}>{GLYPH.check}</span>
								) : entry.icon ? (
									<span className="menu-item-icon">{entry.icon}</span>
								) : null}
								<span className="menu-item-label">{entry.label}</span>
							</button>
						</div>
					))}
				</div>
			)}
		</div>
	)
}

// ---------------------------------------------------------------------------
// Segmented control — §3.2

export interface SegmentOption<T extends string> {
	value: T
	label: string
	count?: number
}

export function Segmented<T extends string>({
	options,
	value,
	onChange,
	label,
	commit,
	variant = 'boxed',
}: {
	options: SegmentOption<T>[]
	value: T
	onChange: (value: T) => void
	label: string
	/** True either/or commit choice (agent picker) — active segment may use accent fill. */
	commit?: boolean
	variant?: 'boxed' | 'index'
}) {
	const optionRole = variant === 'index' ? 'radio' : 'tab'
	const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
		if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
		event.preventDefault()
		const index = options.findIndex(option => option.value === value)
		const nextIndex = (index + (event.key === 'ArrowRight' ? 1 : -1) + options.length) % options.length
		const next = options[nextIndex]
		if (next) {
			onChange(next.value)
			event.currentTarget.querySelectorAll<HTMLButtonElement>(`[role="${optionRole}"]`)[nextIndex]?.focus()
		}
	}
	return (
		<div
			className={`segmented${commit ? ' segmented-commit' : ''}${variant === 'index' ? ' segmented-index' : ''}`}
			role={variant === 'index' ? 'radiogroup' : 'tablist'}
			aria-label={label}
			style={variant === 'index' ? undefined : { gridTemplateColumns: `repeat(${options.length}, 1fr)` }}
			onKeyDown={onKeyDown}
		>
			{options.map(option => {
				const active = option.value === value
				return (
					<button
						key={option.value}
						type="button"
						role={optionRole}
						aria-selected={variant === 'index' ? undefined : active}
						aria-checked={variant === 'index' ? active : undefined}
						tabIndex={active ? 0 : -1}
						className={`segment${active ? ' segment-active' : ''}`}
						onClick={() => onChange(option.value)}
					>
						{/* Wrapper sizes the index variant's active underline to exactly
						    the label+count width (§3.2). */}
						<span className="segment-body">
							{option.label}
							{option.count !== undefined && option.count > 0 && <span className="segment-count">{option.count}</span>}
						</span>
					</button>
				)
			})}
		</div>
	)
}

// ---------------------------------------------------------------------------
// Push-nav header — §3.10

export function PushHeader({
	title,
	onBack,
	trailing,
}: {
	/** Names the content (§3.10): an item page passes the item's display name,
	 *  never a type word ("Item"); single-line ellipsis handles length. */
	title: string
	onBack: () => void
	trailing?: ReactNode
}) {
	return (
		<header className="push-header">
			<IconBtn label="Back" onClick={onBack}>
				{GLYPH.back}
			</IconBtn>
			<h1 className="push-title" data-page-heading tabIndex={-1}>
				{title}
			</h1>
			{trailing && <div className="push-trailing">{trailing}</div>}
		</header>
	)
}

// ---------------------------------------------------------------------------
// Empty / waiting state — §3.13 (state first, then direction)

export function EmptyState({ title, detail }: { title: string; detail: string }) {
	return (
		<div className="empty-wrap">
			<div className="empty-card">
				<div className="empty-title">{title}</div>
				<div className="empty-detail">{detail}</div>
			</div>
		</div>
	)
}

// ---------------------------------------------------------------------------
// Banner — §3.12 (clamped to 4 lines; the block itself toggles expansion)

function clampedNodeOverflows(node: HTMLElement): boolean {
	const clone = node.cloneNode(true) as HTMLElement
	clone.style.position = 'fixed'
	clone.style.visibility = 'hidden'
	clone.style.pointerEvents = 'none'
	clone.style.left = '-10000px'
	clone.style.top = '0'
	clone.style.width = `${node.clientWidth}px`
	clone.style.display = 'block'
	clone.style.webkitLineClamp = 'unset'
	clone.style.maxHeight = 'none'
	clone.style.height = 'auto'
	clone.style.overflow = 'visible'
	document.body.append(clone)
	const fullHeight = clone.scrollHeight
	clone.remove()
	return fullHeight > node.clientHeight + 1
}

export function Banner({
	tone,
	label,
	children,
}: {
	tone: 'error' | 'warning' | 'info'
	label?: string
	children: ReactNode
}) {
	const [expanded, setExpanded] = useState(false)
	const [overflows, setOverflows] = useState(false)
	const id = useId()
	const bodyRef = useRef<HTMLSpanElement>(null)
	useEffect(() => {
		const node = bodyRef.current
		if (!node) return
		const measure = () => {
			if (!expanded) setOverflows(clampedNodeOverflows(node))
		}
		measure()
		const observer = new ResizeObserver(measure)
		observer.observe(node)
		return () => observer.disconnect()
	}, [expanded])
	if (!overflows && !expanded)
		return (
			<div className={`banner banner-${tone} banner-clamped`}>
				<span className="banner-label">{label}</span>
				<span className="banner-body" ref={bodyRef}>
					{children}
				</span>
			</div>
		)
	return (
		<button
			type="button"
			className={`banner banner-${tone}${expanded ? '' : ' banner-clamped'}`}
			onClick={() => setExpanded(prev => !prev)}
			aria-expanded={expanded}
			aria-controls={id}
		>
			{label && <span className="banner-label">{label}</span>}
			<span id={id} className="banner-body" ref={bodyRef}>
				{children}
			</span>
			<span className="clamp-cue">{expanded ? 'Less' : 'More'}</span>
		</button>
	)
}

/** Clamped body text (run summaries etc.); the block itself is the toggle
 *  (§3.12), with a quiet More/Less cue shown only when the text overflows. */
export function ClampText({ text, lines = 4 }: { text: string; lines?: number }) {
	const [expanded, setExpanded] = useState(false)
	const [overflows, setOverflows] = useState(false)
	const bodyRef = useRef<HTMLSpanElement>(null)
	const contentId = useId()
	// Re-measure while clamped so a pane resize cannot hide text without
	// exposing the More control.
	useEffect(() => {
		const node = bodyRef.current
		if (!node) return
		const measure = () => {
			if (!expanded) setOverflows(clampedNodeOverflows(node))
		}
		measure()
		const observer = new ResizeObserver(measure)
		observer.observe(node)
		return () => observer.disconnect()
	}, [expanded])
	if (!overflows && !expanded)
		return (
			<span className="clamp-text clamped">
				<span ref={bodyRef} className="clamp-body" style={{ WebkitLineClamp: lines } as React.CSSProperties}>
					{text}
				</span>
			</span>
		)
	return (
		<button
			type="button"
			className={`clamp-text${expanded ? '' : ' clamped'}`}
			onClick={() => setExpanded(prev => !prev)}
			aria-expanded={expanded}
			aria-controls={contentId}
		>
			<span
				id={contentId}
				ref={bodyRef}
				className="clamp-body"
				style={expanded ? undefined : ({ WebkitLineClamp: lines } as React.CSSProperties)}
			>
				{text}
			</span>
			{(overflows || expanded) && <span className="clamp-cue">{expanded ? 'Less' : 'More'}</span>}
		</button>
	)
}

// ---------------------------------------------------------------------------
// Inline disclosure — §3.20

/** Quiet show/hide toggle for heavy in-place evidence (log, solve input, run
 *  setup pickers). Content SNAPS open — never height-animated (§2.5) — and is
 *  rendered only while open, so a collapsed well contributes zero DOM to the
 *  always-mounted nav-page layers. `defaultOpen` applies at mount only: a
 *  status flip mid-read must never collapse a section the user opened. */
export function Disclosure({
	label,
	hideLabel,
	defaultOpen,
	open: controlledOpen,
	onToggle,
	children,
}: {
	/** Verb-first cue while closed ("Show log"). */
	label: string
	/** Verb-first cue while open ("Hide log"). */
	hideLabel: string
	defaultOpen?: boolean
	/** Controlled mode: the caller owns the open bit (single source of truth
	 *  when something else — e.g. the live log tail — also reads it). */
	open?: boolean
	onToggle?: (open: boolean) => void
	children: ReactNode
}) {
	const [internalOpen, setInternalOpen] = useState(defaultOpen ?? false)
	const open = controlledOpen ?? internalOpen
	const contentId = useId()
	return (
		<>
			<button
				type="button"
				className="detail-disclosure"
				aria-expanded={open}
				aria-controls={contentId}
				onClick={() => {
					if (controlledOpen === undefined) setInternalOpen(!open)
					onToggle?.(!open)
				}}
			>
				{open ? hideLabel : label}
			</button>
			{open && (
				// Layout-neutral (display: contents) — content labels itself.
				<div id={contentId} className="disclosure-content">
					{children}
				</div>
			)}
		</>
	)
}

// ---------------------------------------------------------------------------
// Cards & rows

export function Card({
	label,
	children,
	trailing,
	flush,
}: {
	label?: string
	children: ReactNode
	trailing?: ReactNode
	/** Zero row gap — nav rows stack at their exact 36px pitch (§3.15). */
	flush?: boolean
}) {
	const headingId = useId()
	return (
		<section className={`card${flush ? ' card-flush' : ''}`} aria-labelledby={label ? headingId : undefined}>
			{(label || trailing) && (
				<div className="card-head">
					{label && (
						<h2 id={headingId} className="section-label">
							{label}
						</h2>
					)}
					{trailing}
				</div>
			)}
			{children}
		</section>
	)
}

/** Static fact row inside a card: label left, value right. */
export function InfoRow({ label, value, mono }: { label: string; value: ReactNode; mono?: boolean }) {
	return (
		<div className="info-row">
			<span className="info-label">{label}</span>
			<span className={`info-value${mono ? ' mono' : ''}`}>{value}</span>
		</div>
	)
}

/** Tappable row: pushes a sub-page (chevron), opens externally (↗), or copies.
 *  Only external links read as links (accent); push/copy values stay quiet. */
export function ActionRow({
	label,
	value,
	glyphKind = 'chevron',
	mono,
	nav,
	onClick,
	disabled,
}: {
	label: string
	value: string
	glyphKind?: 'chevron' | 'external' | 'copy'
	mono?: boolean
	/** Nav row (§3.15): the title IS the content — 13/400 --text-0 sentence
	 *  case, value 12 --text-1, 36px pitch. For section lists (settings),
	 *  not for fact rows inside a detail card. */
	nav?: boolean
	onClick: () => void
	disabled?: boolean
}) {
	const glyphNode = glyphKind === 'external' ? GLYPH.external : glyphKind === 'copy' ? GLYPH.copy : GLYPH.chevronRight
	// Push rows (chevron) sit at the 36px nav pitch; copy/external rows share
	// the 28px fact pitch (§3.15 card row rhythm).
	const push = glyphKind === 'chevron' && !nav
	return (
		<button
			type="button"
			className={`action-row${nav ? ' action-row-nav' : ''}${push ? ' action-row-push' : ''}`}
			onClick={onClick}
			disabled={disabled}
		>
			<span className={nav ? 'action-row-title' : 'info-label'}>{label}</span>
			<span className={`action-row-value${mono ? ' mono' : ''}${glyphKind === 'external' ? ' action-row-link' : ''}`}>
				{value}
			</span>
			<span className="action-row-glyph">{glyphNode}</span>
		</button>
	)
}

// ---------------------------------------------------------------------------
// Form fields — §3.7

export function FieldLabel({ children, htmlFor }: { children: ReactNode; htmlFor?: string }) {
	return (
		<label className="field-label" htmlFor={htmlFor}>
			{children}
		</label>
	)
}

export function TextInput({
	id,
	value,
	onChange,
	placeholder,
	type = 'text',
	invalid,
}: {
	id?: string
	value: string
	onChange: (value: string) => void
	placeholder?: string
	type?: 'text' | 'password' | 'number'
	invalid?: boolean
}) {
	return (
		<input
			id={id}
			className={`input${invalid ? ' input-invalid' : ''}`}
			type={type}
			value={value}
			placeholder={placeholder}
			onChange={event => onChange(event.target.value)}
		/>
	)
}

export function TextArea({
	id,
	value,
	onChange,
	placeholder,
	rows = 5,
}: {
	id?: string
	value: string
	onChange: (value: string) => void
	placeholder?: string
	rows?: number
}) {
	return (
		<textarea
			id={id}
			className="input textarea"
			value={value}
			placeholder={placeholder}
			rows={rows}
			onChange={event => onChange(event.target.value)}
		/>
	)
}

export function SelectInput({
	id,
	value,
	onChange,
	options,
	ariaLabel,
	disabled,
}: {
	id?: string
	value: string
	onChange: (value: string) => void
	options: Array<{ value: string; label: string }>
	ariaLabel?: string
	disabled?: boolean
}) {
	return (
		<select
			id={id}
			className="input select"
			value={value}
			aria-label={ariaLabel}
			disabled={disabled}
			onChange={event => onChange(event.target.value)}
		>
			{options.map(option => (
				<option key={option.value} value={option.value}>
					{option.label}
				</option>
			))}
		</select>
	)
}

export function Toggle({ label, value, onChange }: { label: string; value: boolean; onChange: (v: boolean) => void }) {
	return (
		<button
			type="button"
			className={`toggle${value ? ' toggle-on' : ''}`}
			role="switch"
			aria-checked={value}
			aria-label={label}
			onClick={() => onChange(!value)}
		>
			<span className="toggle-knob" />
		</button>
	)
}

// ---------------------------------------------------------------------------
// Sheet (modal over the pane) — §3.9

export function Sheet({
	title,
	onClose,
	children,
	footer,
}: {
	title: string
	onClose: () => void
	children: ReactNode
	footer: ReactNode
}) {
	const sheetRef = useRef<HTMLDivElement>(null)
	const openerRef = useRef<HTMLElement | null>(null)

	// Esc closes (capture, so the push stack never also pops); focus is trapped
	// inside the sheet; initial focus lands on the first field.
	useEffect(() => {
		openerRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
		const node = sheetRef.current
		if (!node) return
		const focusables = () =>
			Array.from(
				node.querySelectorAll<HTMLElement>('button, input, select, textarea, [tabindex]:not([tabindex="-1"])'),
			).filter(el => !el.hasAttribute('disabled'))
		const first = focusables().find(el => el.matches('input, select, textarea')) ?? focusables()[0]
		first?.focus()
		const onKeyDown = (event: KeyboardEvent) => {
			if (event.key === 'Escape') {
				event.stopPropagation()
				onClose()
				return
			}
			if (event.key !== 'Tab') return
			const list = focusables()
			const firstEl = list[0]
			const lastEl = list[list.length - 1]
			if (!firstEl || !lastEl) return
			if (event.shiftKey && document.activeElement === firstEl) {
				event.preventDefault()
				lastEl.focus()
			} else if (!event.shiftKey && document.activeElement === lastEl) {
				event.preventDefault()
				firstEl.focus()
			}
		}
		window.addEventListener('keydown', onKeyDown, { capture: true })
		return () => {
			window.removeEventListener('keydown', onKeyDown, { capture: true })
			openerRef.current?.focus()
		}
	}, [onClose])

	return (
		<div className="sheet-layer">
			<button type="button" className="sheet-scrim" aria-label="Close" onClick={onClose} tabIndex={-1} />
			{/* biome-ignore lint/a11y/useSemanticElements: native <dialog>.showModal() escapes the pane — this sheet is pane-scoped (§3.9); role+trap+Esc keep it accessible */}
			<div className="sheet" role="dialog" aria-modal="true" aria-label={title} ref={sheetRef}>
				<div className="sheet-head">
					<div className="sheet-title">{title}</div>
					<IconBtn label="Close" onClick={onClose}>
						{GLYPH.close}
					</IconBtn>
				</div>
				<div className="sheet-body">{children}</div>
				<div className="sheet-footer">{footer}</div>
			</div>
		</div>
	)
}
