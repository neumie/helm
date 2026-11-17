// D17 · Type sizes (docs/plans/design-system/proposals/D17.md §4): font sizes off §2.2 (11/12/13/17 plus the
// Review 15/21/28 and Remote 16 surface steps) outside Remote and the count badges: Unicode glyphs used as icons
// (+ ⇥ × ● at 16/14/9; §3.1 already sizes icon glyphs 14–16), Run Context 10/14/15, the PDF password title 14, the
// project-group count 10 and inline code 0.92em. Frames are the real production stories.
import type { Meta, StoryObj } from '@storybook/react-vite'
import { Proposal } from '../proposal'
import { BOARD_CSS, Board, type FrameContext, type FrameSpec, click, openWidget, waitFor } from './frame'

/** Right-clicks the Build group header and opens its Color… menu (the colored ● glyphs). */
async function openGroupColors({ doc, win }: FrameContext): Promise<void> {
	const toggle = await waitFor(() => doc.querySelector<HTMLElement>('.tab-group-toggle'), 'group header')
	const box = toggle.getBoundingClientRect()
	// The frame has its own realm: build the event with the frame's MouseEvent.
	const FrameMouseEvent = (win as Window & typeof globalThis).MouseEvent
	toggle.dispatchEvent(
		new FrameMouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: box.left + 8, clientY: box.bottom }),
	)
	await click(doc, '.menu-panel .menu-item', 'Color')
}

const FRAMES: readonly FrameSpec[] = [
	{
		id: 'views-terminal-workspace--tab-strip',
		label: 'Pás tabů · „+“ New terminal, dnes 16',
		width: 1280,
		height: 300,
		zoom: 4,
		crop: { selector: '#new-tab', pad: 6 },
	},
	{
		id: 'views-topbar-background-terminals--background-terminals',
		label: 'Background · ⇥ a × v řádku, dnes 16 a 14',
		width: 1280,
		height: 400,
		zoom: 3,
		setup: async ({ doc }) => {
			doc.querySelector<HTMLElement>('#bg-root > button')?.click()
			await waitFor(() => doc.querySelector('#bg-popover .bg-row')?.getBoundingClientRect().width, 'background list')
		},
		crop: { selector: '#bg-popover .bg-row', pad: 0 },
	},
	{
		id: 'views-terminal-workspace--grouped-tab-headers',
		label: 'Menu barvy skupiny · ●, dnes 14',
		width: 1280,
		height: 600,
		zoom: 2,
		setup: openGroupColors,
		crop: { selector: '.menu-panel.menu-fixed', pad: 4 },
	},
	{
		id: 'views-agent-dock-agents-pane--agent-detail',
		label: 'Dock · značka zprávy ●, dnes 9',
		width: 1200,
		height: 800,
		zoom: 3,
		crop: { selector: '.agent-dock-message', pad: 4, width: 240, height: 40 },
	},
	{
		id: 'views-extension-widget--closed-shadow',
		label: 'Rozšíření · zavřít ×, dnes 16',
		width: 560,
		height: 420,
		zoom: 3,
		setup: async frame => {
			await openWidget(frame)
		},
		crop: {
			find: ({ win }) =>
				(
					win as Window & { extensionWorkbench?: { query(selector: string): HTMLElement | null } }
				).extensionWorkbench?.query('.vg-card__hactions'),
			pad: 8,
		},
	},
	{
		id: 'compositions-list-row--project-groups',
		label: 'Seznam podle projektu · počet „2 items“, dnes 10',
		width: 460,
		height: 500,
		zoom: 3,
		crop: { selector: '.item-project-group-head', pad: 0 },
	},
	{
		id: 'views-run-context-editor--source-context',
		label: 'Run Context · nadtitulek a název, dnes 10 a 14',
		width: 1100,
		height: 600,
		zoom: 2,
		crop: { selector: '.run-context-heading', pad: 6, width: 480 },
	},
	{
		id: 'views-run-context-editor--source-context',
		label: 'Run Context · text dokumentu, dnes 14',
		width: 1100,
		height: 600,
		zoom: 1.5,
		crop: { selector: '.run-context-main', pad: 0, width: 720, height: 230 },
	},
	{
		id: 'views-run-context-editor--source-context',
		label: 'Run Context · popisek v liště (dt), dnes 10',
		width: 1100,
		height: 600,
		zoom: 2,
		crop: { selector: '.run-context-source dl', pad: 6 },
	},
	{
		id: 'views-document-review-pdf--locked',
		label: 'PDF · nadpis hesla, dnes 14',
		width: 1200,
		height: 600,
		zoom: 1.5,
		crop: { selector: '.viewer-pdf-password', pad: 8 },
	},
	{
		id: 'views-document-review-content-width--window-1400',
		label: 'Document Review · kód v textu, dnes 0.92em (15 → 13.8 px)',
		width: 1400,
		height: 900,
		zoom: 2,
		crop: { selector: '[data-reading-width] :not(pre) > code', pad: 12, width: 420 },
	},
]

/** The glyphs to the nearest §2.2 step (16 → 17, 14 → 13, 9 → 11). */
const GLYPHS_SNAPPED = `
#new-tab { font-size: 17px; }
.bg-action-glyph { font-size: 17px; }
.bg-kill-glyph { font-size: 13px; }
.menu-item-color { font-size: calc(13px * var(--ui-scale)); }
.agent-dock-message-mark { font-size: calc(11px * var(--ui-scale)); }
.vg-close, .vg-error__dismiss { font-size: 17px; }
`

