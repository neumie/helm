// D13 — sidebar type that ignores Appearance → text size (docs/plans/design-system/proposals/D13.md).
// The only bare-px font-size left in sidebar.css / detail-redesign.css / scheduled-runs.css is
// `.menu-item .menu-hint { font-size: 11px }` (sidebar.css), the trailing shortcut hint of the terminal tab menu
// (and the "Current" word of the group colour menu). Every variant mounts the same real production surfaces three
// times, at --ui-scale 0.92 / 1 / 1.08: the terminal workspace with its tab context menu open (13px label + 11px
// hint on one row) and the sidebar Work menu (MenuButton, whose trailing `.menu-item-meta` is also 11px but scales).
import type { Meta, StoryObj } from '@storybook/react-vite'
import type { CSSProperties } from 'react'
import { GLYPH, MenuButton } from '../../sidebar/ui'
import { TerminalWorkspaceFixtureView } from '../../terminal-workspace-fixtures'
import { Proposal } from '../proposal'

/** Appearance → text size: Small, Default, Large (§2.2). */
const SCALES = [0.92, 1, 1.08] as const
const SCALE_NAMES: Record<(typeof SCALES)[number], string> = { 0.92: 'Small', 1: 'Default', 1.08: 'Large' }

const at = (base: number, scale: number) => Number((base * scale).toFixed(2))
const row = (base: number, scaled: boolean) => SCALES.map(scale => (scaled ? at(base, scale) : base)).join(' / ')

// Framing only (same in every variant). Each column carries its own --ui-scale (custom properties inherit), so all
// three scales sit side by side; :root stays 1. The tab menu is a fixed panel appended to <body> at the pointer: the
// play function moves each column's open panel into that column (so it inherits the column's --ui-scale and the
// variant CSS stays inside .proposal-stage) and the frame lays it out in flow instead of at the pointer.
const FRAME_CSS = `
.proposal-stage .d13-board { display: grid; grid-template-columns: repeat(3, 340px); gap: 24px; padding: 16px; align-items: start; }
.proposal-stage .d13-column { display: grid; gap: 8px; min-width: 0; }
.proposal-stage .d13-label { color: var(--text-2); font: 12px / 18px var(--font-ui); }
.proposal-stage .d13-terminal { height: 120px; overflow: hidden; border: 1px solid var(--hairline); }
.proposal-stage .d13-terminal #app { height: 120px; width: 760px; }
.proposal-stage .d13-tab-menu { min-height: 200px; }
.proposal-stage .d13-tab-menu > .menu-panel.menu-fixed { position: static; animation: none; width: max-content; }
.proposal-stage .d13-work-menu { height: 330px; }
.proposal-stage .d13-work-menu .menu-panel { animation: none; }
`

/** Variant A: the one bare rule written like every other sidebar size. */
const SCALED_HINT_CSS = `
.proposal-stage .menu-item .menu-hint { font-size: calc(11px * var(--ui-scale)); }
`

const noop = () => {}

function Column({ scale }: { scale: (typeof SCALES)[number] }) {
	return (
		<div className="d13-column" data-scale={scale} style={{ '--ui-scale': String(scale) } as CSSProperties}>
			<span className="d13-label">
				--ui-scale {scale} · {SCALE_NAMES[scale]}
			</span>
			<div className="d13-terminal">
				<TerminalWorkspaceFixtureView options={{}} />
			</div>
			<span className="d13-label">Menu tabu (pravý klik): label 13px, hint .menu-hint 11px</span>
			<div className="d13-tab-menu" />
			<span className="d13-label">Work → More (MenuButton): .menu-item-meta 11px</span>
			<div className="d13-work-menu">
				<MenuButton
					triggerLabel="More"
					trigger={GLYPH.ellipsis}
					align="start"
					entries={[
						{ label: 'Scheduled runs', icon: GLYPH.calendar, section: 'Work', onSelect: noop },
						{ label: 'Archive', icon: GLYPH.archive, meta: 12, onSelect: noop },
						{ label: 'Poll now', icon: GLYPH.retry, onSelect: noop },
						{ label: 'Pause queue', icon: GLYPH.pause, onSelect: noop },
						{
							label: 'Group by project',
							checked: false,
							checkedRole: 'checkbox',
							section: 'View',
							onSelect: noop,
						},
						{ label: 'Work', checked: true, section: 'Profiles', onSelect: noop },
						{ label: 'Personal', checked: false, onSelect: noop },
						{ label: 'Settings', icon: GLYPH.settings, onSelect: noop, group: true },
					]}
				/>
			</div>
		</div>
	)
}

function Board() {
	return (
		<div className="d13-board">
			{SCALES.map(scale => (
				<Column key={scale} scale={scale} />
			))}
		</div>
	)
}

