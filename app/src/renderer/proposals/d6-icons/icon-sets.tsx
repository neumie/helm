// D6 icon proposal: which Heroicon stands in for each hand-drawn Helm icon, and the Storybook-only seams that
// swap them inside the REAL views. Nothing here is imported by production code.
import { type ReactNode, useLayoutEffect, useMemo } from 'react'
import { GLYPH } from '../../sidebar/ui'
import { type HeroElement, MICRO, OUTLINE } from './heroicons'

export type HeroSet = 'micro' | 'outline'
export type VariantId = 'current' | 'a' | 'b' | 'c' | 'd'
export type HeroVariant = Exclude<VariantId, 'current'>

export interface VariantStyle {
	readonly set: HeroSet
	/** 'slot' keeps today's rendered size. */
	readonly size: 'slot' | 16
	/** Outline stroke width in viewBox units (Heroicons publish 1.5). Micro is filled and ignores it. */
	readonly strokeWidth: number
}

/** How each proposal variant draws a replaced icon. */
export const VARIANT_STYLE: Readonly<Record<HeroVariant, VariantStyle>> = {
	a: { set: 'micro', size: 'slot', strokeWidth: 1.5 },
	b: { set: 'outline', size: 'slot', strokeWidth: 1.5 },
	c: { set: 'micro', size: 16, strokeWidth: 1.5 },
	d: { set: 'outline', size: 'slot', strokeWidth: 2 },
}

type GlyphKey = keyof typeof GLYPH

export interface IconRow {
	/** GLYPH key, or a non-GLYPH site. */
	readonly key: string
	readonly glyph?: GlyphKey
	/** Where production shows it (English UI names). */
	readonly where: string
	/** Rendered size today, px. */
	readonly slot: number
	/** Box size for the replacement when today's art is not a square box (extension 10×6 / 10×8 drawings). */
	readonly heroSlot?: number
	/** Heroicons name (same name in 16/solid and 24/outline). */
	readonly hero: string
	/** Already a Heroicons micro icon in production: kept as is in micro variants, moved to outline in outline
	 * variants so one menu never mixes filled and stroked icons. */
	readonly sourcedMicro?: true
	/** Shown only in the gallery: not used in production, or not swappable in a live view (extension, CSS). */
	readonly galleryOnly?: true
	/** Short Czech remark shown in the gallery. */
	readonly remark?: string
}

/** Every hand-drawn icon (GLYPH + the sidebar toggle + the extension), plus the two GLYPH icons that are already
 * Heroicons, in GLYPH order. Slot sizes are read from ui.tsx / sidebar-layout.ts / extension Widget.tsx. */
export const ICON_ROWS: readonly IconRow[] = [
	{ key: 'plus', glyph: 'plus', where: 'New item, Create source task, Remote', slot: 14, hero: 'plus' },
	{
		key: 'menu',
		glyph: 'menu',
		where: 'Review contents, Remote drawer',
		slot: 16,
		hero: 'bars-2',
		sourcedMicro: true,
		remark: 'už micro; v B/D outline',
	},
	{ key: 'back', glyph: 'back', where: 'Back (push header, Remote)', slot: 14, hero: 'chevron-left' },
	{ key: 'chevronRight', glyph: 'chevronRight', where: 'Nav row, Remote disclosure', slot: 12, hero: 'chevron-right' },
	{
		key: 'chevronDown',
		glyph: 'chevronDown',
		where: 'Project filter, status chip, Remote',
		slot: 12,
		hero: 'chevron-down',
	},
	{ key: 'ellipsis', glyph: 'ellipsis', where: 'More, More actions', slot: 14, hero: 'ellipsis-horizontal' },
	{ key: 'external', glyph: 'external', where: 'Open source task, links', slot: 12, hero: 'arrow-top-right-on-square' },
	{ key: 'copy', glyph: 'copy', where: 'Copy (action row)', slot: 12, hero: 'square-2-stack' },
	{ key: 'check', glyph: 'check', where: 'Set as done, menu check', slot: 14, hero: 'check' },
	{
		key: 'agent',
		glyph: 'agent',
		where: 'Start agent, Agent mode',
		slot: 14,
		hero: 'cpu-chip',
		remark: 'Heroicons nemají robota; použit čip',
	},
	{ key: 'manual', glyph: 'manual', where: 'Work manually, Manual mode', slot: 14, hero: 'user' },
	{ key: 'play', glyph: 'play', where: 'Resume queue, Enable schedule', slot: 14, hero: 'play' },
	{ key: 'queue', glyph: 'queue', where: 'Approve and queue, Remote', slot: 14, hero: 'arrow-down-tray' },
	{ key: 'retry', glyph: 'retry', where: 'Queue retry, Poll now', slot: 14, hero: 'arrow-path' },
	{ key: 'stop', glyph: 'stop', where: 'Cancel run, Remote Interrupt', slot: 14, hero: 'stop' },
	{ key: 'pause', glyph: 'pause', where: 'Pause queue, Disable schedule', slot: 14, hero: 'pause' },
	{ key: 'return', glyph: 'return', where: 'Return to Queue, Remote', slot: 14, hero: 'arrow-uturn-left' },
	{ key: 'plan', glyph: 'plan', where: 'Plan, planned row', slot: 13, hero: 'document-text' },
	{ key: 'archive', glyph: 'archive', where: 'Archive', slot: 14, hero: 'archive-box' },
	{
		key: 'calendar',
		glyph: 'calendar',
		where: 'Scheduled runs',
		slot: 14,
		hero: 'calendar-days',
		sourcedMicro: true,
		remark: 'už micro; v B/D outline',
	},
	{
		key: 'group',
		glyph: 'group',
		where: 'not used in production',
		slot: 14,
		hero: 'rectangle-group',
		galleryOnly: true,
		remark: 'nepoužitá; smazat?',
	},
	{ key: 'settings', glyph: 'settings', where: 'Settings', slot: 14, hero: 'cog-6-tooth' },
	{ key: 'close', glyph: 'close', where: 'Close, Reject, Remove', slot: 14, hero: 'x-mark' },
	{
		key: 'sidebarToggle',
		where: 'Topbar: Hide task sidebar',
		slot: 16,
		hero: 'view-columns',
		remark: 'Heroicons nemají panel; nejbližší',
	},
	{
		key: 'extensionChevron',
		where: 'Extension model picker, select chevron (CSS)',
		slot: 10,
		heroSlot: 14,
		hero: 'chevron-down',
		galleryOnly: true,
		remark: 'jen galerie (Solid / CSS); dnes 10×6, náhrada v boxu 14',
	},
	{
		key: 'extensionCheck',
		where: 'Extension model check',
		slot: 10,
		heroSlot: 14,
		hero: 'check',
		galleryOnly: true,
		remark: 'jen galerie (Solid); dnes 10×8, náhrada v boxu 14',
	},
]