/** Text that is not a glyph: Run Context, the PDF password title, the project-group count. */
const TEXT_ON_SCALE = (body: number) => `
.run-context-kicker, .run-context-source dt { font-size: calc(11px * var(--ui-scale)); }
.run-context-heading h1 { font-size: calc(13px * var(--ui-scale)); }
.run-context-editor .bn-editor { font-size: calc(${body}px * var(--ui-scale)); }
.run-context-dialog h2, .run-context-start-state h1 { font-size: calc(17px * var(--ui-scale)); }
.viewer-pdf-password-title { font-size: calc(13px * var(--ui-scale)); }
.item-project-group-head > span:last-child { font-size: calc(11px * var(--ui-scale)); }
`

/** A: everything to the nearest base step; inline code to Mono inline 11. */
const ALL_SNAPPED = `${GLYPHS_SNAPPED}${TEXT_ON_SCALE(13)}
[data-reading-width] :not(pre) > code, .remote-markdown code, .viewer-grid-letter, .viewer-grid-number { font-size: 11px; }
`

/** B: glyphs keep their icon-slot size, text on the scale with the editor on the reading step 15, code relative. */
const TEXT_ONLY = TEXT_ON_SCALE(15)

const meta: Meta = { title: 'Proposals/D17 Off-scale values/Type sizes', parameters: { layout: 'fullscreen' } }
export default meta
type Story = StoryObj

export const Current: Story = {
	name: 'Current · znaky 9 / 14 / 16, Run Context 10 / 14 / 15, 0.92em',
	render: () => (
		<Proposal
			decision="D17"
			variant="Current · znaky 9 / 14 / 16, Run Context 10 / 14 / 15, kód 0.92em"
			note="Znaky místo ikon (+ ⇥ × ●) mají velikost ikony, ne písma. Run Context má vlastní 10 / 14 / 15, PDF heslo 14, počet ve skupině projektu 10, kód v textu 0.92em okolního písma."
			facts={[
				'17 lint výjimek „type outside Remote and the count badges“',
				'znaky: + 16, ⇥ 16, × 14, ● menu 14, ● dock 9, × rozšíření 16',
				'Run Context: nadtitulek a dt 10, název a text 14, dialog 15',
				'kód v textu: 0.92em (13 → 12, 15 → 13.8, 16 → 14.7 px)',
			]}
			css={BOARD_CSS}
		>
			<Board frames={FRAMES} css="" />
		</Proposal>
	),
}

export const A: Story = {
	name: 'A · vše na stupnici 11 / 12 / 13 / 17',
	render: () => (
		<Proposal
			decision="D17"
			variant="A · vše na nejbližší krok 11 / 12 / 13 / 17"
			note="Znaky 16 → 17, 14 → 13, 9 → 11; Run Context 10 → 11, 14 → 13, 15 → 17; PDF heslo 13; počet 11; kód v textu Mono inline 11 px všude, takže v 15px čtení Review a 16px zprávách Remote je výrazně menší než text."
			facts={[
				'+ a ⇥ 17, × a ● 13, ● v docku 11 (větší tečka)',
				'text Run Context 14 → 13',
				'kód: 13.8 → 11 px v Review (0.73 textu)',
			]}
			css={BOARD_CSS}
		>
			<Board frames={FRAMES} css={ALL_SNAPPED} />
		</Proposal>
	),
}

export const B: Story = {
	name: 'B · znaky jako ikony, text na stupnici, kód relativně (doporučuji)',
	render: () => (
		<Proposal
			decision="D17"
			variant="B · znaky jako ikony, text na stupnici, kód relativně (doporučuji)"
			note="Znaky zůstanou na velikosti slotu ikony (§3.1: 14 v řádcích a menu, 16 v pásu; ● v docku = tečka 9). Text na stupnici: nadtitulek, dt a počet 11, název Run Context 13, dialog 17 (titulek sheetu §3.9), text editoru na čtecí krok 15 jako Document Review, PDF heslo 13. Kód v textu zůstane 0.92em jako zapsaný relativní krok."
			facts={[
				'znaky beze změny',
				'Run Context: 10 → 11, název 14 → 13, text 14 → 15, dialog 15 → 17',
				'PDF heslo 14 → 13, počet ve skupině 10 → 11',
				'kód 0.92em beze změny',
			]}
			css={BOARD_CSS}
		>
			<Board frames={FRAMES} css={TEXT_ONLY} />
		</Proposal>
	),
}

export const C: Story = {
	name: 'C · vše zapsat jako kroky komponent a povrchů',
	render: () => (
		<Proposal
			decision="D17"
			variant="C · vše zapsat jako kroky komponent a povrchů"
			note="Vypadá stejně jako Current, jen pravidlo: Run Context dostane vlastní krok povrchu 10 / 14 / 15 (jako Review 15 / 21 / 28), znaky a počet 10 jako rozměry komponent, 0.92em jako relativní krok kódu."
			facts={['žádný pixel se nemění', 'v aplikaci přibude povrch s 10 px písmem (D8 krok 10 pro odznaky zamítl)']}
			css={BOARD_CSS}
		>
			<Board frames={FRAMES} css="" />
		</Proposal>
	),
}
