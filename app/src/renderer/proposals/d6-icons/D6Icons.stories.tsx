// D6 Icons (docs/plans/design-system/proposals/D6.md): replace Helm's hand-drawn icons with sourced Heroicons?
// Every variant renders the REAL sidebar views and terminal workspace; only the icon geometry changes, swapped in
// through Storybook-only seams (icon-sets.tsx). Production code is untouched.
import { type Meta, type StoryObj, composeStories } from '@storybook/react-vite'
import { type ReactNode, type RefObject, useEffect, useRef, useState } from 'react'
import type { HelmApi } from '../../../shared'
import type { HelmSnapshot } from '../../../shared-helm'
import { IconBtn } from '../../icon-button'
import { DetailPage } from '../../sidebar/DetailPage'
import * as SidebarStories from '../../sidebar/SidebarViews.stories'
import { type TerminalWorkspaceFixtureOptions, TerminalWorkspaceFixtureView } from '../../terminal-workspace-fixtures'
import { Proposal } from '../proposal'
import {
	HAND_DRAWN,
	ICON_ROWS,
	VARIANT_STYLE,
	type VariantId,
	WithGlyphs,
	heroIconNode,
	iconFor,
	rowSize,
	swaps,
} from './icon-sets'

const { WorkList, ItemDetail } = composeStories(SidebarStories)

const COLUMNS: readonly { id: VariantId; label: string }[] = [
	{ id: 'current', label: 'Dnes' },
	{ id: 'a', label: 'A · micro' },
	{ id: 'b', label: 'B · outline' },
	{ id: 'c', label: 'C · micro 16' },
	{ id: 'd', label: 'D · outline, tah 2' },
]

const liveCount = HAND_DRAWN.filter(row => row.galleryOnly !== true).length
const galleryCount = HAND_DRAWN.length - liveCount
const handDrawnGlyphs = HAND_DRAWN.filter(row => row.glyph !== undefined).length
const COUNT_TEXT = `${liveCount} ikon v reálných pohledech + ${galleryCount} jen v galerii`

/** Rendered stroke width in px: a `width`-unit stroke in a `box`-unit viewBox drawn at `size` px. */
const strokePx = (box: number, size: number, width = 1.5) => `${((width * size) / box).toFixed(2)} px`
/** Rendered dot diameter in px for a dot of `units` viewBox units in a `box`-unit viewBox drawn at `size` px. */
const dotPx = (units: number, box: number, size: number) => `${((units * size) / box).toFixed(2)} px`
// Ellipsis dots: today r 1.3 (2.6 units, box 16); micro r 1.5 (3 units, box 16); outline r 0.75 + stroke.
const DOT_TODAY = dotPx(2.6, 16, 14)
const outlineDot = (width: number) => dotPx(1.5 + width, 24, 14)

const TERMINAL_OPTIONS: TerminalWorkspaceFixtureOptions = { sidebarVisibility: true }
const BUCKET_KEY = 'helm.sidebar.bucket'
/** The fixture's ready (Queue) Item from Views/Sidebar. */
const QUEUE_ITEM_ID = 'queue-story'

const STAGE_CSS = `
.proposal-stage { background: var(--chrome); }
.proposal-stage .d6 { padding: 16px 24px 8px; background: var(--chrome); color: var(--text-1); }
.proposal-stage .d6-heading { margin: 16px 0 8px; color: var(--text-0); font-size: 13px; font-weight: 600; }
.proposal-stage .d6-views-heading { margin: 8px 24px 0; }
.proposal-stage .d6-table { border-collapse: collapse; font-size: 12px; }
.proposal-stage .d6-table th { padding: 4px 12px; color: var(--text-2); font-weight: 500; text-align: left; }
.proposal-stage .d6-table th.d6-active { color: var(--text-0); box-shadow: inset 0 -2px 0 var(--accent); }
.proposal-stage .d6-table td { padding: 2px 12px; vertical-align: middle; }
.proposal-stage .d6-table .d6-key { color: var(--text-0); font-family: var(--font-mono); font-size: 11px; }
.proposal-stage .d6-table .d6-dim { color: var(--text-2); }
.proposal-stage .d6-terminal { position: relative; height: 300px; overflow: hidden; border: 1px solid var(--hairline); }
.proposal-stage .d6-terminal .terminal-workspace-fixture { height: 100%; }
.proposal-stage .d6-views { display: flex; flex-wrap: wrap; align-items: flex-start; background: var(--chrome); }
.proposal-stage .d6-views > div { flex: 0 0 auto; }
.proposal-stage .d6-frame { padding: 24px; }
.proposal-stage .d6-frame > .sidebar { width: 340px; height: 800px; box-shadow: var(--shadow-2); }
`