/** Hand-drawn today (sourcedMicro rows are already Heroicons). */
export const HAND_DRAWN: readonly IconRow[] = ICON_ROWS.filter(row => row.sourcedMicro !== true)

/** Today's GLYPH values, captured once before any story swaps them. Kept on globalThis so a hot reload of this
 * module while a variant is shown cannot capture the swapped icons as "original". */
const ORIGINAL_KEY = Symbol.for('helm.proposals.d6.originalGlyph')
const originalHolder = globalThis as unknown as Record<symbol, Readonly<Record<GlyphKey, ReactNode>> | undefined>
originalHolder[ORIGINAL_KEY] ??= { ...GLYPH }
const ORIGINAL_GLYPH: Readonly<Record<GlyphKey, ReactNode>> = originalHolder[ORIGINAL_KEY]

/** Whether `variant` draws this row with a Heroicon (false = today's drawing). */
export function swaps(row: IconRow, variant: VariantId): boolean {
	if (variant === 'current') return false
	return row.sourcedMicro !== true || VARIANT_STYLE[variant].set === 'outline'
}

export function HeroIcon({
	name,
	set,
	size,
	strokeWidth = 1.5,
}: { name: string; set: HeroSet; size: number; strokeWidth?: number }) {
	const elements: readonly HeroElement[] | undefined = (set === 'micro' ? MICRO : OUTLINE)[name]
	if (elements === undefined) throw new Error(`Missing Heroicon ${set}/${name}`)
	const box = set === 'micro' ? 16 : 24
	const stroke =
		set === 'outline'
			? { stroke: 'currentColor', strokeWidth, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const }
			: {}
	return (
		<svg
			width={size}
			height={size}
			viewBox={`0 0 ${box} ${box}`}
			fill={set === 'micro' ? 'currentColor' : 'none'}
			aria-hidden="true"
		>
			{elements.map(element =>
				element.tag === 'rect' ? (
					<rect
						key={`${element.x}-${element.y}`}
						x={element.x}
						y={element.y}
						width={element.width}
						height={element.height}
						rx={element.rx}
						{...stroke}
					/>
				) : (
					<path
						key={element.d}
						d={element.d}
						fillRule={element.fillRule as 'evenodd' | undefined}
						clipRule={element.clipRule}
						{...stroke}
					/>
				),
			)}
		</svg>
	)
}

