// D4 — `--radius-sm/md/lg` are used but never defined, so four corners render square
// (docs/plans/design-system/proposals/D4.md). Every variant mounts the same real production surfaces:
// the terminal workspace with the tab menu's "Create group" name form, the item detail with its status menu open,
// the Finish setup sheet and the Remote pairing QR. Only the variant changes the radius.
import type { Meta, StoryObj } from '@storybook/react-vite'
import { composeStories } from '@storybook/react-vite'
import type { ReactNode } from 'react'
import * as MenuStories from '../../sidebar/Menus.stories'
import * as SidebarStories from '../../sidebar/SidebarViews.stories'
import { TerminalWorkspaceFixtureView } from '../../terminal-workspace-fixtures'
import { Proposal, type TokenOverrides } from '../proposal'

const { ItemDetail, RemotePairingCode } = composeStories(SidebarStories)
const { FinishItemSetupSheet } = composeStories(MenuStories)

// Framing only (same in every variant): the reused story frames are full-viewport; here they share one page.
const FRAME_CSS = `
.proposal-stage .d4-board { display: grid; gap: 16px; padding: 16px; }
.proposal-stage .d4-row { display: grid; grid-template-columns: repeat(3, 340px); gap: 16px; align-items: start; }
.proposal-stage .d4-cell { display: grid; gap: 6px; min-width: 0; }
.proposal-stage .d4-label { color: var(--text-2); font: 12px / 18px var(--font-ui); }
.proposal-stage .d4-terminal { height: 240px; overflow: hidden; border: 1px solid var(--hairline); }
.proposal-stage .d4-terminal #app { height: 240px; }
.proposal-stage .d4-sidebar > div { min-height: 0 !important; padding: 0 !important; display: block !important; }
.proposal-stage .d4-sidebar .sidebar { height: 360px !important; box-shadow: none !important; border: 1px solid var(--hairline); }
.proposal-stage .d4-sheet > div { border: 1px solid var(--hairline); }
.proposal-stage .d4-zoom-row { display: flex; gap: 16px; align-items: start; }
.proposal-stage .d4-zoom { width: 336px; height: 180px; overflow: hidden; border: 1px solid var(--hairline); }
.proposal-stage .d4-zoom > div { zoom: 3; pointer-events: none; }
`

/** Spec §2.4: lg 8 (sheets, menus, cards), md 6 (buttons, inputs), sm 4 (mini affordances). */
const DEFINED: TokenOverrides = { '--radius-sm': '4px', '--radius-md': '6px', '--radius-lg': '8px' }

/** Variant A2 also moves the 28px group-name field to the §3.7 field radius. The form is appended to <body>. */
const NAME_FIELD_MD_CSS = `
.menu-name-input { border-radius: var(--radius-md); }
`

/** Variant B rewrites the four uses to an explicit 0. The name form is appended to <body>, outside the stage. */
const SQUARE_CSS = `
.menu-name-input,
.proposal-stage .status-menu-trigger,
.proposal-stage .sheet,
.proposal-stage .remote-qr { border-radius: 0; }
`

function Board() {
	return (
		<div className="d4-board">
			<div className="d4-cell">
				<span className="d4-label">
					Terminál · menu tabu → Move to new group… (styles.css .menu-name-input, dnes --radius-sm)
				</span>
				<div className="d4-terminal">
					<TerminalWorkspaceFixtureView options={{}} />
				</div>
			</div>
			<div className="d4-row">
				<Cell label="Detail položky · stav (detail-redesign.css .status-menu-trigger, --radius-sm)">
					<div className="d4-sidebar">
						<ItemDetail />
					</div>
				</Cell>
				<Cell label="Finish setup sheet (sidebar.css .sheet, --radius-lg)">
					<div className="d4-sheet">
						<FinishItemSetupSheet />
					</div>
				</Cell>
				<Cell label="Settings → Remote · QR (sidebar.css .remote-qr, --radius-md)">
					<div className="d4-sidebar">
						<RemotePairingCode />
					</div>
				</Cell>
			</div>
			<div className="d4-cell">
				<span className="d4-label">
					Výřez 3× · levý horní roh sheetu (stejný sheet ještě jednou, jen zvětšený; ostatní rohy přibliž ⌘+)
				</span>
				<div className="d4-zoom-row">
					<div className="d4-zoom" aria-hidden="true" inert>
						<div>
							<FinishItemSetupSheet />
						</div>
					</div>
				</div>
			</div>
		</div>
	)
}

function Cell({ label, children }: { label: string; children: ReactNode }) {
	return (
		<div className="d4-cell">
			<span className="d4-label">{label}</span>
			{children}
		</div>
	)
}

async function waitFor<T extends Element>(find: () => T | null | undefined, what: string): Promise<T> {
	const deadline = Date.now() + 8000
	for (;;) {
		const found = find()
		if (found) return found
		if (Date.now() > deadline) throw new Error(`D4 story: ${what} did not appear`)
		await new Promise(resolve => setTimeout(resolve, 50))
	}
}