async function waitFor<T>(find: () => T | null | undefined, what: string): Promise<T> {
	const deadline = Date.now() + 8000
	for (;;) {
		const found = find()
		if (found) return found
		if (Date.now() > deadline) throw new Error(`D13 story: ${what} did not appear`)
		await new Promise(resolve => setTimeout(resolve, 50))
	}
}

/** Opens each column's tab context menu (the real contextmenu path) and its Work menu (a trigger click). */
async function openMenus({ canvasElement }: { canvasElement: HTMLElement }): Promise<void> {
	const columns = [...canvasElement.querySelectorAll<HTMLElement>('.d13-column')]
	for (const column of columns) {
		const tab = await waitFor(() => column.querySelector<HTMLElement>('#tabs .tab'), 'terminal tab')
		const before = new Set(document.querySelectorAll('body > .menu-panel.menu-fixed'))
		// The workspace keeps its task-sidebar column on the left: scroll the narrow frame to the tab strip.
		const frame = column.querySelector<HTMLElement>('.d13-terminal')
		if (frame) frame.scrollLeft += tab.getBoundingClientRect().left - frame.getBoundingClientRect().left - 12
		const box = tab.getBoundingClientRect()
		tab.dispatchEvent(
			new MouseEvent('contextmenu', {
				bubbles: true,
				cancelable: true,
				clientX: box.left + 24,
				clientY: box.bottom + 4,
			}),
		)
		const panel = await waitFor(
			() => [...document.querySelectorAll<HTMLElement>('body > .menu-panel.menu-fixed')].find(p => !before.has(p)),
			'tab menu',
		)
		column.querySelector('.d13-tab-menu')?.append(panel)
	}
	for (const column of columns) {
		const trigger = await waitFor(
			() => column.querySelector<HTMLButtonElement>('.d13-work-menu button[aria-haspopup="menu"]'),
			'Work menu trigger',
		)
		trigger.click()
	}
}

const meta: Meta = {
	title: 'Proposals/D13 UI scale',
	parameters: { layout: 'fullscreen' },
	play: openMenus,
}

export default meta
type Story = StoryObj

export const Current: Story = {
	name: 'Current · hint 11px pevně',
	render: () => (
		<Proposal
			decision="D13"
			variant="Current · .menu-hint zůstává 11px"
			note="Jediná holá px velikost v sidebar CSS. Label vedle hintu i .menu-item-meta ve stejném menu se škálují, hint ne: na Large se hint vůči labelu zmenší, na Small je větší než meta 11px v sidebar menu."
			facts={[
				'škála 0.92 / 1 / 1.08',
				`.menu-hint ${row(11, false)}px`,
				`.menu-item-label ${row(13, true)}px`,
				`.menu-item-meta ${row(11, true)}px`,
				`hint/label ${SCALES.map(s => (11 / at(13, s)).toFixed(2)).join(' / ')}`,
			]}
			css={FRAME_CSS}
		>
			<Board />
		</Proposal>
	),
}

export const A: Story = {
	name: 'A · calc() i pro hint (doporučuji)',
	render: () => (
		<Proposal
			decision="D13"
			variant="A · .menu-hint calc(11px * var(--ui-scale)) (doporučuji)"
			note="Jeden řádek CSS. Na Default beze změny, na Small/Large se hint škáluje s labelem a sedí s .menu-item-meta (stejných 11px). Lint S3 nepotřebuje výjimku."
			facts={[
				'škála 0.92 / 1 / 1.08',
				`.menu-hint ${row(11, true)}px`,
				`.menu-item-label ${row(13, true)}px`,
				`.menu-item-meta ${row(11, true)}px`,
				'hint/label 0.85 všude',
			]}
			css={FRAME_CSS + SCALED_HINT_CSS}
		>
			<Board />
		</Proposal>
	),
}

export const B: Story = {
	name: 'B · hinty pevné pravidlem',
	render: () => (
		<Proposal
			decision="D13"
			variant="B · zkratkové hinty zůstávají v px (výjimka v lintu)"
			note="Vypadá přesně jako Current. Výjimka v allowlistu S3: jen sidebar.css .menu-item .menu-hint (zkratky v menu tabu, slovo Current v menu barvy skupiny). Ostatní mono metadata (.mono, log, .plan-doc summary, .remote-code) i .menu-item-meta se už škálují, takže pravidlo by mělo jediného člena."
			facts={[
				'škála 0.92 / 1 / 1.08',
				`.menu-hint ${row(11, false)}px`,
				`.menu-item-label ${row(13, true)}px`,
				`.menu-item-meta ${row(11, true)}px`,
				'allowlist: sidebar.css .menu-item .menu-hint',
			]}
			css={FRAME_CSS}
		>
			<Board />
		</Proposal>
	),
}