/** The same Heroicon as a detached DOM node, for plain-DOM production surfaces (sidebar toggle). */
export function heroIconNode(
	doc: Document,
	name: string,
	set: HeroSet,
	size: number,
	strokeWidth = 1.5,
): SVGSVGElement {
	const ns = 'http://www.w3.org/2000/svg'
	const elements = (set === 'micro' ? MICRO : OUTLINE)[name]
	if (elements === undefined) throw new Error(`Missing Heroicon ${set}/${name}`)
	const box = set === 'micro' ? 16 : 24
	const svg = doc.createElementNS(ns, 'svg')
	svg.setAttribute('width', String(size))
	svg.setAttribute('height', String(size))
	svg.setAttribute('viewBox', `0 0 ${box} ${box}`)
	svg.setAttribute('fill', set === 'micro' ? 'currentColor' : 'none')
	svg.setAttribute('aria-hidden', 'true')
	for (const element of elements) {
		const node = doc.createElementNS(ns, element.tag)
		for (const [attribute, value] of [
			['d', element.d],
			['x', element.x],
			['y', element.y],
			['width', element.width],
			['height', element.height],
			['rx', element.rx],
			['fill-rule', element.fillRule],
			['clip-rule', element.clipRule],
		] as const) {
			if (value !== undefined) node.setAttribute(attribute, value)
		}
		if (set === 'outline') {
			node.setAttribute('stroke', 'currentColor')
			node.setAttribute('stroke-width', String(strokeWidth))
			node.setAttribute('stroke-linecap', 'round')
			node.setAttribute('stroke-linejoin', 'round')
		}
		svg.append(node)
	}
	return svg
}

export function rowSize(row: IconRow, variant: HeroVariant): number {
	const style = VARIANT_STYLE[variant]
	return style.size === 'slot' ? (row.heroSlot ?? row.slot) : style.size
}

/** The GLYPH table a variant renders with. Already-sourced micro icons stay as they are in micro variants. */
export function glyphSet(variant: VariantId): Readonly<Record<GlyphKey, ReactNode>> {
	if (variant === 'current') return ORIGINAL_GLYPH
	const next: Record<GlyphKey, ReactNode> = { ...ORIGINAL_GLYPH }
	for (const row of ICON_ROWS) {
		if (row.glyph === undefined || !swaps(row, variant)) continue
		next[row.glyph] = heroFor(row, variant)
	}
	return next
}

let activeOwner: symbol | null = null

function assignGlyphs(values: Readonly<Record<GlyphKey, ReactNode>>): void {
	const target = GLYPH as Record<GlyphKey, ReactNode>
	for (const key of Object.keys(values) as GlyphKey[]) target[key] = values[key]
}

/**
 * Story-only: renders its children with GLYPH swapped to `variant`'s icons. The production components read
 * `GLYPH.x` while rendering, so the real views pick up the swap without any production change. Applied during
 * render (children render after this body) and again in a layout effect (after a previous story's cleanup).
 */
export function WithGlyphs({ variant, children }: { variant: VariantId; children: ReactNode }) {
	const values = useMemo(() => glyphSet(variant), [variant])
	assignGlyphs(values)
	useLayoutEffect(() => {
		const owner = Symbol(variant)
		activeOwner = owner
		assignGlyphs(values)
		return () => {
			if (activeOwner !== owner) return
			activeOwner = null
			assignGlyphs(ORIGINAL_GLYPH)
		}
	}, [values, variant])
	return <>{children}</>
}

/** Today's hand-drawn icons that are not GLYPH entries, copied verbatim from their production sites. */
export function currentNonGlyph(key: string): ReactNode {
	if (key === 'sidebarToggle')
		// sidebar-layout.ts: 20-unit box, rect 3,4 14×12 r2 + M8 4v12, stroke 1.5.
		return (
			<svg
				width="16"
				height="16"
				viewBox="0 0 20 20"
				fill="none"
				stroke="currentColor"
				strokeWidth="1.5"
				aria-hidden="true"
			>
				<rect x="3" y="4" width="14" height="12" rx="2" />
				<path d="M8 4v12" />
			</svg>
		)
	if (key === 'extensionChevron')
		// extension/src/Widget.tsx model picker chevron (and the same geometry as sidebar.css's select data URI).
		return (
			<svg width="10" height="6" viewBox="0 0 10 6" aria-hidden="true">
				<path
					d="M1 1l4 4 4-4"
					fill="none"
					stroke="currentColor"
					strokeWidth="1.5"
					strokeLinecap="round"
					strokeLinejoin="round"
				/>
			</svg>
		)
	if (key === 'extensionCheck')
		// extension/src/Widget.tsx model option check.
		return (
			<svg width="10" height="8" viewBox="0 0 10 8" aria-hidden="true">
				<path
					d="M1 4l2.6 2.6L9 1"
					fill="none"
					stroke="currentColor"
					strokeWidth="1.6"
					strokeLinecap="round"
					strokeLinejoin="round"
				/>
			</svg>
		)
	throw new Error(`Unknown icon ${key}`)
}

function heroFor(row: IconRow, variant: HeroVariant): ReactNode {
	const style = VARIANT_STYLE[variant]
	return <HeroIcon name={row.hero} set={style.set} size={rowSize(row, variant)} strokeWidth={style.strokeWidth} />
}

export function iconFor(row: IconRow, variant: VariantId): ReactNode {
	if (variant === 'current' || !swaps(row, variant)) {
		if (row.glyph !== undefined) return ORIGINAL_GLYPH[row.glyph]
		return currentNonGlyph(row.key)
	}
	return heroFor(row, variant)
}