function Gallery({ variant }: { variant: VariantId }) {
	return (
		<table className="d6-table">
			<thead>
				<tr>
					<th>Ikona</th>
					<th>Kde</th>
					{COLUMNS.map(column => (
						<th key={column.id} className={column.id === variant ? 'd6-active' : undefined}>
							{column.id === variant ? `▸ ${column.label}` : column.label}
						</th>
					))}
					<th>Heroicons</th>
					<th>Poznámka</th>
				</tr>
			</thead>
			<tbody>
				{ICON_ROWS.map(row => (
					<tr key={row.key}>
						<td className="d6-key">{row.key}</td>
						<td className="d6-dim">{row.where}</td>
						{COLUMNS.map(column => (
							<td key={column.id}>
								<IconBtn label={`${row.key} · ${column.label}`}>{iconFor(row, column.id)}</IconBtn>
							</td>
						))}
						<td className="d6-dim">{row.hero}</td>
						<td className="d6-dim">{row.remark ?? ''}</td>
					</tr>
				))}
			</tbody>
		</table>
	)
}

/** The real terminal workspace; the plain-DOM sidebar toggle gets the variant's icon after the production mount. */
function TerminalView({ variant }: { variant: VariantId }) {
	const host = useRef<HTMLDivElement>(null)
	useEffect(() => {
		const root = host.current
		const row = ICON_ROWS.find(entry => entry.key === 'sidebarToggle')
		if (!root || !row || variant === 'current' || !swaps(row, variant)) return
		const style = VARIANT_STYLE[variant]
		const patch = () => {
			const toggle = root.querySelector<HTMLButtonElement>('#sidebar-toggle')
			if (!toggle || toggle.dataset.d6 === variant) return
			toggle.dataset.d6 = variant
			toggle.replaceChildren(heroIconNode(document, row.hero, style.set, rowSize(row, variant), style.strokeWidth))
		}
		const observer = new MutationObserver(patch)
		observer.observe(root, { childList: true, subtree: true })
		patch()
		return () => observer.disconnect()
	}, [variant])
	return (
		<div className="d6-terminal" ref={host}>
			<TerminalWorkspaceFixtureView options={TERMINAL_OPTIONS} />
		</div>
	)
}

/** Clicks the first enabled control `find` returns once it exists (views mount asynchronously). */
function useClickOnce(host: RefObject<HTMLDivElement | null>, find: (root: HTMLElement) => HTMLElement | null) {
	// biome-ignore lint/correctness/useExhaustiveDependencies: `find` is a static selector per call site.
	useEffect(() => {
		let tries = 0
		let timer: ReturnType<typeof setTimeout> | undefined
		const tick = () => {
			const root = host.current
			const target = root ? find(root) : null
			if (target) {
				target.click()
				return
			}
			tries += 1
			if (tries < 40) timer = setTimeout(tick, 100)
		}
		timer = setTimeout(tick, 200)
		return () => clearTimeout(timer)
	}, [host])
}