/** Opens the two surfaces that are only visible on interaction: the status menu and the group-name form. */
async function openSurfaces({ canvasElement }: { canvasElement: HTMLElement }): Promise<void> {
	const trigger = await waitFor(
		() => canvasElement.querySelector<HTMLButtonElement>('.status-menu-trigger'),
		'status menu trigger',
	)
	trigger.click()
	const tab = await waitFor(() => canvasElement.querySelector<HTMLElement>('#tabs .tab'), 'terminal tab')
	const box = tab.getBoundingClientRect()
	tab.dispatchEvent(
		new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: box.left + 24, clientY: box.bottom + 4 }),
	)
	const createGroup = await waitFor(
		() =>
			[...document.querySelectorAll<HTMLButtonElement>('.menu-panel button')].find(button =>
				button.textContent?.includes('Move to new group'),
			),
		'Move to new group… entry',
	)
	createGroup.click()
	const input = await waitFor(() => document.querySelector<HTMLInputElement>('.menu-name-input'), 'group name field')
	input.value = 'Release'
	// The QR sits below the fold of the 360px frame: scroll its own page so the QR ends near the frame's bottom and the
	// copy above it is not half under the sticky header (never scroll the window).
	const qr = await waitFor(() => canvasElement.querySelector<HTMLElement>('.remote-qr'), 'Remote QR')
	const scroller = qr.closest<HTMLElement>('.page-scroll')
	if (scroller) scroller.scrollTop += qr.getBoundingClientRect().bottom - scroller.getBoundingClientRect().bottom + 24
	// The 3× crop shows the top-left corner of its own sheet copy.
	const crop = await waitFor(() => canvasElement.querySelector<HTMLElement>('.d4-zoom'), 'zoom crop')
	const cornerSheet = await waitFor(() => crop.querySelector<HTMLElement>('.sheet'), 'zoomed sheet')
	const corner = cornerSheet.getBoundingClientRect()
	const frame = crop.getBoundingClientRect()
	crop.scrollTop += corner.top - frame.top - 24
	crop.scrollLeft += corner.left - frame.left - 24
}

const meta: Meta = {
	title: 'Proposals/D4 Radius',
	parameters: { layout: 'fullscreen' },
	play: openSurfaces,
}

export default meta
type Story = StoryObj

export const Current: Story = {
	name: 'Current · hranaté (tokeny nedefinované)',
	render: () => (
		<Proposal
			decision="D4"
			variant="Current · hranaté"
			note="Dnes: --radius-sm/md/lg nikde nejsou definované, takže tyto čtyři rohy padají na 0. Všechno okolo (menu, tlačítka, pole v sheetu) je zaoblené. Rozdíl je jen v rozích (4–8px): přibliž ⌘+."
			facts={[
				'--radius-sm/md/lg: nedefinováno',
				'.menu-name-input 0px',
				'.status-menu-trigger 0px',
				'.sheet 0px',
				'.remote-qr 0px',
				'menu panel 8px, pole v sheetu 6px',
			]}
			css={FRAME_CSS}
		>
			<Board />
		</Proposal>
	),
}

export const A: Story = {
	name: 'A · tokeny podle §2.4',
	render: () => (
		<Proposal
			decision="D4"
			variant="A · definovat tokeny podle §2.4"
			note="Tokeny dostanou hodnoty ze specifikace, CSS se nemění. Pole jména skupiny ale v CSS bere --radius-sm, takže bude jediné 28px pole se 4px rohem vedle 6px polí."
			facts={[
				'--radius-sm 4px',
				'--radius-md 6px',
				'--radius-lg 8px',
				'.menu-name-input 4px (ostatní 28px pole 6px)',
				'.status-menu-trigger 4px',
				'.sheet 8px',
				'.remote-qr 6px',
			]}
			overrides={DEFINED}
			css={FRAME_CSS}
		>
			<Board />
		</Proposal>
	),
}

export const A2: Story = {
	name: 'A2 · tokeny podle §2.4 + pole jména 6px (doporučuji)',
	render: () => (
		<Proposal
			decision="D4"
			variant="A2 · tokeny podle §2.4, pole jména na --radius-md (doporučuji)"
			note="Jako A, navíc .menu-name-input přejde z --radius-sm na --radius-md: §3.7 dává 28px polím --radius-md, takže pole jména sedí s poli v sheetu a v Remote."
			facts={[
				'--radius-sm 4px',
				'--radius-md 6px',
				'--radius-lg 8px',
				'.menu-name-input 6px (jako ostatní 28px pole)',
				'.status-menu-trigger 4px',
				'.sheet 8px',
				'.remote-qr 6px',
			]}
			overrides={DEFINED}
			css={FRAME_CSS + NAME_FIELD_MD_CSS}
		>
			<Board />
		</Proposal>
	),
}

export const B: Story = {
	name: 'B · hranaté pravidlem (explicitní 0)',
	render: () => (
		<Proposal
			decision="D4"
			variant="B · hranaté pravidlem"
			note="Čtyři použití přepsat na border-radius: 0 a tokeny nezavádět. Vypadá stejně jako Current; mění se jen kód. Odporuje §2.4 a §3.9 (sheet má mít --radius-lg)."
			facts={[
				'.menu-name-input 0px',
				'.status-menu-trigger 0px',
				'.sheet 0px',
				'.remote-qr 0px',
				'použití s fallbackem (document-review, remote) dál doslova 4/6/8px',
			]}
			css={FRAME_CSS + SQUARE_CSS}
		>
			<Board />
		</Proposal>
	),
}