const moreTrigger = (label: string) => (root: HTMLElement) => {
	const trigger = root.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]:not([disabled])`)
	return trigger && trigger.getAttribute('aria-expanded') !== 'true' ? trigger : null
}

const queueOption = (root: HTMLElement) =>
	Array.from(root.querySelectorAll<HTMLButtonElement>('.segmented-index [role="radio"]')).find(option =>
		option.textContent?.trim().startsWith('Queue'),
	) ?? null

function Clicked({ find, children }: { find: (root: HTMLElement) => HTMLElement | null; children: ReactNode }) {
	const host = useRef<HTMLDivElement>(null)
	useClickOnce(host, find)
	return <div ref={host}>{children}</div>
}

/**
 * The production DetailPage for the fixture's ready (Queue) Item, so Start agent / Work manually and their icons are
 * on screen. The Views/Sidebar bridge answers every detail read with its review Item; this wraps only that read,
 * story-locally, to return the Queue Item's own row.
 */
function QueueItemDetail() {
	const [snapshot, setSnapshot] = useState<HelmSnapshot | null>(null)
	useEffect(() => {
		const daemon = (window as Window & { helm?: HelmApi }).helm?.daemon
		if (!daemon) return
		let live = true
		const original = daemon.item
		void daemon.subscribe().then(next => {
			if (!live) return
			const row = next.items?.find(entry => entry.id === QUEUE_ITEM_ID)
			if (!row) return
			daemon.item = async id => (id === QUEUE_ITEM_ID ? { data: row } : original(id))
			setSnapshot(next)
		})
		return () => {
			live = false
			daemon.item = original
		}
	}, [])
	return (
		<div className="d6-frame">
			<div className="sidebar">
				<div className="nav-viewport">
					<div className="nav-page">
						{snapshot === null ? null : (
							<DetailPage
								id={QUEUE_ITEM_ID}
								snapshot={snapshot}
								draft={{}}
								onDraftChange={() => {}}
								active
								onBack={() => {}}
								onOpenPlan={() => {}}
								onOpenTask={() => {}}
							/>
						)}
					</div>
				</div>
			</div>
		</div>
	)
}

/**
 * Real Views/Sidebar renders: the work list on Needs and on Queue (agent/manual row buttons), the Queue Item's detail
 * (Start agent / Work manually), the review detail, then separate copies with their More menus open. The list tab is
 * a stored preference; it starts on Needs here and the previous value is restored on unmount.
 */
function SidebarViews() {
	const [previousBucket] = useState(() => {
		const saved = localStorage.getItem(BUCKET_KEY)
		localStorage.setItem(BUCKET_KEY, 'needs')
		return saved
	})
	useEffect(() => {
		// Also on pagehide: a reload or direct navigation away from the iframe skips React cleanup.
		const restore = () => {
			if (previousBucket === null) localStorage.removeItem(BUCKET_KEY)
			else localStorage.setItem(BUCKET_KEY, previousBucket)
		}
		window.addEventListener('pagehide', restore)
		return () => {
			window.removeEventListener('pagehide', restore)
			restore()
		}
	}, [previousBucket])
	return (
		<>
			<h2 className="d6-heading d6-views-heading">Seznam (Needs, Queue), detail položky ve frontě, detail k revizi</h2>
			<div className="d6-views">
				<div>
					<WorkList />
				</div>
				<Clicked find={queueOption}>
					<WorkList />
				</Clicked>
				<QueueItemDetail />
				<div>
					<ItemDetail />
				</div>
			</div>
			<h2 className="d6-heading d6-views-heading">Menu More otevřená (samostatné kopie)</h2>
			<div className="d6-views">
				<Clicked find={moreTrigger('More')}>
					<WorkList />
				</Clicked>
				<Clicked find={moreTrigger('More actions')}>
					<ItemDetail />
				</Clicked>
			</div>
		</>
	)
}

function D6Page({
	variant,
	label,
	note,
	facts,
}: { variant: VariantId; label: string; note: string; facts: readonly string[] }) {
	return (
		<Proposal decision="D6" variant={label} note={note} facts={facts} css={STAGE_CSS}>
			<WithGlyphs variant={variant}>
				<div className="d6">
					<h2 className="d6-heading">Všechny ručně kreslené ikony v reálném IconBtn, ve skutečné velikosti</h2>
					<Gallery variant={variant} />
					<h2 className="d6-heading">Terminál: přepínač postranního panelu vlevo nahoře</h2>
					<TerminalView variant={variant} />
				</div>
				<SidebarViews />
			</WithGlyphs>
		</Proposal>
	)
}

const meta: Meta = {
	title: 'Proposals/D6 Icons',
	parameters: { layout: 'fullscreen' },
}

export default meta
type Story = StoryObj

export const Current: Story = {
	name: 'Current',
	render: () => (
		<D6Page
			variant="current"
			label="Current"
			note={`Dnes: ${handDrawnGlyphs} z 23 ikon GLYPH je kreslených ručně (tah 1.5 v boxu 16), plus přepínač panelu a 2 ikony v rozšíření. Bars-2 a calendar-days už jsou Heroicons micro.`}
			facts={[
				`tah při 14 px ${strokePx(16, 14)}`,
				`při 12 px ${strokePx(16, 12)}`,
				`tečky More ${DOT_TODAY}`,
				'panel: box 20, 16 px',
				'rozšíření: 10×6 a 10×8',
			]}
		/>
	),
}

export const A: Story = {
	name: 'A · Heroicons micro, dnešní velikost',
	render: () => (
		<D6Page
			variant="a"
			label="A · Heroicons micro 16 solid, dnešní velikost"
			note={`${COUNT_TEXT} nahrazeno sadou micro (16/solid, v2.2.0, MIT) beze změny geometrie; v dnešní velikosti 14/13/12 px, takže se rozvržení nehne. Ikony rozšíření (dnes 10×6 a 10×8) by šly do boxu 14. Plné tvary místo tahů: ozubené kolo, stop a play ztěžknou, šipky při 12 px zmenší.`}
			facts={[
				`tah micro při 14 px ${strokePx(16, 14)}`,
				`při 12 px ${strokePx(16, 12)}`,
				`tečky More ${dotPx(3, 16, 14)}`,
				'zmenšení 16→14: ×0.875',
				'agent → cpu-chip, panel → view-columns',
			]}
		/>
	),
}

export const B: Story = {
	name: 'B · Heroicons outline, dnešní velikost',
	render: () => (
		<D6Page
			variant="b"
			label="B · Heroicons outline 24, dnešní velikost"
			note={`${COUNT_TEXT} nahrazeno sadou outline (24/outline, v2.2.0, MIT) v dnešní velikosti; drží tahový charakter. Cena: tah o třetinu tenčí, tečky More menší a slabší, pause jsou dvě vlasové čáry. Ikony rozšíření (dnes 10×6 a 10×8) v boxu 14. Calendar a bars-2 (dnes micro) jdou také na outline, jinak by menu míchalo plné a tahové ikony; ostatní micro ikony (folder, background stack, Remote šipky, hvězda, chat) by se musely převést také, nebo aplikace míchá obě sady.`}
			facts={[
				`tah při 14 px ${strokePx(24, 14)} (dnes ${strokePx(16, 14)})`,
				`při 12 px ${strokePx(24, 12)} (dnes ${strokePx(16, 12)})`,
				`tečky More ${outlineDot(1.5)} (dnes ${DOT_TODAY})`,
				'zmenšení 24→14: ×0.58',
			]}
		/>
	),
}

export const C: Story = {
	name: 'C · Heroicons micro, nativních 16 px',
	render: () => (
		<D6Page
			variant="c"
			label="C · Heroicons micro 16 solid, nativních 16 px"
			note={`${COUNT_TEXT} sadou micro v nativní velikosti 16 px: nejbližší doslovnému čtení pravidla z AGENTS.md (to ale mluví o ovládání velikosti lišty). Ikony narostou o 2–4 px proti dnešku a v řádcích s textem vyčnívají.`}
			facts={[
				`tah ${strokePx(16, 16)}`,
				`tečky More ${dotPx(3, 16, 16)}`,
				'14→16 px: +2 px',
				'12→16 px: +4 px',
				'žádné zmenšení (ostré hrany)',
			]}
		/>
	),
}

export const D: Story = {
	name: 'D · Heroicons outline, tah 2 (doporučuji)',
	render: () => (
		<D6Page
			variant="d"
			label="D · Heroicons outline 24, tah 2, dnešní velikost (doporučuji)"
			note={`Stejné tvary jako B, jen šířka tahu 2 místo publikovaných 1.5 (geometrie cest beze změny). ${COUNT_TEXT}. Tah i tečky More jsou nejblíž dnešku, takže pohled zůstane tichý a tahový a ikony mají zdroj. Cena: tah 2 není výchozí vzhled Heroicons; drobné detaily (ozubené kolo, čip) jsou hustší. Calendar a bars-2 také na outline; ostatní micro ikony jako u B.`}
			facts={[
				`tah při 14 px ${strokePx(24, 14, 2)} (dnes ${strokePx(16, 14)})`,
				`při 12 px ${strokePx(24, 12, 2)} (dnes ${strokePx(16, 12)})`,
				`tečky More ${outlineDot(2)} (dnes ${DOT_TODAY})`,
				'zmenšení 24→14: ×0.58',
			]}
		/>
	),
}
